# Resona backend

Local-first backend for the networking and professional-presence agent described in [`docs/product-reference.md`](../docs/product-reference.md). It runs on the user's Mac and stores everything in a local SQLite database plus an Obsidian-compatible Markdown vault. It calls the Claude API only for folders where the user has granted AI processing.

- **Language/runtime:** TypeScript on Node.js ≥ 22.13 (the Mac app's React UI talks to it over a local HTTP API).
- **Dependencies:** `express`, `zod` and `@anthropic-ai/sdk`. Storage uses the built-in `node:sqlite` with FTS5, so no native modules are needed.
- **API reference:** [`docs/api-reference.md`](docs/api-reference.md)

## Run

```bash
cd backend
npm install
npm start          # http://127.0.0.1:4317/api
npm test           # 23 tests: ingestion, matching, approvals, network, vault, imports, scheduler, HTTP API
npm run typecheck
```

Configuration is through environment variables; see [`.env.example`](.env.example). Without `ANTHROPIC_API_KEY` the backend runs fully offline, with extractive summaries and template drafts.

```bash
curl -s localhost:4317/api/projects -H 'Content-Type: application/json' \
  -d '{"folderPath":"/Users/me/code/my-project","aiPermission":"allowed"}'
```

## How it maps to the product

| Product requirement | Implementation |
| --- | --- |
| Add multiple project folders, analyze changes automatically | `projects`, incremental `scanProject` (size/mtime → SHA-256), `FolderWatcher` (FSEvents via `fs.watch`), 30-minute rescan job |
| Permission per folder, exclusions, processing history | `projects.ai_permission` (default **denied**), default and per-folder exclusions plus `.gitignore`, credential detection, `ai_requests` log of every model request with file and line references |
| Step 1: summarize project context, ask about unclear facts | `ProjectSummarizer`: Claude structured output (`claude-opus-5-5`, Zod schema, server-side refusal fallback) or the offline extractive fallback; versioned `project_contexts`; `clarification_questions` whose answers feed the next version |
| Step 2: find relevant conversations | `DiscoveryService` with read-only connectors (GitHub, Hacker News, X; LinkedIn shown but disabled until access is authorized), plus manual post entry |
| Step 3: ranked shortlist with evidence and an editable draft | `matching/` scenario classifier (the 12 scenarios in §4), hybrid scoring, duplicate-contact checks, AI or template drafts |
| Step 4: user chooses, progress recorded | Draft revisions and an approval state machine bound to an exact revision and destination; `mark-sent` / `reconcile`. Nothing is ever sent automatically |
| Standalone LinkedIn/X posts | `POST /projects/:id/post-drafts`; the model may decline when nothing is worth posting |
| People-only network, explained links | `NetworkService`: relationship, interaction and proposed edges, a separate interest layer, tie strength, PageRank, communities, bridges, warm-intro paths, recommendations |
| LinkedIn archive fallback | `POST /imports/linkedin-archive` (Connections.csv and messages.csv, idempotent) |
| Weekly review, pause and catch up | `Scheduler` keeps run times in SQLite; after sleep or a restart each overdue job runs once |
| Local storage "like Obsidian" | `VaultService`: Markdown + YAML frontmatter + `[[wikilinks]]`, generated blocks between markers, two-way sync of person notes, rename tracking |

## Layout

```
src/
  index.ts              server entry point
  container.ts          wiring, ingestion pipeline, scheduled jobs
  config.ts             environment configuration
  api/                  Express app, routes, validation, error mapping, local-only guard
  db/                   node:sqlite wrapper and schema migrations
  ingestion/            exclusions, text extraction, chunking, incremental scanner, folder watcher
  search/               local hashing embedder, FTS5 + vector hybrid index
  ai/                   Claude gateway (permission + history), summarizer, drafting
  matching/             scenario detection and opportunity scoring
  network/              graph algorithms and the people network service
  services/             projects, people/identity, relationships, opportunities, drafts, discovery, imports, reviews
  connectors/           GitHub, Hacker News, X, LinkedIn (disabled)
  vault/                Markdown/frontmatter helpers and the vault sync
  scheduler/            persisted background job scheduler
test/                   node:test suites
```

## Design notes and deliberate limits

- **Choices the product reference leaves open.** Outreach drafts and post drafts share generalized `drafts` / `draft_revisions` / `draft_actions` tables (`kind` = outreach | post). The default embedding is a local feature-hashing model (`resona-hash-v1-512`); the model ID is stored with every vector so a neural embedder can replace it and re-index. Automatic daily discovery is **off by default** because it sends project keywords to third-party search APIs.
- **What is not built.** There are no PDF/DOCX parsers yet; those files are skipped with a reason. No publishing integrations exist (`queued` is reserved for them), so sending is the user's copy-and-send followed by `mark-sent`. Phase 2 (master career record and CVs) is only prepared for: projects accept `kind: "cv"`.
- **Credentials** (API keys, connector tokens) come from the environment and are never stored in the database or vault. Keychain storage belongs to the Mac app.
- **Security.** The server binds to 127.0.0.1, rejects non-loopback `Host` headers (DNS rebinding) and unknown browser origins, and can require a bearer token (`RESONA_API_TOKEN`).
- **Model use.** It defaults to `claude-opus-5-5` at `medium` effort with the server-side refusal fallback (`fallbacks: "default"`). Use `RESONA_MODEL` and `RESONA_AI_EFFORT` to change this.
