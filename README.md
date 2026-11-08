# Personal Networking Agent

A local-first AI networking app for Mac that turns your projects into personalized outreach, social post drafts, and a visual professional network.

**Status:** First prototype. The local backend in [`backend/`](backend/README.md) (TypeScript/Node, SQLite, an Obsidian-compatible Markdown vault, and the Claude API; see the [API reference](backend/docs/api-reference.md)) is wired to the glass "star map" UI in [`app/`](app/) (React + Vite, ported from [`design/prototype.html`](design/prototype.html)). It runs in the browser for now; the Tauri window and authorized LinkedIn access are not yet implemented.

## Run the prototype

Needs Node 22.13+. From the repository root:

```bash
./start.sh
```

It installs what's missing, starts the backend on demo data, seeds it once, and opens http://localhost:1420. Ctrl+C stops everything. Demo data lives in `~/.resona-demo` (delete it to reset); `./start.sh --real` uses your real data instead, without seeding.

To turn on AI, open **Privacy → Claude → Connect**: it opens the Anthropic key page in your browser, and the key you paste is stored in your macOS Keychain, never in this repository.

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
