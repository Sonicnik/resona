# Plan: turn the Resona demo into a real Mac app

## Context

Today Resona runs as two dev processes started by `./start.sh`: the Node backend (`backend/`, Express + `node:sqlite`, run through `tsx`) on `127.0.0.1:4317`, and the Vite dev server (`app/`) on `localhost:1420` opened in a browser tab. The UI *imitates* a Mac: a fake menu bar with a clock (`App.tsx:273`), fake traffic lights (`.traffic`), and a fake window frame. The Tauri scaffold in `app/src-tauri` was never used (no Rust on this Mac).

Goal: a double-clickable **Resona.app**, shipped as an **unsigned DMG on GitHub Releases** for us and a few friends (no Apple Developer account), that keeps the agent running from the **menu bar** after the window closes, can **open at login**, and **tells you when a new version is out**.

Decisions (from your answers): Electron · unsigned (ad-hoc signed) DMG, no Apple Developer account · menu bar + launch at login · "update available" notice instead of self-installing updates (Electron's macOS updater only works on Developer ID-signed apps).

## Approach in one paragraph

Add a small `desktop/` Electron package. Its main process forks the existing backend (bundled to one JS file) in an Electron `utilityProcess`, and the backend also serves the built UI (`app/dist`) on the same `127.0.0.1:4317` origin, so `app/src/api.ts` (`fetch("/api"+path)`) works unchanged. The window loads `http://127.0.0.1:4317/`. A per-launch random token goes to the backend as `RESONA_API_TOKEN` (already supported by `localOnly` in `backend/src/api/http.ts:87`) and Electron adds the `Authorization` header to every request, so no other local process can drive the API. The fake Mac chrome is hidden when running inside the app; real menus, traffic lights, tray and notifications come from Electron. `electron-builder` makes the DMG (ad-hoc signed, which Apple Silicon requires and costs nothing) and publishes it to GitHub Releases; the app checks the latest release and offers a download link.

## Steps

### 1. Bundle the backend for production (no `tsx` at runtime)
- Add `esbuild` (dev dep) and a build script that bundles `backend/src/index.ts` → `desktop/build/backend.mjs` (ESM, `platform: node`, `node:*` external, top-level await allowed, a `createRequire` banner so CJS deps like Express load).
- `backend/src/api/app.ts`: if `RESONA_STATIC_DIR` is set, `app.use(express.static(dir))` plus an SPA fallback to `index.html` for non-`/api` GETs. ~3 lines; dev mode is unchanged.
- Check: `node desktop/build/backend.mjs` with `RESONA_STATIC_DIR=app/dist` serves the UI at `http://127.0.0.1:4317/` and the API works. Existing 35 tests still pass.

### 2. Electron shell (`desktop/`)
New files: `desktop/package.json`, `desktop/src/main.ts`, `desktop/src/preload.ts` (bundled by the same esbuild script).
- **Single instance** (`app.requestSingleInstanceLock`); second launch focuses the window.
- **Backend:** `utilityProcess.fork(backend.mjs, { env: { ...process.env, RESONA_STATIC_DIR, RESONA_API_TOKEN, RESONA_ALLOWED_ORIGINS: "http://127.0.0.1:4317" } })`; wait for `/api/health`; on crash show an error dialog with a Restart button. On quit, send SIGTERM (backend already shuts down cleanly, `index.ts` `shutdown`).
- Fixed port 4317 kept on purpose: `localStorage` (welcome flag in `Privacy.tsx`) is per-origin and a random port would reset it each launch. The ChatGPT callback stays on 1455.
- **Token header:** `session.defaultSession.webRequest.onBeforeSendHeaders` for `http://127.0.0.1:4317/*` adds `Authorization: Bearer <token>`.
- **Window:** `titleBarStyle: "hiddenInset"`, `trafficLightPosition` placed where the fake `.traffic` buttons sit, `vibrancy`/transparent background so the glass look stays, `minWidth/minHeight`, size and position remembered.
- **External links:** `setWindowOpenHandler` → `shell.openExternal(url)` for http(s), deny everything else; block in-window navigation away from the app origin.
- **Preload** exposes `window.resona = { desktop: true, onMenu(cb), setLoginItem(on), getLoginItem() }` via `contextBridge` (contextIsolation on, nodeIntegration off, sandbox on).

### 3. Make the UI native inside the app (`app/src/App.tsx`, `styles.css`, `Privacy.tsx`)
- When `window.resona?.desktop`: add a `desktop` class on `<html>`; CSS hides `.menubar`, the clock and `.traffic`; `.window` fills the whole window (like `zoomed`, no fake frame/close/minimize); toolbar and sidebar header get `-webkit-app-region: drag`, buttons inside get `no-drag`.
- **Native menu bar:** build the Electron `Menu` in `main.ts` (Resona / File / Edit / View / Window / Help using standard roles for Edit, Window, Quit, Hide). App-specific items send `menu:<id>` over IPC; the renderer calls the matching `run()` from the existing `MENUS` object in `App.tsx`, so no menu logic is duplicated.
- `Privacy.tsx:97` opens a blank tab then sets its URL (a browser popup-blocker workaround). In the app, call `window.open(url)` after the API returns; the open handler sends it to the default browser.
- Rename user-visible "Networking Agent" to **Resona** (menu label, help link), matching the repo, data folder and Keychain service.

### 4. Menu bar (tray) + background + launch at login
- Closing the window hides it (agent keeps running); Dock click or tray "Open Resona" shows it; ⌘Q / tray "Quit" quits for real.
- Tray icon (template image) with: status line (from `GET /api/status`, polled every 30 s), **Pause/Resume agent** (`PATCH /api/settings {"agent.paused": …}`, the same call the sidebar status button makes), **Scan now**, **Open at Login** checkbox (`app.setLoginItemSettings({ openAtLogin, openAsHidden: true })`), Open, Quit.
- Same toggle shown in the Privacy screen through `window.resona.setLoginItem`.
- **Notification** when new opportunities above the current "strong" level arrive while the window is hidden (compare `status.counts.openOpportunities` between polls); click opens Opportunities.

### 5. Packaging (`electron-builder`, no Apple account)
- Config in `desktop/package.json`: `productName: Resona`, `appId: com.sonicnik.resona`, `mac.target: dmg`, `arch: arm64` (add `x64` only if a friend has an Intel Mac), `mac.identity: "-"` (ad-hoc signature), `notarize: false`, `extraResources`: `app/dist` and `build/backend.mjs`.
- **App icon:** the current `app/src-tauri/icons/icon.icns` is the Tauri default. Need a 1024×1024 Resona icon (can be drawn from `design/` style). Tray needs a small monochrome template PNG.
- `npm run dist` (in `desktop/`): build UI → bundle backend+main → `electron-builder --mac`.
- Delete `app/src-tauri/` and the `@tauri-apps/*` deps from `app/package.json`; update the Tauri comments in `vite.config.ts` and the `security -w` shortcut comment in `system/mac.ts`.
- **First launch for friends** (goes in the README and the release notes), because macOS blocks unsigned downloads once:
  1. Open the DMG, drag Resona to Applications, open it, close the warning.
  2. System Settings → Privacy & Security → **Open Anyway**, enter the Mac password.
  3. If macOS says the app "is damaged": `xattr -cr /Applications/Resona.app`, then open it again.
- Keychain note: with an ad-hoc signature, macOS may ask "allow access to Keychain" after each update. Values are written by the `security` CLI, so this is expected to stay quiet; check it in verification.

### 6. "Update available" notice (GitHub Releases)
- `npm run release` (in `desktop/`): `electron-builder --mac --publish always` with `publish: { provider: "github", owner: "Sonicnik", repo: "resona" }` uploads the DMG to a draft release (needs `GH_TOKEN` env at publish time, never in the repo). You then publish the draft on GitHub.
- In `main.ts`, on launch and every 6 h: `fetch("https://api.github.com/repos/Sonicnik/resona/releases/latest")`, compare `tag_name` with `app.getVersion()`; if newer, add "Version X is available: Download" to the tray menu and show one notification. Clicking opens the release page in the browser (`shell.openExternal`). ~15 lines, no dependency.
- **The repo must be public** for this unauthenticated check and for friends to download the DMG. If it stays private, invite friends as collaborators and drop the check.

### 7. Docs and dev workflow
- `./start.sh` keeps working for browser dev. Add `npm --prefix desktop run dev` (Electron pointed at Vite on 1420 with `RESONA_ALLOWED_ORIGINS` including it).
- Update `docs/PROGRESS.md` (new run/build/release commands, decisions table: Electron replaces Tauri) and `README.md` install section.

## Critical files
- New: `desktop/package.json`, `desktop/src/main.ts`, `desktop/src/preload.ts`, `desktop/build.mjs` (esbuild), `desktop/assets/` (icon, tray template, entitlements if customised).
- Changed: `backend/src/api/app.ts` (static serving), `app/src/App.tsx` (desktop class, IPC menu hook, rename), `app/src/styles.css` (desktop rules), `app/src/screens/Privacy.tsx` (link opening, login item toggle), `app/package.json` + `app/vite.config.ts` (drop Tauri), `docs/PROGRESS.md`, `README.md`.
- Removed: `app/src-tauri/`.
- Reused as is: `localOnly` token + Host check (`backend/src/api/http.ts`), `loadConfig` data dir `~/Library/Application Support/Resona` (`backend/src/config.ts`), Keychain store and Finder picker (`backend/src/system/mac.ts`), graceful shutdown (`backend/src/index.ts`), `MENUS` actions (`App.tsx`).

## Verification
1. `cd backend && npm test` and both `tsc --noEmit` checks pass.
2. `npm --prefix desktop run dist` produces `Resona.app`; launch it and check: window shows real traffic lights and native menus, no fake menu bar; Home/Network/Opportunities load real data from `~/Library/Application Support/Resona`; Add Project Folder picker appears **in front** (if the osascript dialog opens behind the window, switch the backend chooser to an IPC call to `dialog.showOpenDialog`); "Open on X" and "Continue with ChatGPT" open the default browser; Copy & Open puts text on the clipboard.
3. `curl http://127.0.0.1:4317/api/status` from Terminal returns 401 (token required); the app still works.
4. Close the window → tray icon stays, Pause/Resume changes the sidebar status after reopening; toggle Open at Login and confirm in System Settings → General → Login Items; ⌘Q stops the backend (port 4317 free afterwards).
5. Friend install: upload the DMG to a draft release, download it in a browser on another Mac (or another user account), and follow the three first-launch steps; the app opens and works. Repeat once to check for repeated Keychain prompts.
6. Update notice: install v0.1.0, publish v0.1.1, confirm the tray shows "Version 0.1.1 is available" and Download opens the release page.

## Skipped on purpose
Apple Developer ID signing and notarization (only us and friends use it; can be added later with the $99 account and a config change), self-installing updates (need that signing), Mac App Store build (sandbox conflicts with folder watching, osascript, `security` CLI), CI release pipeline (releases built locally), native Keychain API (the `security` CLI keeps working), Windows/Linux builds, bundled demo data in the app.
