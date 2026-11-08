# Progress and handoff (read this first)

**Last updated:** 2026-11-07, by the assistant, after the network framing and layout update.
**Purpose:** everything needed to continue this project without the chat history.

## Do this first (2 minutes)

1. `cd` to the repo root (the worktree below) and run `git status -sb`. Expect `feature/backend-frontend-integration`, clean.
2. Run `./start.sh`. It opens http://localhost:1420 with demo data.
3. Read **"Open items"** below and pick the top one.

## Where things stand

- **Working prototype.** The glass "star map" UI (`app/`) runs on the local backend (`backend/`) with live data. All 35 backend tests pass.
- **On GitHub (`main`):** PR #2 (prototype, Claude/ChatGPT connect, scan, start.sh) and PR #3 (opportunity summaries) are merged.
- **Pushed but not in `main` yet** (branch `feature/backend-frontend-integration`, 4 commits, **no PR**):
  1. `29c8fff` "Open on <platform>" buttons on opportunities and the person panel
  2. `f7cad02` full-screen "Scanning in progress" overlay
  3. `0fb2fa6` overlay restyled as next-gen glass
  4. `c4667ab` Posts tab: layout fix, edit title and text, Write My Own
  5. network view: connection-level filter, names near cursor only, Reset view
  6. network: choosing a level frames that level; no star dust; clustered, non-spherical layout
- The user said **"don't create PR yet"** for these. Open one only when asked.

## Run, test, reset

| Task | Command (from repo root) |
| --- | --- |
| Start everything (demo data) | `./start.sh` (re-running it restarts cleanly; Ctrl+C stops all) |
| Start on real data | `./start.sh --real` |
| Backend tests (35) | `cd backend && npm test` |
| Typecheck | `cd backend && npx tsc --noEmit` and `cd app && npx tsc --noEmit` |
| Build the app | `cd app && npm run build` |
| Reset demo data | stop the app, delete `~/.resona-demo`, run `./start.sh` |

- Ports: backend `127.0.0.1:4317`, app (Vite) `localhost:1420`, ChatGPT sign-in callback `127.0.0.1:1455`.
- Vite proxies `/api` to the backend; set `RESONA_PORT` to point it elsewhere.
- Backend changes need a restart (`./start.sh`); UI changes hot-reload.

## Rules the user set (follow them)

1. **No Claude attribution anywhere on GitHub:** no `Co-Authored-By: Claude` trailer, no "Generated with Claude Code" in PRs, no `claude/` branch names. Use `feature/...` branches. (Also in memory: `no-claude-attribution`.)
2. **Never put API keys or tokens in the repo, `.env`, database or logs.** Keys live in the macOS Keychain (service `Resona`).
3. **Never enter credentials or sign in for the user.** Stop at the login page; the user signs in.
4. **Ask with multiple-choice questions** before big plans (the user likes the grilling style).
5. **Demo data has fake links on purpose** (Kai's X post, Sam/Jordan/Theo LinkedIn, Rina GitHub, demo profiles). The user said "leave it". Real scanned posts have real links.
6. Files are created only inside the opened folder (global CLAUDE.md rule).

## How to open a PR (no `gh` CLI here)

1. `git push` the branch.
2. Build a prefilled compare URL and run `open "<url>"`; the page opens in the user's browser:
   `https://github.com/Sonicnik/resona/compare/main...feature/backend-frontend-integration?expand=1&title=...&body=...`
3. The user clicks **Create pull request**, then **Merge**. The browser pane is not signed in to GitHub.

## How to test UI changes safely

- **Read-only checks** can use the user's running app at `localhost:1420`. Don't type into it; typing edits their drafts.
- **Interactive checks:** start an isolated copy:
  ```bash
  S=<scratchpad dir>
  cd backend && RESONA_PORT=4399 RESONA_DATA_DIR=$S/ov-data RESONA_SCHEDULER=0 RESONA_WATCH=0 RESONA_ALLOWED_ORIGINS=http://localhost:1499 node --import tsx src/index.ts &
  curl -XPATCH localhost:4399/api/settings -H 'Content-Type: application/json' -d '{"ai.disabled":true}'
  cd backend && RESONA_API=http://127.0.0.1:4399/api npm run seed
  cd app && RESONA_PORT=4399 npx vite --port 1499 --strictPort &
  ```
  Then open http://localhost:1499. Kill ports 4399/1499 and delete the data dir afterwards.
- **Always set `ai.disabled: true` in a copy.** A second backend reads the same Keychain ChatGPT tokens; refreshing them there rotates the refresh token and logs the user's real app out.

## Decisions made (grilling, 2026-11-07)

| Topic | Decision |
| --- | --- |
| Shell | Browser first (Vite + React in `app/`). Tauri scaffold kept for later; Rust not installed. |
| UI | `design/prototype.html` ported to React; CSS reused verbatim; 3D graph via `3d-force-graph` from npm. |
| Demo | `backend/scripts/seed.ts` fills `~/.resona-demo` through the real API. |
| Folder picking | Backend runs a native Finder dialog (`POST /system/choose`, osascript). |
| Sending | Draft → Approve exact revision → Copy & Open → Mark Sent. Never auto-send. Edits after approval need re-review. |
| Pause | Global `agent.paused` setting stops scheduler + watcher. |
| Claude | API key only (Anthropic forbids third-party Claude-account login). Connect opens platform.claude.com/settings/keys; key goes to Keychain. |
| ChatGPT | "Continue with ChatGPT" = OpenAI's plan-usage OAuth for local/open-source apps (preview, Plus/Pro). `ai.provider` setting picks Claude or ChatGPT. |
| Follow-ups | `POST /people/:id/drafts` drafts a follow-up to a known person. |
| Spotlight | People + screens + `/search` content hits. |
| Network view | Top bar filters by **group**: All, **Close** (tie strength ≥ 0.45, the only closeness group), then **industries** (Robotics, Finance, AI & ML, …; the 3 largest as buttons, the rest in a **More** menu outside the scrolling bar; "Other" = no clear industry). Industry is inferred in `backend/src/network/industries.ts` from title, organization, headline, bio, interests and posts; a person's panel has a **Group** picker that overrides it (`people.industry`, null = automatic). An emptied group falls back to All. Inside a group, people outside it are faint and **can't be hovered, clicked or right-clicked** (their objects are skipped by the mouse ray). Names show only near the cursor (70px) or when clicked, including "You". Camera never rotates on its own moves: clicking a person zooms straight in along the current angle; groups and **Reset view** (or R) zoom/pan only (`moveCamera` glides position and look-at together). Framing fits the area not covered by the sidebar, toolbar and bottom bars. The slow orbit pauses while a person is selected. Colours: **green = connected** (a relationship with you), **blue = interacted** (talked with you, no relationship), **gray = proposed**; only ties with *you* count. Hovering a legend item keeps that status lit and fades everyone else (you stay lit). Layout: connected people sit closer the stronger the tie; unconnected people cluster per project (`__anchor`). |

## What exists (map)

**Backend (`backend/src/`)**
- `ai/client.ts`: the single model gateway. Per-folder permission check, processing history, routes to Claude or ChatGPT by `ai.provider`.
- `ai/chatgpt.ts`: Sign in with ChatGPT (PKCE loopback, ID-token check via JWKS, Keychain tokens, refresh rotation, revoke, SSE Responses API).
- `system/mac.ts`: Keychain store (`security` CLI) and native Finder picker.
- `matching/situation.ts`: short "situation" summary for each opportunity (title plus best sentence, ≤180 chars).
- `api/routes.ts`: all endpoints. Full list in `backend/docs/api-reference.md`.
- Also: `services/` (projects, people, drafts, opportunities, discovery), `network/`, `vault/`, `scheduler/`.

**App (`app/src/`)**
- `App.tsx`: the shell (menu bar, sidebar, toolbar, history, Spotlight, menus, toast, shortcuts, scan action and overlay).
- `screens/`: Home, Opportunities (+ Follow-ups tab), Posts, Projects, Privacy (connect Claude/ChatGPT/GitHub/X, AI per folder, log).
- `Graph.tsx` (3D network), `Person.tsx` (inspector), `DraftEditor.tsx` (edit/approve/send with autosave), `api.ts` (fetch + hooks).

## Open items (ranked)

1. **Matcher is too loose (~1 hour).** A scan adds 100–200 weak opportunities: posts found by searching a project's own keywords always share those keywords. Tighten scoring in `backend/src/matching/matcher.ts`, e.g. require a real need (question/request scenario) or a higher threshold for connector results.
2. **Open a PR for the 4 unmerged commits (5 minutes)**, only when the user asks.
3. **Untested with a real account:** a Claude key, and a ChatGPT-plan draft (the user's ChatGPT sign-in works and did produce a real post draft). Structured output on ChatGPT is prompt-based JSON, so an occasional malformed reply shows "try again".
4. **Not built:** Tauri window (needs Rust), real publishing (manual by design), PDF/DOCX parsing, Phase 2 CVs, authorized LinkedIn search.
5. **Older Hacker News posts** in the demo DB keep old titles and run-together text until rescanned.

## Gotcha: the browser pane can't animate

The Browser pane runs pages with 0 animation frames per second (even when shown), so the 3D map doesn't move, tween or orbit there. To check network changes, measure with code: add a temporary `window.__dbgGraph = g` hook in `Graph.tsx`, project node positions, and remove the hook before committing. The graph uses `warmupTicks(120)`, so positions are settled at load.

## Environment facts

- Repo: `https://github.com/Sonicnik/resona` (owner Sonicnik). Main branch `main`.
- Worktree: `/Users/soni8nik/Personal/Programs/Competition/CubeBuildathon/.claude/worktrees/backend-frontend-integration-fec289`.
- The user runs `./start.sh` in the app's terminal tab. Their AI provider is the **ChatGPT plan** (`gpt-6.1-sol`).
- Node 25; backend uses built-in `node:sqlite`. No `gh` CLI. No Rust.
- Product intent and research: `docs/product-reference.md`. API: `backend/docs/api-reference.md`.

## Next action

Ask the user whether to start open item 1 (matcher tuning) or open the PR for the 4 unmerged commits.
