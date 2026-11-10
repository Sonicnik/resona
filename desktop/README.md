# Resona Mac app

Electron shell around the backend (`../backend`) and the UI (`../app`). The main process runs the bundled backend in a utility process on `127.0.0.1:4317` with a per-launch API token, and the window loads the UI the backend serves. Closing the window keeps the agent running in the menu bar.

| Task | Command (in `desktop/`) |
| --- | --- |
| Run from source | `npm install && npm start` (stop `./start.sh` first: same port and real data) |
| Build the DMG | `npm run dist` → `dist/Resona-<version>-arm64.dmg` |
| Redraw the icons | `npm run icons` (edits `assets/`) |
| Typecheck / tests | `npm run typecheck`, `npm test` |

For a test copy that doesn't touch your data, set `RESONA_PORT`, `RESONA_DATA_DIR`, `RESONA_SCHEDULER=0` and `RESONA_WATCH=0` before `npx electron .`.

## Release a new version

The app isn't signed with an Apple Developer ID, so it can't update itself. Instead it checks GitHub's latest release on launch and every 6 hours, and offers **Download Resona x.y.z…** in the menu bar plus one notification.

1. Raise `version` in `desktop/package.json` (for example `0.1.0` → `0.1.1`).
2. Create a GitHub token that can write releases to `Sonicnik/resona` (fine-grained, Contents: read and write). Keep it out of the repo.
3. Run `GH_TOKEN=<token> npm run release`. It builds the DMG and uploads it to a **draft** release tagged `v<version>`.
4. On GitHub, open the draft, add notes (include the first-launch steps from the main README), and **Publish**. Installed apps notice it within 6 hours or on their next launch.
