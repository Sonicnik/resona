# Resona backend API reference

Base URL: `http://127.0.0.1:4317/api` (configurable with `RESONA_HOST` / `RESONA_PORT`).

The API serves the local Mac app only:

- It binds to loopback and rejects requests whose `Host` header is not `localhost`, `127.0.0.1` or `::1`.
- Browser requests that carry an `Origin` header must come from an origin listed in `RESONA_ALLOWED_ORIGINS`.
- If `RESONA_API_TOKEN` is set, every request needs `Authorization: Bearer <token>`.

Requests and responses are JSON. Timestamps are ISO 8601 strings in UTC.

## Conventions

**Errors.** Every error has the same shape:

```json
{ "error": { "code": "conflict", "message": "cannot move an action from awaiting_approval to sent", "details": {} } }
```

| Status | `code` | When |
| --- | --- | --- |
| 400 | `bad_request`, `invalid_json`, `invalid_reference` | Validation failed. `details` lists each failing field. |
| 401 | `unauthorized` | `RESONA_API_TOKEN` is set and the token is missing or wrong. |
| 403 | `forbidden_host`, `forbidden_origin` | The request is not local. |
| 403 | `ai_permission_denied` | The folder has not granted AI processing. |
| 404 | `not_found` | Unknown record or endpoint. |
| 409 | `conflict` | Invalid state transition, duplicate, or stale review. |
| 422 | `ai_refused` | The model declined the request. |
| 503 | `ai_unavailable`, `connector_unavailable` | No Claude credentials, or the source is not authorized. |

**IDs** carry a type prefix: `per_` person, `prof_` profile, `prj_` project, `ctx_` project context, `q_` question, `post_` source post, `opp_` opportunity, `drf_` draft, `act_` action, `int_` interaction, `rel_` relationship, `fu_` follow-up, `rvw_` weekly review.

**Nothing is sent automatically.** The backend never posts, replies or messages anyone. Outward actions follow this sequence: draft → request approval → approve the exact revision → the user sends it → `mark-sent`.

---

## System

### `GET /health`
Returns `{ "ok": true }`.

### `GET /status`
Returns the agent state (`agent.state`: `running`, `paused` or `catching_up`), AI availability and model, storage paths, record counts, scheduler jobs (including `resumedAfterPauseAt` after sleep), and connector status.

### `GET /settings` · `PATCH /settings`
These settings can be read and changed:

| Key | Default | Meaning |
| --- | --- | --- |
| `schedule.discovery.enabled` | `false` | Daily automatic discovery. It is off by default because it sends project keywords to third-party search APIs. |
| `schedule.weeklyReview.enabled` | `true` | Generate a weekly review every 7 days. |
| `schedule.vaultSync.enabled` | `true` | Sync the Markdown vault every 10 minutes. |
| `ai.disabled` | `false` | Turn off all model calls (offline mode). |
| `agent.paused` | `false` | Global pause: scheduled jobs and the folder watcher stop. On resume, each overdue job runs once. |
| `ai.provider` | `anthropic` | `anthropic` (Claude API key) or `chatgpt` (the user's ChatGPT plan). Signing in with ChatGPT selects it when no Claude key is set. |
| `ai.chatgptModel` | `""` | Model slug for the ChatGPT plan; empty uses the first model the account lists. |

`PATCH` takes a partial object and rejects unknown keys.

### Credentials: `GET /credentials` · `PUT /credentials/:name` · `DELETE /credentials/:name`
`:name` is `anthropic`, `github` or `x`. The app's **Connect** flow opens the provider's key page in the browser; the user pastes the key once. `PUT` takes `{ value }`, verifies an Anthropic key with a model-list call (400 `invalid_credential` if rejected), stores it in the **macOS login Keychain** (service `Resona`) and applies it. Pasted quotes or a whole `export NAME=value` line are trimmed to the value; Claude subscription tokens (`sk-ant-oat…`) and Admin keys are refused with an explanation, and a failed check returns Anthropic's reason (or a network error) in `message`. The key is applied without a restart. Responses are `{ name, connected, hint: "…abcd" }`: values are never returned, logged, or written to the database, vault or repository. Stored keys load at startup unless the environment already sets them. Anthropic does not allow third-party apps to offer Claude-account login, so this is an API key, not OAuth.

### Sign in with ChatGPT: `GET /chatgpt` · `POST /chatgpt/sign-in` · `POST /chatgpt/cancel` · `POST /chatgpt/sign-out` · `GET /chatgpt/models`
Uses OpenAI's [ChatGPT plan usage for open-source and locally hosted apps](https://developers.openai.com/siwc/token-sharing-open-source) (preview; eligible Plus and Pro plans). `POST /chatgpt/sign-in` starts a one-off listener on `http://127.0.0.1:1455/auth/callback` (another loopback port if busy) and returns the OpenAI authorization URL to open in the browser: PKCE (S256), `state` and `nonce`, `client_id=dynamic_agent_client` on first registration (the issued client id afterwards), a persisted `ext_agent_host_id`. The callback exchanges the code, verifies the ID token against OpenAI's JWKS (issuer, audience, expiry, nonce) and requires the `chatgpt.tokens.use.direct` grant. Tokens are stored in the macOS Keychain (account `chatgpt`), refreshed with rotation before expiry, and revoked on sign-out. `GET /chatgpt` returns `{ connected, signedIn, email, planUsage, signingIn, error, model, usageUrl }`; no token is ever returned.

With `ai.provider = chatgpt`, model calls go to `POST https://api.openai.com/v1/responses` with `store: false` and `stream: true`; the JSON schema is given in the instructions and replies are validated with the same Zod schemas. Processing history records the provider as `openai-chatgpt-plan`. A usage-limit error tells the user to review their plan at https://chatgpt.com/settings/usage.

### `POST /system/choose`
Body: `{ kind: "folder"|"file", prompt? }`. Opens a native Finder dialog on this Mac (`osascript`) and returns `{ path }`, or `{ path: null }` if cancelled. Browsers hide real file paths, so the app uses this to add folders and import archives.

### `GET /jobs` · `POST /jobs/:name/run`
`GET /jobs` lists the background jobs with their last run and next due time. `POST /jobs/:name/run` runs one job now. The jobs are `rescan-folders`, `summarize-pending`, `discovery`, `suggest-followups`, `weekly-review` and `vault-sync`.

### `GET /processing-history?projectId=&limit=`
Lists every request that sent, or tried to send, user material to a model provider. Each entry has `purpose`, `project_id`, `model`, `input_refs` (file and line references), `input_chars`, token usage and `status` (`ok`, `error`, `refused` or `blocked`).

---

## Me

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| GET | `/me` | | The user's own person record, with profiles. |
| PATCH | `/me` | `{ displayName?, bio?, organization?, title?, location?, notes?, interests? }` | |
| POST | `/me/profiles` | `{ platform, url?, handle?, externalId? }` | Lets imports recognize your own messages. |

---

## Projects (step 1: understand your work)

### `POST /projects`
```json
{ "folderPath": "/Users/me/code/rag-eval", "name": "rag-eval", "kind": "project", "aiPermission": "denied", "exclusions": ["drafts/"], "scan": true }
```
Adds a folder that the user selected. The default is `aiPermission: "denied"`; until the user grants it, nothing from the folder is sent to a model, and summaries are built locally (`method: "extractive"`). With `scan: true` (the default), the response includes the first pipeline run: scan → summary → re-match. Returns `201 { project, processing }`. Returns 409 if the folder was already added.

The default exclusions are always applied, as is the folder's `.gitignore`. They cover dependencies, VCS folders, generated output, temporary files, credentials and IDE files. Files whose content looks like a credential (private keys, API tokens) are skipped and never indexed.

### `GET /projects/exclusions/defaults`
Returns the default exclusion patterns, grouped by category.

### `GET /projects?kind=project|cv`
Lists projects. Each has `needsSummary`, which is true when files changed after the last summary.

### `GET /projects/:id`
Returns the project, file counts by state, the latest context, and open clarification questions.

### `PATCH /projects/:id`
Body: `{ name?, status?: "active"|"paused"|"archived", aiPermission?: "allowed"|"denied", exclusions?: string[] }`. Changing exclusions forces a full re-check on the next scan, and newly excluded files are removed from the index.

### `DELETE /projects/:id`
Deletes the project and its index.

### `POST /projects/:id/scan`
Body: `{ forceSummary?: boolean }`. Runs an incremental scan now. It re-summarizes only if content changed.

### `POST /projects/:id/summarize`
Body: `{ force?: boolean, preferAi?: boolean }`. Creates a new versioned context when the source fingerprint (file hashes plus answered questions) changed. Drafts written from an older context that have not been sent yet are flagged `stale`. The response is `{ status: "created"|"unchanged", method, version, questionsAdded, staleDrafts, rematched, aiError?, context }`.

### Context and history
- `GET /projects/:id/context` returns the latest context: `summary, problem, audience, built, contribution, results[{claim, evidence[], confidence}], capabilities, limitations, keywords, searchPhrases, uncertainties, shareableMaterial`.
- `GET /projects/:id/contexts` returns every version.
- `GET /projects/:id/files?state=indexed|skipped|error|deleted` lists files with skip reasons.
- `GET /projects/:id/runs` lists ingestion runs.

### Clarification questions
- `GET /projects/:id/questions?status=open|answered|dismissed`
- `POST /questions/:id/answer` with `{ answer }`. The answer is treated as a fact the user stated and is used in the next summary.
- `POST /questions/:id/dismiss`

### `POST /projects/:id/post-drafts`
Body: `{ platform: "linkedin"|"x", angle?, useAi?, force? }`. Drafts a standalone post about a meaningful development. With AI, the model may decline when nothing is worth posting; the API then returns 409 with `details.worthPosting = false`, unless `force` is set.

---

## Search

### `GET /search?q=&types=project_file,source_post,project_context,interaction&projectId=&limit=`
Hybrid search: BM25 from SQLite FTS5 for exact terms, plus cosine similarity over local embeddings. Each hit has `score`, `keywordScore`, `semanticScore`, `text`, and `ref` (for example `README.md:9-24`).

---

## Conversations and discovery (step 2: find relevant conversations)

### `GET /connectors`
Lists connector status. LinkedIn is listed but disabled: authorized discovery access has not been established. GitHub and Hacker News search are available, and X needs `X_BEARER_TOKEN`. Connectors are read-only.

### `POST /source-posts`
Adds a conversation by hand. Use this for LinkedIn posts the user found themselves.
```json
{
  "platform": "linkedin",
  "url": "https://www.linkedin.com/posts/...",
  "text": "Is there a tool that measures retrieval recall automatically?",
  "publishedAt": "2026-11-05T10:00:00Z",
  "author": { "url": "https://www.linkedin.com/in/jane-doe", "displayName": "Jane Doe", "headline": "ML engineer" },
  "match": true
}
```
Saves the post and its author, who is deduplicated by platform ID or canonical profile URL and never by name. It then scores the post against every active project and returns `{ postId, created, authorPersonId, opportunities[] }`. The call is idempotent on `(platform, externalId)`; `externalId` defaults to the URL.

### `GET /source-posts?platform=&limit=` · `GET /source-posts/:id`
List stored posts, or fetch one.

### `POST /discovery/run`
Body: `{ projectIds?, connectorIds?, queriesPerProject? (1-10), limitPerQuery? (1-50), sinceDays? }`. Builds queries from each project's search phrases and keyword pairs, searches the available connectors, stores the results and matches them. The response reports the queries, the posts found, the new opportunities, and connector errors and skips.

### `GET /discovery/last`
Returns the last discovery report.

---

## Opportunities (step 3: shortlist)

### `GET /opportunities?state=new|shortlisted|dismissed|acted_on&projectId=&personId=&minRelevance=&limit=`
Results are sorted by `relevance` (0-1). Each opportunity has:
- `scenario`: one of `problem_described`, `wish_for_tool`, `recommendation_request`, `manual_workflow`, `adjacent_product`, `technical_question`, `method_published`, `examples_requested`, `open_source_issue`, `hiring`, `collaborator_search`, `past_contact_followup`, `general_discussion`.
- `situation`: `{ headline, gist, source }`, a short summary for the card. `headline` is the post's title (prefixed `Pull request ·` / `Issue ·` on GitHub; Hacker News comments read `Re: <thread>`), and `gist` is the one sentence that best states what the author needs (at most 180 characters, extracted locally). After `POST /opportunities/:id/assess`, `gist` is the AI's own one-sentence summary and `source` is `ai`. `post.url` links to the exact post or comment.
- `why`: one line, e.g. `Jane asks for recommendations · fits rag-eval · shared: recall, rag`; after an AI fit check it is the AI's reason. `suggestion`: the suggested kind of contribution.
- `matchReason`, `suggestedChannel`, `suggestedAction`.
- `flags`, for example "discussion appears resolved", "author asked not to be pitched", "you have already contacted this person recently", or "post asks for something the project lists as a limitation".
- `evidence`: project file excerpts with `ref`.
- `scoreBreakdown`: `semantic`, `keyword`, `intent`, `freshness`, `openness`, `requirementFit`, `duplicatePenalty`, `sharedTerms`, `matchedPhrases`.
- `post` (`url`, `text`, `platform`, `publishedAt`) and `personId` / `personName`.

### `GET /opportunities/:id` · `PATCH /opportunities/:id`
`PATCH` takes `{ state }`. Allowed transitions: `new` → `shortlisted`, `dismissed` or `acted_on`; `shortlisted` → `new`, `dismissed` or `acted_on`; `dismissed` → `new` or `shortlisted`. `acted_on` is final.

### `POST /opportunities/:id/assess`
Optional AI check of whether the project genuinely meets what the author needs. Requires AI permission on the folder. If the project does not fit, a `new` opportunity is dismissed.

### `POST /opportunities/rematch`
Body: `{ projectIds?, sinceDays? }`. Re-scores stored posts. Dismissed opportunities are never brought back.

### `POST /opportunities/:id/drafts`
Body: `{ useAi?: boolean, channel?: "public_reply"|"direct_message"|"email"|"comment" }`. Creates an individualized, editable draft and moves the opportunity to `shortlisted`. With AI it uses Claude; otherwise it fills a scenario template with `[placeholders]`.

---

## Drafts and actions (step 4: you choose what to send)

### Drafts
| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| GET | `/drafts?kind=outreach|post&personId=&projectId=&stale=true` | | Active drafts. |
| GET | `/drafts/:id` | | `revision` (current text), `actions`, `stale`, `staleReason`, `meta` (rationale, cautions). |
| GET | `/drafts/:id/revisions` | | Full revision history. |
| POST | `/drafts/:id/revisions` | `{ body, title? }` | Creates a user revision, clears `stale`, and **cancels any pending or approved action** (an edit needs a new review). Returns 409 if the draft was already sent. |
| DELETE | `/drafts/:id` | | Archives the draft. |
| POST | `/drafts/:id/actions` | `{ destination }` | Requests approval of the **current** revision for one destination (post URL, handle or email). Returns 409 if an action is already open. |

### Actions
States: `awaiting_approval` → `approved` → `sent` (or `failed` / `uncertain`), plus `cancelled`. The `queued` state is reserved for future authorized publishing integrations.

| Method | Path | Body | Transition |
| --- | --- | --- | --- |
| GET | `/actions/:id` | | |
| POST | `/actions/:id/approve` | `{ revision, acknowledgeStale? }` | `awaiting_approval → approved`. `revision` must equal the action's revision and the draft's current revision (409 otherwise). A stale draft needs `acknowledgeStale: true`. |
| POST | `/actions/:id/cancel` | | → `cancelled` |
| POST | `/actions/:id/mark-sent` | `{ externalMessageId?, sentAt?, url? }` | `approved|queued|uncertain → sent`. Records an outbound interaction and marks the opportunity `acted_on`. |
| POST | `/actions/:id/mark-failed` | `{ error }` | → `failed` |
| POST | `/actions/:id/mark-uncertain` | `{ note? }` | → `uncertain`. Check the platform before retrying. |
| POST | `/actions/:id/reconcile` | `{ wasSent, externalMessageId?, sentAt? }` | `uncertain → sent` or `failed`. Required before a retry. |
| POST | `/actions/:id/retry` | | `failed → awaiting_approval`. Needs a fresh approval. |

An approved draft, a sent message, a received reply and an accepted connection stay separate records. Sending a message never marks someone as connected. A reply received (`interactions` with direction `inbound`) moves a prospect to `contact`.

---

## People and identity

| Method | Path | Body / query | Notes |
| --- | --- | --- | --- |
| GET | `/people?q=&status=prospect|contact|archived&limit=&offset=` | | Merged records are hidden. |
| POST | `/people` | `{ displayName, bio?, organization?, title?, location?, notes?, interests?, status?, profiles?[] }` | |
| GET | `/people/duplicates` | | Merge candidates (same email, or same name and organization). Never merged automatically. |
| GET | `/people/:id` | | **Person detail** (see below). |
| PATCH | `/people/:id` | person fields | |
| DELETE | `/people/:id` | | The self record cannot be deleted. |
| POST | `/people/:id/profiles` | `{ platform, url?, handle?, externalId?, displayName?, headline?, email? }` | Returns 409 if the profile belongs to someone else (merge instead). |
| DELETE | `/profiles/:id` | | |
| POST | `/people/:id/merge` | `{ mergeId }` | Moves profiles, relationships, interactions, opportunities, drafts and follow-ups onto `:id`. Leaves a `mergedInto` pointer. |
| GET | `/people/:id/paths?k=3&maxHops=4` | | Warm-introduction paths (see Network). |
| POST | `/people/:id/drafts` | `{ useAi?, channel?, reason? }` | Follow-up draft to someone already in your network (no opportunity), grounded in the last interactions, the open follow-up reason and the most recently linked project. Same approval flow as other drafts. |

**Person detail** (`GET /people/:id`) returns everything the app shows when a person is selected:
`person`, `profiles`, `metrics` (tie strength, PageRank, bridge score, community, counts), `connectionStatus` (`approvedDrafts`, `sentByYou`, `repliesReceived`, `platformConnections`, `follows`, each reported separately), `discoveredVia` (source posts), `projects` (with evidence), `sharedInterests` (shared project keywords and semantic similarity, with `establishedBy`), `interactions`, `opportunities`, `drafts`, `followups`, `relationships` (with verification source) and `vaultMentions`.

### Relationships
| Method | Path | Body |
| --- | --- | --- |
| GET | `/relationships?personId=` | |
| POST | `/relationships` | `{ fromPersonId, toPersonId, type: connection|follows|colleague|classmate|mentor|introduced|other, direction?: directed|mutual, platform?, observedAt?, verificationSource?: platform_api|archive_import|user_confirmed|observed (default user_confirmed), evidence? }` |
| DELETE | `/relationships/:id` | |

Relationships are assertions backed by evidence. Shared interests and group membership never create them.

### Interactions
| Method | Path | Body |
| --- | --- | --- |
| GET | `/interactions?since=&limit=` | |
| POST | `/interactions` | `{ platform, type: message|reply|comment|meeting|email|post_engagement|note, direction: outbound|inbound|mutual|none, occurredAt, subject?, body?, externalId?, threadId?, sourceRef?, participants: [{ personId, role: sender|recipient|attendee|mentioned|member }], includeMe?: true }` |
| DELETE | `/interactions/:id` | |

Interactions with more than two distinct participants are marked as group interactions. Group interactions are context only and add no edges to the network.

### Follow-ups
| Method | Path | Body |
| --- | --- | --- |
| GET | `/followups?state=open|done|snoozed|dismissed&personId=&dueBefore=` | |
| POST | `/followups` | `{ personId, reason, dueAt?, interactionId?, projectId? }` |
| PATCH | `/followups/:id` | `{ state?, dueAt?, reason? }` |

The `suggest-followups` job adds `origin: "suggested"` follow-ups for 1:1 messages received more than 3 days ago that have no reply.

---

## Network (people-only)

### `GET /network/graph?projectId=&includeProposed=true&includeInterestLinks=false&includeArchived=false&minStrength=0`
```json
{
  "selfId": "per_…",
  "nodes": [{ "id", "label", "isSelf", "status", "organization", "interests", "platforms", "tieStrength", "lastInteractionAt",
              "interactionCount", "pageRank", "bridgeScore", "community", "openOpportunities", "pendingDrafts", "openFollowups", "projectIds" }],
  "edges": [{ "id", "kind": "relationship|interaction|proposed", "from", "to", "directed", "establishesRelationship",
              "strength", "label", "explanation", "evidence": [ … ] }],
  "ties": [{ "a", "b", "strength", "directedOnly" }],
  "communities": [{ "id", "size", "members" }],
  "interestLinks": [{ "a", "b", "sharedInterests", "similarity", "establishesRelationship": false, "explanation" }],
  "legend": { … }
}
```
- Nodes are people only. `projectId` filters the people without adding project nodes.
- `relationship` edges come from observed or confirmed relationships. `interaction` edges come from 1:1 interactions. `proposed` edges are open opportunities (draw them dashed) and set `establishesRelationship: false`.
- `interestLinks` are a separate layer and never mean that two people know each other.
- Every edge carries an `explanation` and the IDs of the records behind it.

### `GET /network/recommendations?limit=10&dormantDays=60`
Returns "who to reach out to next", grouped by kind:
- `engage`: the best open opportunity per person. Score = relevance × (1 + 0.3 × tie strength).
- `reconnect`: dormant ties (no interaction for `dormantDays` or more) whose past conversations share keywords with a project that changed since. This is the product's "a past contact's question becomes relevant again" scenario.
- `followups`: open follow-ups due within 7 days, with an `overdue` flag.
- `introductions`: cold prospects reachable through someone you know, with the path's warmth and the reason for each hop.
- `bridges`: people who connect otherwise separate groups in your network.

### `GET /network/paths/:personId` (alias `GET /people/:id/paths`)
Up to `k` warm paths from you to the person, using only relationship and interaction ties. Each path has `warmth` (the product of tie strengths), `people`, and `steps[{ from, to, strength, because[] }]`.

### `GET /network/stats`
Returns counts by status and edge kind, the number of communities and the average tie strength.

### Algorithms
| Measure | Method |
| --- | --- |
| Tie strength | Σ interaction weight × 2^(−age/180 days). Weights: meeting 3, reply received 1.2-1.6, message sent 0.6-0.8, comment 0.4-0.9, engagement 0.1-0.4. The sum is ×1.5 when the conversation is reciprocal. Relationship base: mentor 2, colleague 1.5, classmate 1.2, connection 0.8, introduced 0.6, follows 0.25, scaled by verification. Strength = 1 − e^(−raw/3). |
| Influence | Weighted PageRank (d = 0.85) on the combined tie graph. |
| Communities | Deterministic weighted label propagation on the graph **without you**, so the ego node does not merge everything into one group. Singletons get `community: null`. |
| Bridges | Brandes betweenness (distance = −ln strength) on the graph without you. |
| Paths | Dijkstra with cost −ln(strength), so the best path maximizes the product of tie strengths, plus alternatives that avoid each intermediary in turn. |
| Opportunity relevance | (0.40 × semantic + 0.35 × keyword + 0.25 × scenario intent) × √freshness × openness × requirement fit × duplicate penalty. Surfaced only at relevance ≥ 0.3 with lexical evidence or strong semantic similarity. |

---

## Imports

### `POST /imports/linkedin-archive`
```json
{ "path": "/Users/me/Downloads/Basic_LinkedInDataExport_11-07-2026", "selfProfileUrl": "https://www.linkedin.com/in/me" }
```
You can also send `{ "files": { "Connections.csv": "…", "messages.csv": "…" } }`. Imports first-degree connections as mutual relationships with `verificationSource: "archive_import"`. Messages become threaded interactions, with direction worked out from your profile URL; if `selfProfileUrl` is omitted, it is inferred as the profile present in nearly every conversation. Re-importing does not create duplicates. Returns the counts and any warnings.

This is the accepted fallback while authorized live LinkedIn access is unavailable. It does not provide public-post discovery.

---

## Markdown vault (Obsidian-compatible)

### `GET /vault` · `POST /vault/sync`
The vault lives in `RESONA_VAULT_DIR`, which defaults to `<data dir>/vault`. Point it at a folder inside your Obsidian vault to browse the network there.

```
Resona Home.md          dashboard: projects, follow-ups
People/<Name>.md        frontmatter + profiles, relationships, projects, conversations, follow-ups, ## Notes
Projects/<Name>.md      versioned summary, results with evidence, limitations, open questions, people
Conversations/<date> <who>.md   one note per thread
Drafts/…                read-only mirror of active drafts
Reviews/Weekly review <date>.md
```

Sync rules:
- Generated content sits between `%% resona:generated:start %%` and `%% resona:generated:end %%`, which Obsidian hides in reading view. Everything outside the markers belongs to you and is preserved.
- Changes to a person note are imported back into the database: the `## Notes` section and the frontmatter keys `organization`, `title`, `location` and `interests`. Frontmatter keys you add are kept.
- `[[wikilinks]]` you type are recorded as mentions (`vaultMentions` on the person). They are never treated as relationships.
- Renamed or moved notes are tracked through the `resona_id` frontmatter key.
- When a record is deleted, its note is removed only if you have not edited it.

---

## Weekly reviews

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/reviews?limit=` | |
| POST | `/reviews` | Generates a review now: activity, project changes, questions for you, the review queue (awaiting approval, stale, uncertain), top new opportunities, reconnects and follow-ups. Includes `markdown`. |
| GET | `/reviews/:id` | |
