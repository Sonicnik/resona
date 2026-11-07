import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ExclusionMatcher, ALL_DEFAULT_EXCLUSIONS } from "../src/ingestion/exclusions.ts";
import { chunkText } from "../src/ingestion/chunker.ts";
import { detectSecret } from "../src/ingestion/extract.ts";
import { scanProject } from "../src/ingestion/scanner.ts";
import { makeServices, tmpDir, writeFiles, SAMPLE_PROJECT } from "./helpers.ts";

test("exclusion matcher: defaults, anchoring, directories and negation", () => {
  const m = new ExclusionMatcher([...ALL_DEFAULT_EXCLUSIONS, "docs/private/", "*.draft.md", "!keep.draft.md"]);
  assert.ok(m.match("node_modules/react/index.js", false));
  assert.ok(m.match("app/node_modules", true));
  assert.ok(m.match(".env", false));
  assert.ok(m.match("config/.env.production", false));
  assert.ok(m.match("keys/server.pem", false));
  assert.ok(m.match("docs/private/salary.md", false));
  assert.equal(m.match("other/docs/private/x.md", false), null, "anchored pattern only matches at root");
  assert.ok(m.match("notes/idea.draft.md", false));
  assert.equal(m.match("keep.draft.md", false), null);
  assert.equal(m.match("src/main.py", false), null);
  assert.equal(m.match("build.gradle", false), null, "dir-only `build/` must not match a file");
});

test("chunker keeps line ranges and splits long text", () => {
  const text = Array.from({ length: 200 }, (_, i) => `line ${i + 1} ${"word ".repeat(10)}`).join("\n");
  const chunks = chunkText(text, 500, 1000);
  assert.ok(chunks.length > 3);
  assert.equal(chunks[0]!.startLine, 1);
  for (let i = 1; i < chunks.length; i++) assert.ok(chunks[i]!.startLine > chunks[i - 1]!.startLine);
  assert.ok(chunks.every((c) => c.text.length <= 1100));
});

test("secret detection", () => {
  assert.equal(detectSecret("-----BEGIN RSA PRIVATE KEY-----\nabc"), "private key");
  assert.equal(detectSecret("token = ghp_abcdefghijklmnopqrstuvwxyz0123456789"), "GitHub token");
  assert.equal(detectSecret("just a normal file about keys and tokens"), null);
});

test("incremental scan: excludes, skips secrets, detects changes and deletions", () => {
  const s = makeServices();
  const folder = tmpDir("proj-");
  writeFiles(folder, {
    ...SAMPLE_PROJECT,
    "node_modules/x/index.js": "module.exports = 1",
    ".env": "SECRET=1",
    "src/settings.py": 'KEY = "AKIAABCDEFGHIJKLMNOP"',
    "logo.png": "\x89PNG",
    ".gitignore": "generated/\n",
    "generated/out.md": "generated",
  });
  const p = s.projects.create({ folderPath: folder });
  const first = scanProject(s.db, s.index, p.id, "initial");
  assert.equal(first.status, "ok");
  assert.deepEqual(first.changedPaths.sort(), ["README.md", "docs/notes.md", "src/metrics.py"]);
  const files = s.projects.files(p.id) as Array<{ rel_path: string; processing_state: string; skip_reason: string | null }>;
  const byPath = new Map(files.map((f) => [f.rel_path, f]));
  assert.ok(!byPath.has("node_modules/x/index.js"));
  assert.ok(!byPath.has(".env"));
  assert.ok(!byPath.has("generated/out.md"), ".gitignore is honored");
  assert.match(byPath.get("src/settings.py")!.skip_reason!, /credential/);
  assert.equal(byPath.get("logo.png")!.processing_state, "skipped");

  const second = scanProject(s.db, s.index, p.id, "manual");
  assert.equal(second.filesChanged, 0, "unchanged files are not reprocessed");

  fs.appendFileSync(path.join(folder, "docs/notes.md"), "\nNew finding: MRR improved.\n");
  fs.rmSync(path.join(folder, "src/metrics.py"));
  const third = scanProject(s.db, s.index, p.id, "manual");
  assert.equal(third.filesChanged, 1);
  assert.equal(third.filesDeleted, 1);
  const hits = s.index.search("recall_at_k retrieved relevant", { sourceTypes: ["project_file"] });
  assert.ok(!hits.some((h) => h.text.includes("def recall_at_k")), "deleted file is removed from the index");
  s.close();
});

test("missing folder produces an error run instead of throwing", () => {
  const s = makeServices();
  const folder = tmpDir("gone-");
  const p = s.projects.create({ folderPath: folder });
  fs.rmSync(folder, { recursive: true });
  const res = scanProject(s.db, s.index, p.id, "manual");
  assert.equal(res.status, "error");
  assert.match(res.error!, /not accessible/);
  s.close();
});
