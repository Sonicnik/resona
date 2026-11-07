import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db/database.ts";
import type { ContentIndex } from "../search/index.ts";
import { centroid } from "../search/embeddings.ts";
import { badRequest, conflict, newId, notFound, nowIso, parseJson } from "../lib/util.ts";
import type { ProjectProfile } from "../matching/matcher.ts";
import { DEFAULT_EXCLUSIONS } from "../ingestion/exclusions.ts";

export interface ProjectRow {
  id: string;
  name: string;
  kind: string;
  folder_path: string;
  folder_bookmark: string | null;
  status: string;
  ai_permission: string;
  exclusions: string;
  last_scan_at: string | null;
  last_change_at: string | null;
  last_summarized_at: string | null;
  created_at: string;
  updated_at: string;
}

export function projectToJson(row: ProjectRow) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    folderPath: row.folder_path,
    folderBookmark: row.folder_bookmark,
    status: row.status,
    aiPermission: row.ai_permission,
    exclusions: parseJson<string[]>(row.exclusions, []),
    lastScanAt: row.last_scan_at,
    lastChangeAt: row.last_change_at,
    lastSummarizedAt: row.last_summarized_at,
    needsSummary: Boolean(row.last_change_at && (!row.last_summarized_at || row.last_change_at > row.last_summarized_at)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function contextToJson(row: Record<string, unknown> | undefined) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    version: row.version,
    method: row.method,
    model: row.model,
    summary: row.summary,
    problem: row.problem,
    audience: row.audience,
    built: row.built,
    contribution: row.contribution,
    results: parseJson(row.results, []),
    capabilities: parseJson(row.capabilities, []),
    limitations: parseJson(row.limitations, []),
    keywords: parseJson(row.keywords, []),
    searchPhrases: parseJson(row.search_phrases, []),
    evidence: parseJson(row.evidence, []),
    uncertainties: parseJson(row.uncertainties, []),
    shareableMaterial: parseJson(row.shareable_material, []),
    createdAt: row.created_at,
  };
}

export class ProjectService {
  constructor(
    private readonly db: Db,
    private readonly index: ContentIndex,
  ) {}

  create(input: { folderPath: string; name?: string; kind?: "project" | "cv"; aiPermission?: "allowed" | "denied"; exclusions?: string[]; folderBookmark?: string }): ProjectRow {
    const folder = path.resolve(input.folderPath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(folder);
    } catch {
      throw badRequest(`folder does not exist or is not readable: ${folder}`);
    }
    if (!stat.isDirectory()) throw badRequest(`not a folder: ${folder}`);
    const existing = this.db.get<{ id: string }>("SELECT id FROM projects WHERE folder_path = ?", [folder]);
    if (existing) throw conflict("this folder has already been added", { projectId: existing.id });
    const id = newId("prj");
    const now = nowIso();
    this.db.run(
      `INSERT INTO projects (id, name, kind, folder_path, folder_bookmark, ai_permission, exclusions, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, input.name?.trim() || path.basename(folder), input.kind ?? "project", folder, input.folderBookmark,
        input.aiPermission ?? "denied", input.exclusions ?? [], now, now,
      ],
    );
    return this.get(id);
  }

  get(id: string): ProjectRow {
    const row = this.db.get<ProjectRow>("SELECT * FROM projects WHERE id = ?", [id]);
    if (!row) throw notFound("project");
    return row;
  }

  list(opts: { kind?: string } = {}): ProjectRow[] {
    return this.db.all<ProjectRow>(
      "SELECT * FROM projects WHERE (? IS NULL OR kind = ?) ORDER BY created_at",
      [opts.kind ?? null, opts.kind ?? null],
    );
  }

  update(id: string, patch: { name?: string; status?: string; aiPermission?: string; exclusions?: string[]; folderBookmark?: string }): ProjectRow {
    this.get(id);
    this.db.run(
      `UPDATE projects SET name = COALESCE(?, name), status = COALESCE(?, status), ai_permission = COALESCE(?, ai_permission),
         exclusions = COALESCE(?, exclusions), folder_bookmark = COALESCE(?, folder_bookmark), updated_at = ? WHERE id = ?`,
      [patch.name, patch.status, patch.aiPermission, patch.exclusions, patch.folderBookmark, nowIso(), id],
    );
    if (patch.exclusions) {
      // Force a full re-evaluation: newly excluded files will be marked deleted on the next scan.
      this.db.run("UPDATE project_files SET mtime_ms = -1 WHERE project_id = ?", [id]);
    }
    return this.get(id);
  }

  delete(id: string): void {
    this.get(id);
    this.db.tx(() => {
      this.db.run("DELETE FROM content_chunks WHERE project_id = ?", [id]);
      this.db.run("DELETE FROM projects WHERE id = ?", [id]);
    });
  }

  files(id: string, state?: string) {
    return this.db.all(
      `SELECT id, rel_path, size, file_kind, processing_state, skip_reason, error, changed_at FROM project_files
       WHERE project_id = ? AND (? IS NULL OR processing_state = ?) ORDER BY rel_path`,
      [id, state ?? null, state ?? null],
    );
  }

  fileStats(id: string) {
    return this.db.all<{ processing_state: string; n: number }>(
      "SELECT processing_state, COUNT(*) AS n FROM project_files WHERE project_id = ? GROUP BY processing_state",
      [id],
    );
  }

  runs(id: string, limit = 20) {
    return this.db.all("SELECT * FROM ingestion_runs WHERE project_id = ? ORDER BY started_at DESC LIMIT ?", [id, limit]);
  }

  latestContext(id: string): Record<string, unknown> | undefined {
    return this.db.get("SELECT * FROM project_contexts WHERE project_id = ? ORDER BY version DESC LIMIT 1", [id]);
  }

  contextHistory(id: string) {
    return this.db.all("SELECT * FROM project_contexts WHERE project_id = ? ORDER BY version DESC", [id]);
  }

  questions(id: string, status?: string) {
    return this.db.all(
      "SELECT * FROM clarification_questions WHERE project_id = ? AND (? IS NULL OR status = ?) ORDER BY created_at",
      [id, status ?? null, status ?? null],
    );
  }

  answerQuestion(questionId: string, answer: string | null, dismiss = false): void {
    const res = this.db.run(
      "UPDATE clarification_questions SET status = ?, answer = ?, answered_at = ? WHERE id = ?",
      [dismiss ? "dismissed" : "answered", answer, nowIso(), questionId],
    );
    if (res.changes === 0) throw notFound("question");
  }

  /** Builds the matching profile (keywords, limitations, vector) from the latest context. */
  profile(id: string): ProjectProfile | null {
    const project = this.get(id);
    const ctx = this.latestContext(id);
    if (!ctx) return null;
    const vectors = this.index.sourceVectors("project_context", [id]);
    return {
      projectId: id,
      contextId: String(ctx.id),
      name: project.name,
      problem: String(ctx.problem ?? ""),
      keywords: parseJson<string[]>(ctx.keywords, []),
      phrases: parseJson<string[]>(ctx.search_phrases, []),
      capabilities: parseJson<string[]>(ctx.capabilities, []),
      limitations: parseJson<string[]>(ctx.limitations, []),
      vector: centroid(vectors),
    };
  }

  static defaultExclusions() {
    return DEFAULT_EXCLUSIONS;
  }
}
