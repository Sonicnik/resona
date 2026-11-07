import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db/database.ts";
import type { ContentIndex } from "../search/index.ts";
import { newId, nowIso, parseJson, sha256 } from "../lib/util.ts";
import { ALL_DEFAULT_EXCLUSIONS, ExclusionMatcher, parseGitignore } from "./exclusions.ts";
import { classify, extractText } from "./extract.ts";

export const MAX_FILES_PER_PROJECT = 20_000;

export interface ScanResult {
  runId: string;
  projectId: string;
  filesSeen: number;
  filesChanged: number;
  filesDeleted: number;
  filesSkipped: number;
  changedPaths: string[];
  status: "ok" | "error";
  error?: string;
}

interface WalkEntry {
  relPath: string;
  absPath: string;
  size: number;
  mtimeMs: number;
}

interface Skipped {
  relPath: string;
  reason: string;
}

function walk(root: string, matcher: ExclusionMatcher, skipped: Skipped[]): WalkEntry[] {
  const out: WalkEntry[] = [];
  const stack: string[] = [""];
  while (stack.length) {
    const rel = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue; // never follow links out of the user-selected folder
      const isDir = entry.isDirectory();
      if (matcher.match(childRel, isDir)) continue; // excluded files are not recorded at all
      if (isDir) {
        stack.push(childRel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (out.length >= MAX_FILES_PER_PROJECT) {
        skipped.push({ relPath: childRel, reason: `project file limit (${MAX_FILES_PER_PROJECT}) reached` });
        continue;
      }
      try {
        const st = fs.statSync(path.join(root, childRel));
        out.push({ relPath: childRel, absPath: path.join(root, childRel), size: st.size, mtimeMs: Math.floor(st.mtimeMs) });
      } catch {
        /* vanished between readdir and stat */
      }
    }
  }
  return out;
}

export function matcherForProject(folder: string, userExclusions: string[]): ExclusionMatcher {
  let gitignore: string[] = [];
  try {
    gitignore = parseGitignore(fs.readFileSync(path.join(folder, ".gitignore"), "utf8"));
  } catch {
    /* no .gitignore */
  }
  return new ExclusionMatcher([...ALL_DEFAULT_EXCLUSIONS, ...gitignore, ...userExclusions]);
}

type FileRow = { id: string; rel_path: string; hash: string | null; size: number; mtime_ms: number; processing_state: string };

/**
 * Incremental folder scan:
 *  1. walk the folder honoring default, .gitignore and per-folder exclusions;
 *  2. skip unchanged files by (size, mtime), then confirm changes by content hash;
 *  3. extract text, refuse files that look like credentials, and (re)index chunks;
 *  4. mark files that disappeared as deleted and drop their chunks.
 * A change is a signal to re-investigate the project, not proof that anything improved.
 */
export function scanProject(db: Db, index: ContentIndex, projectId: string, trigger: string): ScanResult {
  const project = db.get<{ folder_path: string; exclusions: string }>(
    "SELECT folder_path, exclusions FROM projects WHERE id = ?",
    [projectId],
  );
  if (!project) throw new Error(`project ${projectId} not found`);
  const runId = newId("run");
  const startedAt = nowIso();
  db.run("INSERT INTO ingestion_runs (id, project_id, trigger, started_at) VALUES (?, ?, ?, ?)", [
    runId,
    projectId,
    trigger,
    startedAt,
  ]);

  const result: ScanResult = {
    runId,
    projectId,
    filesSeen: 0,
    filesChanged: 0,
    filesDeleted: 0,
    filesSkipped: 0,
    changedPaths: [],
    status: "ok",
  };

  try {
    if (!fs.existsSync(project.folder_path) || !fs.statSync(project.folder_path).isDirectory()) {
      throw new Error(`folder is not accessible: ${project.folder_path}`);
    }
    const matcher = matcherForProject(project.folder_path, parseJson<string[]>(project.exclusions, []));
    const skipped: Skipped[] = [];
    const files = walk(project.folder_path, matcher, skipped);
    result.filesSeen = files.length;

    const existing = new Map(
      db
        .all<FileRow>(
          "SELECT id, rel_path, hash, size, mtime_ms, processing_state FROM project_files WHERE project_id = ?",
          [projectId],
        )
        .map((r) => [r.rel_path, r]),
    );
    const seen = new Set<string>();
    const now = nowIso();

    for (const file of files) {
      seen.add(file.relPath);
      const prev = existing.get(file.relPath);
      if (prev && prev.processing_state !== "deleted" && prev.size === file.size && prev.mtime_ms === file.mtimeMs) {
        if (prev.processing_state === "skipped") result.filesSkipped++;
        continue;
      }
      const cls = classify(file.relPath, file.size);
      if (!cls.supported) {
        upsertFile(db, projectId, file, prev, { state: "skipped", reason: cls.reason, now });
        result.filesSkipped++;
        continue;
      }
      let buf: Buffer;
      try {
        buf = fs.readFileSync(file.absPath);
      } catch (err) {
        upsertFile(db, projectId, file, prev, { state: "error", error: String(err), now });
        continue;
      }
      const hash = sha256(buf);
      if (prev && prev.hash === hash && prev.processing_state === "indexed") {
        // Touched but unchanged content: refresh mtime only.
        db.run("UPDATE project_files SET mtime_ms = ?, size = ? WHERE id = ?", [file.mtimeMs, file.size, prev.id]);
        continue;
      }
      const extraction = extractText(buf, cls.kind);
      if (!extraction.ok) {
        const fileId = upsertFile(db, projectId, file, prev, { state: "skipped", reason: extraction.reason, hash, now });
        index.removeSource("project_file", fileId);
        result.filesSkipped++;
        continue;
      }
      db.tx(() => {
        const fileId = upsertFile(db, projectId, file, prev, {
          state: "indexed",
          hash,
          kind: cls.kind,
          text: extraction.text,
          now,
          reason: extraction.truncated ? "truncated to 1MB" : null,
        });
        index.indexSource("project_file", fileId, `${file.relPath}\n\n${extraction.text}`, projectId);
      });
      result.filesChanged++;
      result.changedPaths.push(file.relPath);
    }

    for (const [relPath, row] of existing) {
      if (seen.has(relPath) || row.processing_state === "deleted") continue;
      db.tx(() => {
        db.run(
          "UPDATE project_files SET processing_state = 'deleted', extracted_text = NULL, changed_at = ? WHERE id = ?",
          [now, row.id],
        );
        index.removeSource("project_file", row.id);
      });
      result.filesDeleted++;
      result.changedPaths.push(relPath);
    }

    const changed = result.filesChanged + result.filesDeleted > 0;
    db.run(
      `UPDATE projects SET last_scan_at = ?, last_change_at = CASE WHEN ? THEN ? ELSE last_change_at END, updated_at = ? WHERE id = ?`,
      [now, changed ? 1 : 0, now, now, projectId],
    );
  } catch (err) {
    result.status = "error";
    result.error = err instanceof Error ? err.message : String(err);
  }

  db.run(
    `UPDATE ingestion_runs SET finished_at = ?, files_seen = ?, files_changed = ?, files_deleted = ?, files_skipped = ?, status = ?, error = ?
     WHERE id = ?`,
    [nowIso(), result.filesSeen, result.filesChanged, result.filesDeleted, result.filesSkipped, result.status, result.error ?? null, runId],
  );
  return result;
}

function upsertFile(
  db: Db,
  projectId: string,
  file: WalkEntry,
  prev: FileRow | undefined,
  data: { state: string; now: string; hash?: string; kind?: string; text?: string; reason?: string | null; error?: string },
): string {
  const id = prev?.id ?? newId("file");
  db.run(
    `INSERT INTO project_files (id, project_id, rel_path, hash, size, mtime_ms, file_kind, extracted_text, processing_state, skip_reason, error, first_seen_at, changed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, rel_path) DO UPDATE SET
       hash = excluded.hash, size = excluded.size, mtime_ms = excluded.mtime_ms, file_kind = excluded.file_kind,
       extracted_text = excluded.extracted_text, processing_state = excluded.processing_state,
       skip_reason = excluded.skip_reason, error = excluded.error, changed_at = excluded.changed_at`,
    [
      id,
      projectId,
      file.relPath,
      data.hash ?? null,
      file.size,
      file.mtimeMs,
      data.kind ?? null,
      data.text ?? null,
      data.state,
      data.reason ?? null,
      data.error ?? null,
      data.now,
      data.now,
    ],
  );
  return id;
}
