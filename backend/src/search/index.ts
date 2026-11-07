import type { Db } from "../db/database.ts";
import { sha256, nowIso } from "../lib/util.ts";
import { tokenize } from "../lib/text.ts";
import { chunkText } from "../ingestion/chunker.ts";
import { cosine, fromBlob, toBlob, type Embedder } from "./embeddings.ts";

export type ChunkSource = "project_file" | "source_post" | "interaction" | "project_context";

export interface SearchHit {
  chunkId: number;
  sourceType: ChunkSource;
  sourceId: string;
  projectId: string | null;
  text: string;
  startLine: number | null;
  endLine: number | null;
  score: number;
  keywordScore: number;
  semanticScore: number;
}

/** Content index: chunks + FTS5 + vectors, shared by project files, posts and interactions. */
export class ContentIndex {
  constructor(
    private readonly db: Db,
    readonly embedder: Embedder,
  ) {}

  /** Replaces all chunks for a source. Returns the number of chunks written. */
  indexSource(sourceType: ChunkSource, sourceId: string, text: string, projectId: string | null = null): number {
    return this.db.tx(() => {
      this.removeSource(sourceType, sourceId);
      const chunks = chunkText(text);
      const now = nowIso();
      for (const chunk of chunks) {
        const { lastInsertRowid } = this.db.run(
          `INSERT INTO content_chunks (source_type, source_id, project_id, ord, text, content_hash, start_line, end_line, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [sourceType, sourceId, projectId, chunk.ord, chunk.text, sha256(chunk.text), chunk.startLine, chunk.endLine, now],
        );
        const vec = this.embedder.embed(chunk.text);
        this.db.run("INSERT INTO embeddings (chunk_id, model, dims, vector) VALUES (?, ?, ?, ?)", [
          lastInsertRowid,
          this.embedder.model,
          this.embedder.dims,
          toBlob(vec),
        ]);
      }
      return chunks.length;
    });
  }

  removeSource(sourceType: ChunkSource, sourceId: string): void {
    this.db.run("DELETE FROM content_chunks WHERE source_type = ? AND source_id = ?", [sourceType, sourceId]);
  }

  /** Builds a safe FTS5 query (OR of quoted terms) from free text. */
  static ftsQuery(text: string): string | null {
    const terms = [...new Set(tokenize(text))].slice(0, 24);
    if (terms.length === 0) return null;
    return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
  }

  /**
   * Hybrid search: BM25 over FTS5 for exact terms, cosine over stored vectors for wording
   * variation, merged with a weighted sum after per-signal normalization.
   */
  search(
    query: string,
    opts: { sourceTypes?: ChunkSource[]; projectIds?: string[]; limit?: number; semanticWeight?: number } = {},
  ): SearchHit[] {
    const limit = opts.limit ?? 20;
    const semanticWeight = opts.semanticWeight ?? 0.5;
    const filters: string[] = [];
    const params: unknown[] = [];
    if (opts.sourceTypes?.length) {
      filters.push(`c.source_type IN (${opts.sourceTypes.map(() => "?").join(",")})`);
      params.push(...opts.sourceTypes);
    }
    if (opts.projectIds?.length) {
      filters.push(`c.project_id IN (${opts.projectIds.map(() => "?").join(",")})`);
      params.push(...opts.projectIds);
    }
    const where = filters.length ? `AND ${filters.join(" AND ")}` : "";

    type ChunkRow = {
      id: number;
      source_type: ChunkSource;
      source_id: string;
      project_id: string | null;
      text: string;
      start_line: number | null;
      end_line: number | null;
    };
    const candidates = new Map<number, ChunkRow & { bm25?: number }>();

    const fts = ContentIndex.ftsQuery(query);
    if (fts) {
      const rows = this.db.all<ChunkRow & { rank: number }>(
        `SELECT c.id, c.source_type, c.source_id, c.project_id, c.text, c.start_line, c.end_line, bm25(chunks_fts) AS rank
         FROM chunks_fts JOIN content_chunks c ON c.id = chunks_fts.rowid
         WHERE chunks_fts MATCH ? ${where}
         ORDER BY rank LIMIT ?`,
        [fts, ...params, limit * 5],
      );
      for (const r of rows) candidates.set(r.id, { ...r, bm25: -r.rank });
    }

    // Semantic candidates: brute-force cosine is fine for a single user's corpus (tens of thousands of chunks).
    const qv = this.embedder.embed(query);
    const vecRows = this.db.all<ChunkRow & { vector: Uint8Array; model: string }>(
      `SELECT c.id, c.source_type, c.source_id, c.project_id, c.text, c.start_line, c.end_line, e.vector, e.model
       FROM embeddings e JOIN content_chunks c ON c.id = e.chunk_id
       WHERE e.model = ? ${where}`,
      [this.embedder.model, ...params],
    );
    const sem = new Map<number, number>();
    for (const r of vecRows) {
      const s = cosine(qv, fromBlob(r.vector));
      sem.set(r.id, s);
      if (!candidates.has(r.id) && s > 0.15) candidates.set(r.id, r);
    }

    const maxBm25 = Math.max(1e-9, ...[...candidates.values()].map((c) => c.bm25 ?? 0));
    const hits: SearchHit[] = [...candidates.values()].map((c) => {
      const keywordScore = (c.bm25 ?? 0) / maxBm25;
      const semanticScore = Math.max(0, sem.get(c.id) ?? 0);
      return {
        chunkId: c.id,
        sourceType: c.source_type,
        sourceId: c.source_id,
        projectId: c.project_id,
        text: c.text,
        startLine: c.start_line,
        endLine: c.end_line,
        keywordScore,
        semanticScore,
        score: (1 - semanticWeight) * keywordScore + semanticWeight * semanticScore,
      };
    });
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  /** Average vector of all chunks of a source, used for project/person interest profiles. */
  sourceVectors(sourceType: ChunkSource, sourceIds: string[]): Float32Array[] {
    if (sourceIds.length === 0) return [];
    const rows = this.db.all<{ vector: Uint8Array }>(
      `SELECT e.vector FROM embeddings e JOIN content_chunks c ON c.id = e.chunk_id
       WHERE e.model = ? AND c.source_type = ? AND c.source_id IN (${sourceIds.map(() => "?").join(",")})`,
      [this.embedder.model, sourceType, ...sourceIds],
    );
    return rows.map((r) => fromBlob(r.vector));
  }
}
