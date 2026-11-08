import { z } from "zod";
import type { Db } from "../db/database.ts";
import type { ContentIndex } from "../search/index.ts";
import type { AiService } from "../ai/client.ts";
import type { ProjectService } from "./projects.ts";
import type { PeopleService, ProfileInput } from "./people.ts";
import { badRequest, conflict, newId, notFound, nowIso, parseJson } from "../lib/util.ts";
import { isWorthSurfacing, scoreMatch, type ProjectProfile } from "../matching/matcher.ts";
import { centroid } from "../search/embeddings.ts";
import { summarizeSituation } from "../matching/situation.ts";
import { scenarioInfo, type Scenario } from "../matching/scenarios.ts";

export interface SourcePostInput {
  platform: string;
  externalId: string;
  url?: string | null;
  title?: string | null;
  text: string;
  publishedAt?: string | null;
  connector: string;
  query?: string | null;
  engagement?: Record<string, number>;
  author?: ProfileInput & { bio?: string | null; organization?: string | null };
}

const OPPORTUNITY_TRANSITIONS: Record<string, string[]> = {
  new: ["shortlisted", "dismissed", "acted_on"],
  shortlisted: ["new", "dismissed", "acted_on"],
  dismissed: ["new", "shortlisted"],
  acted_on: [],
};

const AssessmentSchema = z.object({
  fits: z.boolean().describe("True only if the project genuinely meets what the author needs and a reply would add value."),
  scenario: z.string(),
  reason: z.string().describe("One or two sentences, specific to the post and the project."),
  situation: z.string().describe("One plain sentence, at most 25 words: what the author is asking for or doing. No praise, no mention of the user's project."),
  suggested_channel: z.enum(["public_reply", "direct_message", "email", "comment"]),
  suggested_action: z.enum(["public_reply", "personal_message", "question", "demo", "collaboration_proposal"]),
  relevance: z.number().describe("0 to 1."),
  cautions: z.array(z.string()),
});

/**
 * Steps 2-3 of the workflow: store discovered conversations with their authors, match them against
 * project contexts and keep a ranked, deduplicated list of opportunities.
 */
export class OpportunityService {
  constructor(
    private readonly db: Db,
    private readonly index: ContentIndex,
    private readonly projects: ProjectService,
    private readonly people: PeopleService,
    private readonly ai: AiService,
  ) {}

  /** Stores a discovered post (idempotent on platform + external id) and its author as a prospect. */
  ingestPost(input: SourcePostInput): { postId: string; created: boolean; authorPersonId: string | null } {
    if (!input.text.trim()) throw badRequest("post text is required");
    return this.db.tx(() => {
      let authorProfileId: string | null = null;
      let authorPersonId: string | null = null;
      if (input.author && (input.author.externalId || input.author.url || input.author.handle || input.author.displayName)) {
        const { person, profileId } = this.people.upsertByProfile(
          { ...input.author, platform: input.author.platform || input.platform, source: input.connector },
          {
            displayName: input.author.displayName ?? input.author.handle ?? "Unknown",
            bio: input.author.bio ?? input.author.headline,
            organization: input.author.organization,
          },
        );
        authorProfileId = profileId;
        authorPersonId = person.id;
      }
      const existing = this.db.get<{ id: string }>(
        "SELECT id FROM source_posts WHERE platform = ? AND external_id = ?",
        [input.platform, input.externalId],
      );
      if (existing) {
        this.db.run(
          `UPDATE source_posts SET text = ?, title = COALESCE(?, title), engagement = ?, retrieved_at = ?,
             author_profile_id = COALESCE(author_profile_id, ?), author_person_id = COALESCE(author_person_id, ?) WHERE id = ?`,
          [input.text, input.title, input.engagement ?? {}, nowIso(), authorProfileId, authorPersonId, existing.id],
        );
        this.index.indexSource("source_post", existing.id, `${input.title ?? ""}\n${input.text}`);
        return { postId: existing.id, created: false, authorPersonId };
      }
      const id = newId("post");
      this.db.run(
        `INSERT INTO source_posts (id, platform, external_id, author_profile_id, author_person_id, url, title, text, published_at, retrieved_at, connector, query, engagement)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id, input.platform, input.externalId, authorProfileId, authorPersonId, input.url, input.title, input.text,
          input.publishedAt, nowIso(), input.connector, input.query, input.engagement ?? {},
        ],
      );
      this.index.indexSource("source_post", id, `${input.title ?? ""}\n${input.text}`);
      return { postId: id, created: true, authorPersonId };
    });
  }

  getPost(id: string) {
    const row = this.db.get<Record<string, unknown>>("SELECT * FROM source_posts WHERE id = ?", [id]);
    if (!row) throw notFound("source post");
    return row;
  }

  listPosts(opts: { platform?: string; limit?: number } = {}) {
    return this.db.all(
      "SELECT * FROM source_posts WHERE (? IS NULL OR platform = ?) ORDER BY retrieved_at DESC LIMIT ?",
      [opts.platform ?? null, opts.platform ?? null, opts.limit ?? 100],
    );
  }

  private activeProfiles(projectIds?: string[]): ProjectProfile[] {
    const ids = projectIds ?? this.projects.list({ kind: "project" }).filter((p) => p.status === "active").map((p) => p.id);
    return ids.map((id) => this.projects.profile(id)).filter((p): p is ProjectProfile => p !== null);
  }

  private contactHistory(personId: string | null): { isPastContact: boolean; previouslyContacted: boolean } {
    if (!personId) return { isPastContact: false, previouslyContacted: false };
    const selfId = this.people.selfId();
    const past = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM interaction_participants a JOIN interaction_participants b ON a.interaction_id = b.interaction_id
       WHERE a.person_id = ? AND b.person_id = ?`,
      [personId, selfId],
    );
    const recent = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM draft_actions a JOIN drafts d ON d.id = a.draft_id
       WHERE d.person_id = ? AND a.state IN ('approved','queued','sent','uncertain') AND a.updated_at >= ?`,
      [personId, new Date(Date.now() - 90 * 86_400_000).toISOString()],
    );
    return { isPastContact: (past?.n ?? 0) > 0, previouslyContacted: (recent?.n ?? 0) > 0 };
  }

  /** Scores one post against every active project and upserts opportunities that clear the bar. */
  matchPost(postId: string, opts: { projectIds?: string[]; threshold?: number } = {}): Array<{ opportunityId: string; projectId: string; relevance: number }> {
    const post = this.getPost(postId) as { id: string; text: string; title: string | null; platform: string; published_at: string | null; author_person_id: string | null };
    const selfId = this.people.selfId();
    if (post.author_person_id === selfId) return []; // never suggest replying to yourself
    const vec = centroid(this.index.sourceVectors("source_post", [postId])) ?? this.index.embedder.embed(post.text);
    const history = this.contactHistory(post.author_person_id);
    const out: Array<{ opportunityId: string; projectId: string; relevance: number }> = [];

    for (const profile of this.activeProfiles(opts.projectIds)) {
      const m = scoreMatch(
        { text: post.text, title: post.title, platform: post.platform, publishedAt: post.published_at },
        vec,
        profile,
        history,
      );
      const existing = this.db.get<{ id: string; state: string }>(
        "SELECT id, state FROM opportunities WHERE source_post_id = ? AND project_id = ?",
        [postId, profile.projectId],
      );
      if (!isWorthSurfacing(m, opts.threshold)) {
        continue;
      }
      const evidence = this.index
        .search(post.text, { sourceTypes: ["project_file"], projectIds: [profile.projectId], limit: 3 })
        .map((h) => {
          const file = this.db.get<{ rel_path: string }>("SELECT rel_path FROM project_files WHERE id = ?", [h.sourceId]);
          return { ref: `${file?.rel_path ?? h.sourceId}:${h.startLine}-${h.endLine}`, excerpt: h.text.slice(0, 280), score: Number(h.score.toFixed(3)) };
        });
      const now = nowIso();
      const fields = [
        post.author_person_id, profile.contextId, m.scenario, m.reason, evidence, m.relevance,
        { ...m.breakdown, sharedTerms: m.sharedTerms, matchedPhrases: m.matchedPhrases, limitationConflicts: m.limitationConflicts },
        m.suggestedChannel, m.suggestedAction, m.flags, now,
      ];
      if (existing) {
        // Re-scoring never resurrects dismissed or acted-on opportunities.
        this.db.run(
          `UPDATE opportunities SET person_id = ?, project_context_id = ?, scenario = ?, match_reason = ?, evidence = ?, relevance = ?,
             score_breakdown = ?, suggested_channel = ?, suggested_action = ?, flags = ?, updated_at = ? WHERE id = ?`,
          [...fields, existing.id],
        );
        out.push({ opportunityId: existing.id, projectId: profile.projectId, relevance: m.relevance });
      } else {
        const id = newId("opp");
        this.db.run(
          `INSERT INTO opportunities (person_id, project_context_id, scenario, match_reason, evidence, relevance, score_breakdown,
             suggested_channel, suggested_action, flags, updated_at, id, source_post_id, project_id, state, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)`,
          [...fields, id, postId, profile.projectId, now],
        );
        out.push({ opportunityId: id, projectId: profile.projectId, relevance: m.relevance });
      }
    }
    return out;
  }

  /** Re-matches every stored post, e.g. after a project context changes. */
  rematchAll(opts: { projectIds?: string[]; sinceDays?: number } = {}): number {
    const since = new Date(Date.now() - (opts.sinceDays ?? 60) * 86_400_000).toISOString();
    const posts = this.db.all<{ id: string }>("SELECT id FROM source_posts WHERE retrieved_at >= ?", [since]);
    let n = 0;
    for (const p of posts) n += this.matchPost(p.id, { projectIds: opts.projectIds }).length;
    return n;
  }

  list(opts: { state?: string; projectId?: string; personId?: string; minRelevance?: number; limit?: number } = {}) {
    const rows = this.db.all<Record<string, unknown>>(
      `${OPPORTUNITY_SELECT}
       WHERE (? IS NULL OR o.state = ?) AND (? IS NULL OR o.project_id = ?) AND (? IS NULL OR o.person_id = ?) AND o.relevance >= ?
       ORDER BY o.relevance DESC LIMIT ?`,
      [
        opts.state ?? null, opts.state ?? null, opts.projectId ?? null, opts.projectId ?? null, opts.personId ?? null,
        opts.personId ?? null, opts.minRelevance ?? 0, opts.limit ?? 50,
      ],
    );
    return rows.map(opportunityToJson);
  }

  get(id: string) {
    const row = this.db.get<Record<string, unknown>>(`${OPPORTUNITY_SELECT} WHERE o.id = ?`, [id]);
    if (!row) throw notFound("opportunity");
    return opportunityToJson(row);
  }

  setState(id: string, state: string): void {
    const row = this.db.get<{ state: string }>("SELECT state FROM opportunities WHERE id = ?", [id]);
    if (!row) throw notFound("opportunity");
    if (row.state === state) return;
    if (!OPPORTUNITY_TRANSITIONS[row.state]?.includes(state)) {
      throw conflict(`cannot move an opportunity from ${row.state} to ${state}`);
    }
    this.db.run("UPDATE opportunities SET state = ?, updated_at = ? WHERE id = ?", [state, nowIso(), id]);
  }

  /** Optional model check of a single opportunity: does the project genuinely fit the request? */
  async assessWithAi(id: string) {
    const opp = this.get(id);
    const ctx = this.projects.latestContext(String(opp.projectId));
    if (!ctx) throw badRequest("project has no summary yet");
    const { data } = await this.ai.structured({
      purpose: "opportunity_assessment",
      projectIds: [String(opp.projectId)],
      inputRefs: [`opportunity:${id}`, `source_post:${opp.sourcePostId}`, `project_context:${ctx.id}`],
      system:
        "You judge whether a person's public post is a genuine opening for the user to contribute their project. Topic similarity alone is not enough: the project must meet what the author actually needs, and the conversation should still be open (not resolved, not hostile to suggestions). Be candid; recommending no reply is often correct.",
      user: `<post platform="${opp.post.platform}" published="${opp.post.publishedAt ?? "unknown"}">
${opp.post.title ? `${opp.post.title}\n` : ""}${opp.post.text}
</post>

<project name="${opp.projectName}">
Summary: ${ctx.summary}
Problem: ${ctx.problem ?? ""}
Capabilities: ${parseJson<string[]>(ctx.capabilities, []).join("; ")}
Limitations: ${parseJson<string[]>(ctx.limitations, []).join("; ")}
Results: ${parseJson<Array<{ claim: string }>>(ctx.results, []).map((r) => r.claim).join("; ")}
</project>

Heuristic pre-assessment: scenario=${opp.scenario}, flags=${opp.flags.join("; ") || "none"}.`,
      schema: AssessmentSchema,
      maxTokens: 4000,
    });
    const relevance = data.fits ? Math.max(0, Math.min(1, data.relevance)) : Math.min(opp.relevance, 0.1);
    this.db.run(
      `UPDATE opportunities SET match_reason = ?, situation = ?, suggested_channel = ?, suggested_action = ?, relevance = ?, flags = ?,
         state = CASE WHEN ? = 0 AND state = 'new' THEN 'dismissed' ELSE state END, updated_at = ? WHERE id = ?`,
      [data.reason, data.situation, data.suggested_channel, data.suggested_action, relevance, [...opp.flags, ...data.cautions], data.fits ? 1 : 0, nowIso(), id],
    );
    return { ...data, relevance };
  }
}

const OPPORTUNITY_SELECT = `SELECT o.*, sp.url AS post_url, sp.title AS post_title, sp.text AS post_text, sp.published_at AS post_published_at,
         sp.platform AS post_platform, p.display_name AS person_name, pr.name AS project_name
  FROM opportunities o
  JOIN source_posts sp ON sp.id = o.source_post_id
  JOIN projects pr ON pr.id = o.project_id
  LEFT JOIN people p ON p.id = o.person_id`;

export function opportunityToJson(row: Record<string, unknown>) {
  const scoreBreakdown = parseJson<Record<string, unknown>>(row.score_breakdown, {});
  const extracted = summarizeSituation(
    { text: String(row.post_text ?? ""), title: row.post_title as string | null, platform: String(row.post_platform), url: row.post_url as string | null },
    (scoreBreakdown.sharedTerms as string[] | undefined) ?? [],
  );
  return {
    id: String(row.id),
    state: String(row.state),
    relevance: Number(row.relevance),
    scenario: String(row.scenario),
    matchReason: String(row.match_reason),
    suggestedChannel: String(row.suggested_channel),
    suggestedAction: String(row.suggested_action),
    flags: parseJson<string[]>(row.flags, []),
    evidence: parseJson<Array<{ ref: string; excerpt: string }>>(row.evidence, []),
    scoreBreakdown,
    /** Short summary for the card; the AI fit check replaces the extracted gist with its own sentence. */
    situation: row.situation ? { headline: extracted.headline, gist: String(row.situation), source: "ai" as const } : { ...extracted, source: "extracted" as const },
    /** One line for the card: the AI fit check's own reason, or scenario · project · shared terms. */
    why: row.situation ? String(row.match_reason) : whyLine(String(row.scenario), row.person_name as string | null, row.project_name as string | undefined, (scoreBreakdown.sharedTerms as string[] | undefined) ?? []),
    suggestion: scenarioInfo(String(row.scenario) as Scenario).contribution,
    projectId: String(row.project_id),
    projectName: row.project_name as string | undefined,
    projectContextId: row.project_context_id as string | null,
    personId: row.person_id as string | null,
    personName: row.person_name as string | null,
    sourcePostId: String(row.source_post_id),
    post: {
      url: row.post_url as string | null,
      title: row.post_title as string | null,
      text: row.post_text as string,
      platform: row.post_platform as string,
      publishedAt: row.post_published_at as string | null,
    },
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function whyLine(scenario: string, person: string | null, project: string | undefined, shared: string[]): string {
  const label = scenarioInfo(scenario as Scenario).label; // written for one person: "asks for recommendations"
  return `${person?.split(/\s+/)[0] || "The author"} ${label}${project ? ` · fits ${project}` : ""}${shared.length ? ` · shared: ${shared.slice(0, 3).join(", ")}` : ""}`;
}
