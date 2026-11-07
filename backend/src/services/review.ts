import type { Db } from "../db/database.ts";
import type { NetworkService } from "../network/network.ts";
import type { RelationshipService } from "./relationships.ts";
import type { PeopleService } from "./people.ts";
import { newId, nowIso } from "../lib/util.ts";

/** Weekly review: what changed in projects and relationships, and what to do next. */
export class ReviewService {
  constructor(
    private readonly db: Db,
    private readonly network: NetworkService,
    private readonly relationships: RelationshipService,
    private readonly people: PeopleService,
  ) {}

  generate(now = new Date()) {
    const end = now.toISOString();
    const start = new Date(now.getTime() - 7 * 86_400_000).toISOString();
    const projectChanges = this.db.all<{ id: string; name: string; changed: number; contexts: number }>(
      `SELECT p.id, p.name,
              (SELECT COUNT(*) FROM project_files f WHERE f.project_id = p.id AND f.changed_at >= ?) AS changed,
              (SELECT COUNT(*) FROM project_contexts c WHERE c.project_id = p.id AND c.created_at >= ?) AS contexts
       FROM projects p ORDER BY changed DESC`,
      [start, start],
    );
    const openQuestions = this.db.all<{ project: string; question: string }>(
      `SELECT p.name AS project, q.question FROM clarification_questions q JOIN projects p ON p.id = q.project_id WHERE q.status = 'open'`,
    );
    const newOpps = this.db.all<Record<string, unknown>>(
      `SELECT o.id, o.relevance, o.scenario, pe.display_name, pr.name AS project, sp.url FROM opportunities o
       JOIN projects pr ON pr.id = o.project_id JOIN source_posts sp ON sp.id = o.source_post_id LEFT JOIN people pe ON pe.id = o.person_id
       WHERE o.created_at >= ? AND o.state IN ('new','shortlisted') ORDER BY o.relevance DESC LIMIT 10`,
      [start],
    );
    const awaiting = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM draft_actions WHERE state = 'awaiting_approval'")!.n;
    const uncertain = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM draft_actions WHERE state = 'uncertain'")!.n;
    const staleDrafts = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM drafts WHERE status = 'active' AND stale = 1")!.n;
    const sent = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM draft_actions WHERE state = 'sent' AND sent_at >= ?", [start])!.n;
    const replies = this.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM interactions WHERE direction IN ('inbound','mutual') AND occurred_at >= ?",
      [start],
    )!.n;
    const newPeople = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM people WHERE created_at >= ? AND is_self = 0", [start])!.n;
    const recs = this.network.recommendations({ limit: 5 });

    const md: string[] = [`# Week of ${start.slice(0, 10)} to ${end.slice(0, 10)}`, ""];
    md.push("## Activity", `- Outreach sent: ${sent}`, `- Replies received: ${replies}`, `- New people discovered: ${newPeople}`, "");
    const changed = projectChanges.filter((p) => p.changed > 0);
    md.push("## Projects", ...(changed.length ? changed.map((p) => `- ${p.name}: ${p.changed} files changed${p.contexts ? `, summary updated` : ""}`) : ["- No project changes this week."]), "");
    if (openQuestions.length) md.push("## Questions for you", ...openQuestions.map((q) => `- (${q.project}) ${q.question}`), "");
    md.push(
      "## Review queue",
      `- Drafts awaiting approval: ${awaiting}`,
      `- Drafts flagged after project changes: ${staleDrafts}`,
      ...(uncertain ? [`- Sends with unknown outcome to reconcile: ${uncertain}`] : []),
      "",
    );
    if (newOpps.length) {
      md.push("## Top new opportunities", ...newOpps.map((o) => `- ${o.display_name ?? "Unknown"} (${o.project}, ${String(o.scenario).replace(/_/g, " ")}, ${Number(o.relevance).toFixed(2)})${o.url ? ` ${o.url}` : ""}`), "");
    }
    if (recs.reconnect.length) md.push("## Reconnect", ...recs.reconnect.map((r) => `- ${r.personName}: ${r.reason}`), "");
    if (recs.followups.length) md.push("## Follow-ups", ...recs.followups.map((f) => `- ${f.personName}: ${f.reason}${f.overdue ? " (overdue)" : ""}`), "");

    const payload = {
      markdown: md.join("\n"),
      activity: { sent, replies, newPeople },
      projects: projectChanges,
      openQuestions,
      reviewQueue: { awaitingApproval: awaiting, staleDrafts, uncertain },
      newOpportunities: newOpps,
      recommendations: recs,
    };
    const id = newId("rvw");
    this.db.run("INSERT INTO weekly_reviews (id, period_start, period_end, payload, created_at) VALUES (?, ?, ?, ?, ?)", [id, start, end, payload, nowIso()]);
    return { id, periodStart: start, periodEnd: end, ...payload };
  }

  list(limit = 10) {
    return this.db.all("SELECT id, period_start, period_end, created_at FROM weekly_reviews ORDER BY created_at DESC LIMIT ?", [limit]);
  }

  get(id: string) {
    return this.db.get<Record<string, unknown>>("SELECT * FROM weekly_reviews WHERE id = ?", [id]);
  }

  /**
   * Suggests follow-ups for unanswered inbound 1:1 messages older than `afterDays`.
   * Suggestions are stored with origin 'suggested' and never duplicated.
   */
  suggestFollowups(afterDays = 3): number {
    const selfId = this.people.selfId();
    const cutoff = new Date(Date.now() - afterDays * 86_400_000).toISOString();
    const threads = this.db.all<{ thread: string; person_id: string; display_name: string; last_dir: string; last_at: string; last_id: string }>(
      `WITH last AS (
         SELECT COALESCE(i.thread_id, i.id) AS thread, MAX(i.occurred_at) AS last_at FROM interactions i WHERE i.is_group = 0 GROUP BY thread
       )
       SELECT l.thread, ip.person_id, p.display_name, i.direction AS last_dir, l.last_at, i.id AS last_id
       FROM last l JOIN interactions i ON COALESCE(i.thread_id, i.id) = l.thread AND i.occurred_at = l.last_at
       JOIN interaction_participants ip ON ip.interaction_id = i.id AND ip.person_id != ?
       JOIN people p ON p.id = ip.person_id
       WHERE i.direction = 'inbound' AND l.last_at <= ? AND l.last_at >= ?`,
      [selfId, cutoff, new Date(Date.now() - 60 * 86_400_000).toISOString()],
    );
    let created = 0;
    for (const t of threads) {
      const exists = this.db.get("SELECT 1 FROM followups WHERE person_id = ? AND interaction_id = ?", [t.person_id, t.last_id]);
      if (exists) continue;
      this.relationships.createFollowup({
        personId: t.person_id,
        interactionId: t.last_id,
        reason: `${t.display_name} wrote on ${t.last_at.slice(0, 10)} and has not had a reply.`,
        dueAt: nowIso(),
        origin: "suggested",
      });
      created++;
    }
    return created;
  }
}
