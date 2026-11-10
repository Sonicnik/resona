# Progress and handoff (read this first)

**Last updated:** 2026-11-09, by the assistant, after building the Mac app (steps 1–7 of `docs/MAC_APP_PLAN.md`).
**Purpose:** everything needed to continue this project without the chat history.

## Do this first (2 minutes)

1. `cd` to the repo root (the worktree below) and run `git status -sb`. Expect `feature/mac-app`, clean (local only, not pushed).
2. Run `./start.sh`. It opens http://localhost:1420 with demo data.
3. Read **"Open items"** below and pick the top one.

## Where things stand

- **Working prototype, now also a Mac app.** The glass "star map" UI (`app/`) runs on the local backend (`backend/`) in the browser (`./start.sh`) or as **Resona.app** (`desktop/`, Electron). 36 backend tests + 1 desktop test pass.
- **On GitHub (`main`):** PRs #2, #3 and #4 are merged (prototype, opportunity summaries, the network/posts work).
- **Local only (branch `feature/mac-app`, not pushed, no PR):** the Mac app (one commit). Push or open a PR only when the user asks.

## Run, test, reset

| Task | Command (from repo root) |
| --- | --- |
| Start everything (demo data) | `./start.sh` (re-running it restarts cleanly; Ctrl+C stops all) |
| Start on real data | `./start.sh --real` |
| Backend tests (36) | `cd backend && npm test` |
| Typecheck | `cd backend && npx tsc --noEmit` and `cd app && npx tsc --noEmit` |
| Build the app | `cd app && npm run build` |
| Run the Mac app (dev) | `cd desktop && npm install && npm start` (builds UI + bundles, uses real data on port 4317; stop `./start.sh` first, or set `RESONA_PORT` and `RESONA_DATA_DIR` for a test copy) |
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
| Shell | Browser for development (Vite + React in `app/`); Mac app is Electron in `desktop/` (2026-11-08, replaced the unused Tauri scaffold). |
| Mac distribution | Unsigned (ad-hoc) DMG on GitHub Releases for the user and friends; no Apple Developer account, no notarization. Friends use Open Anyway once. Updates: notice + download link, not self-install (needs Developer ID). |
| UI | `design/prototype.html` ported to React; CSS reused verbatim; 3D graph via `3d-force-graph` from npm. |
| Demo | `backend/scripts/seed.ts` fills `~/.resona-demo` through the real API. |
| Folder picking | Backend runs a native Finder dialog (`POST /system/choose`, osascript). |
| Sending | Draft → Approve exact revision → Copy & Open → Mark Sent. Never auto-send. Edits after approval need re-review. |
| Pause | Global `agent.paused` setting stops scheduler + watcher. |
| Claude | API key only (Anthropic forbids third-party Claude-account login). Connect opens platform.claude.com/settings/keys; key goes to Keychain. |
| ChatGPT | "Continue with ChatGPT" = OpenAI's plan-usage OAuth for local/open-source apps (preview, Plus/Pro). `ai.provider` setting picks Claude or ChatGPT. |
| Follow-ups | `POST /people/:id/drafts` drafts a follow-up to a known person. |
| Spotlight | People + screens + `/search` content hits. |
| Network view | Top bar filters by connection level (tie strength): All, Connected, Inner circle ≥0.65, Close ≥0.45, Familiar ≥0.30, Acquainted ≥0.20, Light >0. Unconnected people only in All. Names show only near the cursor (70px) or when clicked, including "You". **Reset view** (or R) zooms to fit 95% of people and stops orbiting for the session. Choosing a level frames just that level plus you (`fitTo` in `Graph.tsx`: thinnest-axis angle, perspective fit, min distance 90, centred in the area not covered by the sidebar). Layout: connected people sit closer the stronger the tie; unconnected people cluster per project (`__anchor`); no decorative star dust. |

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
2. **Push `feature/mac-app` and open a PR**, only when the user asks. Then publish the first release (`desktop/README.md` → Release) so friends can download it.
3. **Untested with a real account:** a Claude key, and a ChatGPT-plan draft (the user's ChatGPT sign-in works and did produce a real post draft). Structured output on ChatGPT is prompt-based JSON, so an occasional malformed reply shows "try again".
4. **Mac app (planned 2026-11-08; steps 1–6 of 7 done, uncommitted):** `docs/MAC_APP_PLAN.md`.
   - Step 1: `RESONA_STATIC_DIR` makes the backend serve `app/dist`; `desktop/build.mjs` bundles the backend to `desktop/build/backend.mjs` (runs on plain `node`, no tsx).
   - Step 2: Electron 45 shell in `desktop/src/main.ts` + `preload.ts`. Runs the backend in a utility process on port 4317 with a per-launch API token (Electron adds the header; `curl` gets 401), loads the UI from it, opens links in the default browser, remembers window size, crash dialog with Restart, clean shutdown on quit. Chromium files live in `<data dir>/Electron`. Electron's Node 24 has `node:sqlite`.
   - Step 3: inside the app (`html.desktop`, set in `app/src/main.tsx` when `window.resona` exists) the drawn menu bar, clock, window frame and traffic lights are hidden; native traffic lights sit where the drawn ones were; toolbar is the drag area. Native menus (`buildMenu` in `desktop/src/main.ts`) send ids to `onNativeMenu` in `App.tsx`; their shortcuts are display-only (`registerAccelerator: false`) so the UI's keydown handler keeps them. Edit/Window/Quit use Electron roles (needed for ⌘C/⌘V). UI renamed "Networking Agent" → **Resona** (the user confirmed the name). Toolbar title no longer overlaps the filter chips; chips scroll sideways when they don't fit.
   - Step 4: menu bar icon (`desktop/assets/trayTemplate*.png`, dot + two rings, template image) with status, Open, Review N Opportunities, Scan Now (runs the UI's scan with its overlay), Pause/Resume, Open at Login, Quit. Closing the window (red button or ⌘W) only hides it; the agent keeps running; Dock click reopens; ⌘Q or the menu bar Quit really quits. Launched at login → stays hidden (`wasOpenedAtLogin`). The main process polls `/api/status` every 30 s and posts a notification when open opportunities go up while the window isn't focused. Privacy → Background work has an "Open Resona at login" switch (Mac app only).
   - Not verified: the icon's look in the real menu bar, the Open at Login toggle (in dev it would register Electron.app itself, so it was left for the packaged build), and that notifications actually appear (the call was verified, not the macOS banner; an unsigned app may need notification permission).
   - Quitting mid-request can leave `resona.db-wal`/`-shm` behind: the backend exits 0 but SQLite defers the final checkpoint while a statement is open. Verified harmless (integrity_check ok, data kept, files folded back on next open).
   - Step 5: `cd desktop && npm run dist` → `desktop/dist/Resona-0.1.0-arm64.dmg` (116 MB; app 264 MB). electron-builder config is in `desktop/package.json` (`build`): arm64 only, ad-hoc signature (`identity: "-"`, required on Apple Silicon), no notarization, backend + UI + tray icons copied to `Contents/Resources`. Icons come from `desktop/scripts/icons.mjs` (`npm run icons`): dot with fading resonance rings, violet→teal; drafted by the assistant, the user can replace `assets/icon.png`/`icon.icns`. Tauri scaffold, deps and comments removed. README has the friend install steps (Open Anyway, `xattr -cr`).
   - Verified: `codesign --verify` passes (adhoc), `spctl` rejects (expected without Apple account), packaged app runs on a test copy (UI, API, token 401, clean quit).
   - Step 6: the app checks `api.github.com/repos/Sonicnik/resona/releases/latest` on launch and every 6 h (`checkForUpdate` in `desktop/src/main.ts`, version compare in `src/version.ts` with a test). A newer tag adds "Download Resona x.y.z…" to the menu bar icon and posts one notification; both open the release page. `npm run release` (needs `GH_TOKEN`) uploads the DMG to a draft release `v<version>`; release steps are in `desktop/README.md`. The repo is public (checked 2026-11-09), so no token ships in the app. `RESONA_RELEASES_URL` overrides the feed for testing only.
   - Verified against a fake v0.1.1 feed with the packaged 0.1.0 app: request sent with UA `Resona/0.1.0`, notification and tray item appeared. No real release published yet (GitHub returns 404 until then, which the app ignores).
   - Next: step 7, docs/dev workflow (mostly done along the way: README install section, `desktop/README.md`). Then commit on a `feature/mac-app` branch (the worktree branch is still `claude/...`, which the user's rules forbid on GitHub).
   - Test tip: launch with `--remote-debugging-port=9333 --inspect=9334`; the renderer is reachable via DevTools JSON, and native menu items can be clicked from the main inspector with `process.getBuiltinModule("node:module").createRequire(process.cwd()+"/")("electron").Menu` (dynamic `import()` is blocked there).
5. **Not built:** real publishing (manual by design), PDF/DOCX parsing, Phase 2 CVs, authorized LinkedIn search.
6. **Older Hacker News posts** in the demo DB keep old titles and run-together text until rescanned.

## Gotcha: the browser pane can't animate

The Browser pane runs pages with 0 animation frames per second (even when shown), so the 3D map doesn't move, tween or orbit there. To check network changes, measure with code: add a temporary `window.__dbgGraph = g` hook in `Graph.tsx`, project node positions, and remove the hook before committing. The graph uses `warmupTicks(120)`, so positions are settled at load.

## Environment facts

- Repo: `https://github.com/Sonicnik/resona` (owner Sonicnik). Main branch `main`.
- Worktree: `/Users/soni8nik/Personal/Programs/Competition/CubeBuildathon/.claude/worktrees/macbook-app-plan-c3bc1a` (branch `feature/mac-app`).
- The user runs `./start.sh` in the app's terminal tab. Their AI provider is the **ChatGPT plan** (`gpt-6.1-sol`).
- Node 25; backend uses built-in `node:sqlite` (Electron 45 ships Node 24, which has it too). No `gh` CLI. No Rust (not needed: the Mac app is Electron).
- Product intent and research: `docs/product-reference.md`. API: `backend/docs/api-reference.md`.

## Next action

Ask the user whether to push `feature/mac-app` and open a PR, try the DMG on a friend's Mac, or start open item 1 (matcher tuning).
