# Local-first networking and professional presence agent

**Reference date:** November 7, 2026  
**Status:** Product reference approved by the user following the product discussion and grilling interview. Implementation recommendations and unresolved prerequisites remain explicitly identified below.  
**Working name:** Not selected.

## 1. Product intent

Build a standalone Mac application that helps students and early-career people become known for their work and build professional relationships.

The app learns from project folders selected by the user, finds relevant conversations, and prepares useful public contributions or individualized outreach. It remembers subsequent interactions so that an initial exchange can develop into an ongoing connection.

The user emphasized influence and connections as the primary outcomes. Finding users for a project, collaborators, mentors, or career opportunities can follow from these relationships, but the product is not primarily a sales-outreach tool.

The intended product is an independent application with its own interface, local memory, and workflow. It is not a skill or plugin that requires users to operate Codex or Claude Code. MCP can still be used internally to connect the app to services.

## 2. Latest user decisions

These decisions supersede earlier alternatives and assistant recommendations.

| Area | User decision |
| --- | --- |
| Initial audience | Students and early-career people. |
| Primary outcome | Improve professional influence and build connections with other people. |
| Application | Standalone Mac app, with a dashboard and network visualization. |
| Main storage | Local to the Mac; use third-party model APIs for AI processing. |
| Folder organization | Users add multiple project folders separately. A CV can later be supplied through a separate folder. |
| Folder processing | Analyze added folders and meaningful changes automatically; also provide a weekly review. |
| AI permission | Permission per folder, with exclusions and processing history. |
| Missing facts | Ask targeted questions about the user's contribution or unclear results. |
| Outward actions | Let users read, edit, and choose updates before sending. Never automatically send or publish. |
| Platform priority | LinkedIn discovery first; resolving authorized access is a prerequisite. |
| Existing-network import | Offer an optional scan/import with little handwritten context. A user-downloaded LinkedIn archive is an acceptable fallback if direct access is unavailable. |
| Additional context | Optional Gmail, calendar, and selected local files, each with separate permissions. |
| Mac unavailable | Pause processing and catch up when the Mac becomes available. |
| Network visualization | People only. Selecting a person reveals connected projects, conversations, shared interests, and relationship history. |
| Phase 1 | Four-step outreach, standalone LinkedIn/X post drafts, and relationship tracking. |
| Phase 2 | A separate master career record containing CV-worthy experiences; display it in the app and generate tailored CVs from it. |

### Important scope correction

The user initially included CV updates alongside outreach and standalone posts in v1. The latest instruction moves the master CV feature to a second phase after the first function is developed. It is a separate record of career experiences, not a contact list.

## 3. The four-step outreach workflow

### Step 1: Summarize project context

Read the user-selected folder and identify:

- The problem the project addresses and the intended audience.
- What was built, researched, or written.
- The user's individual contribution.
- Supported results, milestones, and lessons.
- Current capabilities and limitations.
- Supporting evidence and material appropriate to share.

Keep the context current as files change. Ask brief clarification questions when files do not establish personal contribution or results. A file change is a signal to investigate; it is not proof that a project is complete or a result has improved.

### Step 2: Find relevant outreach scenarios

Generate keywords, related concepts, and search phrases from project context. Find conversations where the user's actual work gives them a specific reason to contribute.

Preserve the source post, author, publication date where available, and the reason for the match. Search coverage depends on authorized source access, not merely on the model's reasoning ability.

### Step 3: Draft individual outreach and propose a shortlist

For each candidate, show:

- The person and original conversation.
- Why the match is relevant.
- Which project and evidence support the contribution.
- An appropriate channel and next action: public reply, personal message, question, demo, or collaboration proposal.
- An editable, individualized draft.

Rank by the relevance and usefulness of the contribution. Topic similarity alone is insufficient: the project must fit the actual requirement, and the conversation should still offer a useful opening.

### Step 4: User chooses; record progress and update the network

The user chooses which replies or messages to send. No autonomous sending or publication.

Record the resulting action and its source. Add newly discovered people as prospects or update existing contacts. Track replies, conversations, follow-up reasons, and connection status when observable or user-confirmed.

An approved draft, a sent message, a received reply, and an accepted platform connection are different events. Do not collapse them into one generic connected state.

## 4. Outreach scenarios discussed

| Trigger | Useful contribution | Possible outcome |
| --- | --- | --- |
| Someone describes a problem the project addresses | Explain the relevant capability, share a demo, and state limitations. | Feedback, a new user, or a professional exchange. |
| Someone wishes a tool or implementation existed | Show what the user actually implemented and ask which requirements matter. | Product discussion or collaboration. |
| Someone asks for recommendations | Compare the project's capabilities with their requirements honestly. | A qualified conversation or user. |
| Someone describes a cumbersome manual workflow | Demonstrate a specific step the project could simplify. | A pilot or discovery conversation. |
| Someone builds an adjacent product | Offer a complementary component, dataset, integration, or experiment. | Collaboration. |
| Someone asks a technical question the user has encountered | Share a tested approach, results, or a reproducible example. | Credibility and a new connection. |
| Someone publishes a method the user applied | Credit the original work and report the application and findings. | A conversation with the author. |
| Someone requests examples or case studies | Contribute a documented example. | Visibility or inclusion in their work. |
| An open-source issue overlaps with the user's work | Offer a relevant explanation, reproducible example, or contribution. | Contributor relationships. |
| A role or hiring discussion resembles the user's project | Connect a specific requirement to demonstrated work. | A career conversation. |
| Someone explicitly seeks collaborators or expertise | Show relevant experience and suggest a bounded contribution. | A joint project. |
| A past contact's question becomes relevant again | Share a new result that addresses the earlier conversation. | A natural follow-up. |

The agent should distinguish requests for help from frustration, resolved discussions, or conversations where a promotional reply would add little value. It should check for previous outreach to avoid duplicates.

## 5. Standalone professional updates

Phase 1 also includes LinkedIn/X post drafts based on meaningful project developments.

Potential material includes a milestone, useful finding, method, demo, failure and lesson, or a documented result. Drafts should reflect the user's contribution and perspective, with source references available for review.

Not every change warrants a public post. The user reviews and edits every outward-facing update. Publishing capability must use an authorized integration; copy-and-send or manual publication can be a fallback where the integration does not support the action.

## 6. Local-first architecture

### Proposed components

1. **Mac app:** folder onboarding, review workflow, dashboard, person detail, and network visualization.
2. **Local database:** projects, extracted context, people, opportunities, drafts, interactions, and relationship state.
3. **Local ingestion:** file parsing, change detection, incremental processing, and source references.
4. **Search:** structured queries plus keyword search and optional embeddings/vector search.
5. **Agent orchestration:** discovery, matching, drafting, and follow-up proposals using selected context.
6. **Connectors:** approved platform APIs or MCP servers with per-source authorization.
7. **Scheduling:** local work while the Mac is available, with catch-up and weekly reviews.

This architecture is a recommendation, not an implemented system or a finalized framework selection.

### Local storage and external processing

The main database remains on the Mac. Selected excerpts can still leave the device when sent to model APIs, remote MCPs, or other service providers. Do not describe this as fully on-device AI or promise that all data always remains on the laptop.

The selected permission model is per folder, with exclusions and processing history. Suggested exclusions include credentials, generated output, dependencies, and temporary files.

The agent does not need to train a foundation model or continuously run an LLM. Store durable memory in the app's database and retrieve relevant context for each task. Scheduled software can trigger model calls when interpretation or generation is required.

Local embeddings were proposed as a way to perform semantic search without sending every search to an external service. Embedding implementation and model choice remain open.

### Background behavior

Closing a dashboard window need not stop all local background work. Sleeping or powering off the Mac does limit execution. The agreed product behavior is to pause and catch up after the Mac becomes available. Pre-scheduled system notifications are distinct from executing a new AI task.

### Commercial and model-access options

Two options were discussed:

- Users supply their own model API keys: less vendor infrastructure, more onboarding friction.
- The subscription includes model usage: smoother onboarding, usually requiring protected provider credentials and request metering through a service.

The assistant recommended subscription-included usage for students. The user has not chosen a billing model, API-key model, or backend arrangement. Any request proxy would process selected context even if it did not retain the relationship database.

## 7. Local folders and project understanding

The user chose folder ingestion as the main experience. Voice notes, manual evidence uploads, repository events, and weekly check-ins were explored as alternatives or supplements; they are not all launch requirements.

The latest folder model is multiple separately added folders. The app should produce value from a project folder before requiring extensive profile entry or every account connection.

Suggested ingestion behavior:

- Initial scan followed by incremental reprocessing of meaningful changes.
- Track file hashes and source versions.
- Consolidate multiple changes into the existing project record.
- Retain evidence for claims and mark uncertainty.
- Ask only for facts not established by the source material.
- Update or flag affected drafts when project context changes.

Persistent user-selected folder access and file-change notifications are supported by macOS, subject to permissions. Exact supported file types, parser stack, and folder exclusion controls remain to be designed.

## 8. Platform integration findings

**Research status:** Documentation/repository review only. No OAuth application, partner approval, account connection, permission grant, or live endpoint test has been completed.

### Gmail

- Google's official remote Gmail MCP is documented as developer preview. Its listed tools cover search, reading threads, drafts, and labels; the reviewed tool list does not include sending.
- Community local MCP servers exist. ArtyMcLabin/Gmail-MCP-Server advertises reading, searching, drafting, sending, replies, and attachments and uses an MIT license.
- Product integration still needs authorization, token handling, scope selection, and appropriate review. A repository is not a turnkey consumer onboarding experience.

### LinkedIn: access is a prerequisite

The user selected LinkedIn-first discovery. This must not silently become X-first or manual-only discovery.

Verified distinctions from official documentation:

- Ordinary self-service permissions cover the authenticated user's profile/email and post/comment/like actions through Share on LinkedIn. They do not provide a general connection list, inbox, or arbitrary public-post search.
- A restricted Connections API exists for approved developers. It concerns the consenting user's first-degree connections; access for this product is unconfirmed.
- No generally available consumer inbox permission or arbitrary public-post keyword-search/feed API was established in this research.
- LinkedIn's user-download archive can contain first-degree connections and sent/received/archived messages. Availability of connection emails depends on settings. This provides an import route, not continuous live scanning.
- The third-party Member Data Portability program requires approval and business verification. Its specific documentation limits consent to EEA users; it does not solve onboarding for US users.
- Geographic documentation differs for Switzerland: member self-download documentation includes Switzerland, while the specific third-party developer page says EEA. Confirm third-party Switzerland eligibility before claiming support.
- Unauthorized website scraping or automation is not made permissible by wrapping it in MCP.

**Accepted fallback:** optional user-downloaded archive import with minimal handwritten context.

**Still unresolved:** an authorized, sufficient route for automatic LinkedIn discovery and any desired live network scanning. Archive import does not resolve public-post discovery.

A community official-API wrapper, souravdasbiswas/linkedin-mcp-server, advertises publishing and related operations. It does not unlock restricted platform permissions or general people search/inbox access.

### X

X documents an official hosted MCP for post/user search, timelines, bookmarks, trends/news, and Articles. Its documented hosted capabilities do not include creating ordinary short posts. A separate supported API integration may be needed for that action.

Developer setup, authorization, platform costs/limits, and automation rules still apply. Automatic discovery and drafting are separate from publishing or unsolicited replies.

### Other possible sources

GitHub issue/PR search and permitted community sources were discussed as useful sources for technical questions and collaboration opportunities. They are possible supplements, not replacements for the user's LinkedIn-first priority.

### Role of MCP

The Mac app can host an MCP client. Local MCP helpers can run on the user's computer; remote MCPs send requests to their operators. Users should interact with the product's account-connection flow rather than manually configure developer tools.

Use direct APIs where they are simpler or necessary. MCP does not bypass API permissions, expose unsupported actions, or guarantee production readiness.

## 9. Database proposal

**Status:** Assistant recommendation. The user agreed to review this product understanding; no schema or database implementation has been approved or created.

Recommended foundation: SQLite for structured records, full-text search for exact terms, and an optional vector index for semantic matching. A dedicated graph database is not initially necessary.

### Proposed core tables

| Table | Purpose and important fields |
| --- | --- |
| `people` | One identity per person, including the app user: ID, name, bio, organization, notes. |
| `person_profiles` | Multiple platform identities per person: platform, external user ID, handle, URL. |
| `relationships` | Observed or user-confirmed relationship between people: endpoints, type, direction, platform, observed time, verification source. |
| `projects` | Separately added project folders: name, persistent folder reference, status, scan time. |
| `project_files` | Source files: relative path, hash, modification time, extracted text, processing state. |
| `project_contexts` | Versioned project summaries: capabilities, limitations, keywords, contribution, results. |
| `source_posts` | Discovery evidence: platform ID, author profile, URL, text, publication and retrieval dates. |
| `opportunities` | Person + source post + project-context version + scenario, match reason, relevance, review state. |
| `outreach_drafts` | Individual drafts and revisions, linked to opportunities and destinations. |
| `outreach_actions` | Approval and execution state: exact draft revision/destination, approval time, sent time, external message ID, error. |
| `interactions` | Actual messages, replies, comments, and meetings, with external IDs and thread/source references. |
| `interaction_participants` | People and their roles within an interaction, including groups. |
| `followups` | Contact, triggering interaction/project, reason, due date, and state. |

Supporting design work will be needed for source/claim evidence links, identity merges, standalone post drafts, ingestion runs, search history, and connector metadata. External tokens should be handled through appropriate credential storage rather than treated as normal graph data.

The original table proposal primarily described outreach. Phase 1 standalone posts also need versioned content drafts and approved publication actions, either through generalized draft/action tables or dedicated post tables. That choice remains open.

### Identity and progress rules

- Deduplicate platform profiles using stable platform IDs where available. Do not merge people by name alone.
- Preserve direction: following someone is different from being followed.
- Keep opportunity review, sending, responses, and platform connection status separate.
- Suggested opportunity states: new, shortlisted, dismissed, acted on.
- Suggested action states: awaiting approval, approved, queued, sent, failed, uncertain.
- Approval applies to a specific content revision and destination; edits require renewed review.
- Reconcile uncertain sends before retrying to avoid duplicates.
- Keep source evidence for relationship assertions. Similar interests do not establish that two people know each other.
- Treat group participation as context; do not automatically infer a personal relationship between every participant.

### Semantic search

Proposed supporting records:

- `content_chunks`: source reference, text, and content hash.
- `embeddings`: chunk ID, embedding model/version, and vector/index reference.

Vectors help match different wording in posts and projects. They are not the source of truth for identity, dates, sent status, completed commitments, or verified relationships.

## 10. People-only network visualization

**Latest decision:** display people only. Earlier suggestions to display project nodes are superseded.

Selecting a person should reveal:

- Their linked platform profiles.
- The source of discovery and the relevant post.
- Associated projects and evidence.
- What the user and person have discussed.
- Shared interests and how those were established.
- Pending drafts, previous outreach, replies, and follow-up opportunities.
- Observed platform connection status where available.

Suggested visual semantics, still a design proposal:

- Differentiate a proposed outreach link, an actual interaction, and an observed/confirmed relationship.
- Indicate direction where it matters.
- Explain each link from its supporting record.
- Keep people sharing an interest separate from a claim that those people know each other.
- Let users filter by project/topic without introducing project/topic nodes into the main people-only web.

The imported/discovered graph may initially be centered on the user. Do not fabricate person-to-person links to make it appear more interconnected. Distinct relationship types and derived interaction summaries can supply edges for the visualization.

## 11. Phase 2: master career record and tailored CVs

This is a separate feature to develop after the first function.

- Treat existing CV material as another separately added folder.
- Build a master record of all experiences the user could put on a CV: projects, work, research, education, activities, skills, contributions, and supported results.
- Make the master list directly viewable in the app.
- Generate a dedicated/tailored CV when the user needs one, selecting relevant experiences from the master record.
- This master list is not the user's professional contact list.
- Continue grounding claims in evidence and asking for unclear personal contributions.

Exact CV input/output formats, tailoring inputs, layout system, and editing/export behavior remain unspecified.

## 12. Startup comparisons researched

Descriptions below summarize advertised capabilities and public disclosures, not hands-on tests or proof of business performance.

| Company | Relevance |
| --- | --- |
| Dex, YC S19 | Close personal-CRM competitor: contacts, notes, keep-in-touch reminders, integrations, research briefings, voice/notetaker features, and a Mac app. Its hosted database differs from the proposed local-first storage. Mac + AI + reminders alone are not a clear distinction. |
| Happenstance, YC W24 | Searchable professional networks and warm introduction paths. Demonstrates packaging around finding relevant people. |
| Circleback, YC W24 | Meeting notes, action items, search, and downstream automations. Demonstrates using a conversation as a workflow trigger. |
| Orchid, YC Spring 2025 | Messaging-based assistant with connected tools and recurring routines. Demonstrates an assistant reachable through existing communication channels. |
| Streak, YC S11 | CRM inside Gmail. Demonstrates placing context within an existing communication workflow. |
| Simplify, YC-backed | Broader career platform with networking, outreach, alumni/referral paths, and job-linked tracking. Relevant competition for students and job seekers. |

### Model disclosures checked

- **Dex:** its privacy policy names OpenAI for generation/summarization, OpenRouter for routing, and Deepgram for voice transcription. Exact model versions were not established.
- **Orchid:** its privacy policy lists OpenAI, Anthropic, Google Vertex AI, and OpenRouter. Personal-model language in its policy does not establish the implementation details of per-user training.
- **Circleback:** its privacy policy discloses AI-model and transcription providers; exact providers were not established from the reviewed public material.
- **Streak:** a June 2025 engineering article documents OpenAI API use and product-side processing to produce reliable citations. Its complete current model stack was not established.
- **Simplify:** its policy describes external model/inference providers and its own recommendation/ranking/matching systems. This is not proof that it trained a foundation model.
- **Happenstance:** underlying model providers remained unverified in readable first-party material during the main discussion; its trust center was not readable through the research tool.

No verified evidence was established that these six primarily run their language models on users' devices. A desktop app does not imply on-device model inference.

## 13. Alternatives discussed and their current status

| Alternative or suggestion | Current status |
| --- | --- |
| Web app with email assistance | Earlier assistant recommendation; superseded by the user's standalone Mac preference. |
| Messaging-first concierge | Explored packaging alternative; not selected. |
| Gmail sidebar as the main product | Explored alternative; not selected as the main interface. |
| X-first launch | Assistant recommendation based on access; rejected by the user's LinkedIn-first priority. |
| One workspace root containing all projects | Not selected; users add folders separately. |
| One project per folder | Earlier assistant proposal; folder granularity beyond separate additions is not rigidly finalized. |
| People plus project nodes in the graph | Superseded by people-only visualization. |
| CV in v1 | Superseded by phase-2 deferral. |
| Voice/manual updates as primary ingestion | Superseded by folder-led ingestion; possible optional supplements. |
| Always-on cloud execution | Not selected for initial behavior; pause/catch-up is selected. |

## 14. Success measures and commercial hypotheses

The user selected influence and connections as the main goals. Suggested measures are relevant engagement, substantive replies, repeat conversations, accepted connections where observable, and invitations/collaborations. Follower counts can be supplementary. These are proposed measures, not finalized KPIs.

Earlier commercial ideas included a consumer subscription, a recruiting-season pass, and later sponsorship through clubs or career services. Assistant-proposed price tests were $8–12/month or $25–40 per recruiting season. These are unvalidated hypotheses from the earlier recruiting framing, not agreed pricing for the current influence-focused product.

An earlier proposed pilot involved 15–20 users from one cohort for four weeks. No pilot, market validation, pricing test, or customer commitment has occurred in this discussion.

## 15. Open questions and implementation prerequisites

### Required to prove the chosen product

1. Establish an authorized, commercially usable route for LinkedIn-first discovery with sufficient coverage.
2. Determine whether live LinkedIn connection access is obtainable; retain archive import as the accepted fallback.
3. Validate that folder-derived context yields useful, specific contributions and relationship opportunities.

### Design and engineering choices not yet settled

- Framework, native/cross-platform approach, model provider, and embedding implementation.
- Exact supported files and handling of very large or nested folders.
- Weekly review timing and notification preferences.
- Permission and exclusion interface, public/shareable evidence controls, and content retention.
- Standalone post drafting/publishing schema and supported publication routes.
- Identity merge/correction workflow and evidence storage details.
- Discovery cadence, search budget, ranking, and recommendation volume.
- Graph layout, filters, and how to visualize different relationship types.
- Backup, restore, encryption/key management, and future multi-device support.
- Subscription, included model usage, and any minimal backend.
- Final KPIs, pricing, and first pilot cohort.

These are explicitly open rather than assumed approvals. This document is a reference and product proposal, not an implementation plan.

## 16. Source references

Sources were consulted in the conversation or the follow-up LinkedIn access check. Platform capabilities can change. No integrations were tested live.

### Product and startup references

- [Dex YC profile](https://www.ycombinator.com/companies/dex)
- [Dex product](https://getdex.com/)
- [Dex feature/pricing page](https://getdex.com/pricing/)
- [Dex desktop app](https://getdex.com/desktop/)
- [Dex security](https://getdex.com/security/)
- [Dex privacy and model providers](https://getdex.com/privacypolicy/)
- [Happenstance YC profile](https://www.ycombinator.com/companies/happenstance)
- [Happenstance product](https://happenstance.ai/)
- [Happenstance trust center](https://trust.happenstance.ai/)
- [Circleback YC profile](https://www.ycombinator.com/companies/circleback)
- [Circleback privacy](https://circleback.ai/privacy)
- [Circleback security documentation](https://circleback.ai/docs/support/security/security)
- [Orchid YC profile](https://www.ycombinator.com/companies/orchid-ai)
- [Orchid product](https://orchid.ai/)
- [Orchid privacy and subprocessors](https://orchid.ai/legal/privacy)
- [Streak YC history](https://www.ycombinator.com/blog/streakcom-yc-s11-takes-on-salesforce-with-a-s)
- [Streak product](https://www.streak.com/)
- [Streak engineering: model output and citations](https://engineering.streak.com/p/preventing-unstyled-markdown-streaming-ai)
- [Simplify YC profile](https://www.ycombinator.com/companies/simplify)
- [Simplify networking](https://simplify.jobs/networking)
- [Simplify privacy](https://simplify.jobs/privacy)

### Connectors and platform access

- [Google: configure Gmail MCP, developer preview](https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server)
- [Community Gmail MCP](https://github.com/ArtyMcLabin/Gmail-MCP-Server)
- [Community LinkedIn official-API MCP wrapper](https://github.com/souravdasbiswas/linkedin-mcp-server)
- [LinkedIn API access and open permissions](https://learn.microsoft.com/en-us/linkedin/shared/authentication/getting-access)
- [LinkedIn restricted Connections API](https://learn.microsoft.com/en-us/linkedin/shared/integrations/people/connections-api)
- [LinkedIn Messages API](https://learn.microsoft.com/en-us/linkedin/shared/integrations/communications/messages)
- [LinkedIn Compliance FAQ](https://learn.microsoft.com/en-us/linkedin/compliance/compliance-api/compliance-faq)
- [LinkedIn Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api)
- [LinkedIn account-data download](https://www.linkedin.com/help/linkedin/answer/a1339364/down-your-account-data)
- [LinkedIn third-party Member Data Portability](https://learn.microsoft.com/en-us/linkedin/dma/member-data-portability/member-data-portability-3rd-party/)
- [LinkedIn member self-download API](https://learn.microsoft.com/en-us/linkedin/dma/member-data-portability/member-data-portability-member/)
- [LinkedIn general portability Help](https://www.linkedin.com/help/sales-navigator/answer/a6214075)
- [LinkedIn prohibited software and extensions](https://www.linkedin.com/help/linkedin/answer/a1341387/prohibition-of-scraping-software)
- [X official MCP documentation](https://docs.x.com/tools/mcp)
- [X automation rules](https://help.x.com/en/rules-and-policies/x-automation)
- [GitHub issue and PR search](https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests)
- [GitHub event types](https://docs.github.com/en/rest/using-the-rest-api/github-event-types)
- [Official Hacker News API](https://github.com/HackerNews/API)

### Local architecture and storage

- [Apple: access user-selected files](https://developer.apple.com/documentation/security/accessing-files-from-the-macos-app-sandbox)
- [Apple: file-system events](https://developer.apple.com/documentation/coreservices/file_system_events)
- [Apple: background activity scheduler](https://developer.apple.com/documentation/foundation/nsbackgroundactivityscheduler)
- [Apple: scheduling and sleep behavior](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/ScheduledJobs.html)
- [Apple: local notifications](https://developer.apple.com/documentation/UserNotifications/scheduling-a-notification-locally-from-your-app)
- [SQLite file format](https://sqlite.org/fileformat.html)
- [SQLite full-text search](https://sqlite.org/fts5.html)
- [SQLite foreign keys](https://sqlite.org/foreignkeys.html)
- [SQLite recursive and graph queries](https://sqlite.org/lang_with.html)

## 17. Review checkpoint

The user requested this Markdown file to inspect the product understanding. Review should focus on scope, the LinkedIn acquisition prerequisite, and the distinction between user decisions and proposed implementation details.

**Final confirmation:** The user accepted this reference on November 7, 2026. This confirms the product understanding; it does not resolve the open technical prerequisites or approve every proposed implementation detail.
