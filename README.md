# Personal Networking Agent

A local-first AI networking app for Mac that turns your projects into personalized outreach, social post drafts, and a visual professional network.

**Status:** First prototype. The local backend in [`backend/`](backend/README.md) (TypeScript/Node, SQLite, an Obsidian-compatible Markdown vault, and the Claude API; see the [API reference](backend/docs/api-reference.md)) is wired to the glass "star map" UI in [`app/`](app/) (React + Vite, ported from [`design/prototype.html`](design/prototype.html)). It runs in the browser or as a Mac app ([`desktop/`](desktop/), Electron); authorized LinkedIn access is not yet implemented.

## Install the Mac app

Download `Resona-<version>-arm64.dmg` from [Releases](https://github.com/Sonicnik/resona/releases) (Apple Silicon Macs). The app isn't signed with an Apple Developer ID, so macOS blocks it the first time:

1. Open the DMG, drag **Resona** to **Applications**, open it, and close the warning.
2. Open **System Settings → Privacy & Security**, scroll down, click **Open Anyway** next to Resona, and enter your Mac password.
3. If macOS says Resona "is damaged and can't be opened", run `xattr -cr /Applications/Resona.app` in Terminal and open it again.

You only do this once per version. Resona then lives in the menu bar: closing the window keeps the agent working, and **Quit Resona** (⌘Q or the menu bar icon) stops it. Your data stays in `~/Library/Application Support/Resona`.

To build the DMG yourself: `cd desktop && npm install && npm run dist` (output in `desktop/dist/`).

## Run the prototype

Needs Node 22.13+. From the repository root:

```bash
./start.sh
```

It installs what's missing, starts the backend on demo data, seeds it once, and opens http://localhost:1420. Ctrl+C stops everything. Demo data lives in `~/.resona-demo` (delete it to reset); `./start.sh --real` uses your real data instead, without seeding.

To turn on AI, open **Privacy** and either choose **Continue with ChatGPT** to use your ChatGPT Plus or Pro plan (OpenAI's sign-in, preview), or **Claude → Connect** to paste an Anthropic API key. Tokens and keys are stored in your macOS Keychain, never in this repository. Then allow AI per folder.

## How it works

1. **Understand your projects.** Add local project folders. The agent summarizes your work, contributions, results, and interests.
2. **Find relevant conversations.** Use project context to discover people discussing problems you have addressed, related ideas, or potential collaborations.
3. **Review personalized drafts.** Get a shortlist of opportunities with source posts, reasons to engage, and editable replies or messages.
4. **Build your network.** Choose what to send, track interactions and follow-ups, and grow a people-only network web. Select a person to explore shared interests, relevant projects, and conversation history.

## Planned features

- LinkedIn-first discovery, with authorized access still to be resolved.
- Standalone LinkedIn and X post drafts based on meaningful project updates.
- Automatic folder analysis and weekly reviews.
- Optional Gmail, calendar, and LinkedIn archive imports to reduce manual entry.
- User review before every send or publication.

## Local-first by design

The main database stays on your Mac. Selected content is sent to third-party AI providers with permission per folder, exclusions, and processing history. Processing pauses when the Mac is unavailable and catches up afterward.

## Later: tailored CVs

Build a separate master career record from projects and existing CVs, then generate tailored CVs when needed.

See the [product reference](docs/product-reference.md) for decisions, architecture proposals, research, and open questions.
