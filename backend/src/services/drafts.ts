import type { Db } from "../db/database.ts";
import type { AiService } from "../ai/client.ts";
import type { ProjectService } from "./projects.ts";
import type { PeopleService } from "./people.ts";
import type { RelationshipService } from "./relationships.ts";
import type { OpportunityService } from "./opportunities.ts";
import { badRequest, conflict, newId, notFound, nowIso, parseJson } from "../lib/util.ts";
import {
  contextForDraft,
  draftOutreachWithAi,
  draftPostWithAi,
  templateOutreach,
  templatePost,
} from "../ai/drafting.ts";
import type { Scenario } from "../matching/scenarios.ts";

type ActionState = "awaiting_approval" | "approved" | "queued" | "sent" | "failed" | "uncertain" | "cancelled";

/**
 * Allowed action transitions. Approval applies to one exact revision + destination; any edit
 * cancels pending approvals. `uncertain` must be reconciled (sent / not sent) before any retry so the
 * same message is never sent twice.
 */
const ACTION_TRANSITIONS: Record<ActionState, ActionState[]> = {
  awaiting_approval: ["approved", "cancelled"],
  approved: ["queued", "sent", "failed", "uncertain", "cancelled"],
  queued: ["sent", "failed", "uncertain"],
  uncertain: ["sent", "failed"],
  failed: ["awaiting_approval"],
  sent: [],
  cancelled: [],
};

export interface DraftView {
  id: string;
  kind: string;
  platform: string;
  channel: string;
  stale: boolean;
  staleReason: string | null;
  status: string;
  opportunityId: string | null;
  projectId: string | null;
  projectContextId: string | null;
  personId: string | null;
  currentRevision: number;
  revision: { revision: number; title: string | null; body: string; author: string; model: string | null; sourceRefs: string[]; createdAt: string } | null;
  meta: Record<string, unknown>;
  actions: Array<Record<string, unknown>>;
  createdAt: string;
  updatedAt: string;
}

export class DraftService {
  constructor(
    private readonly db: Db,
    private readonly ai: AiService,
    private readonly projects: ProjectService,
    private readonly people: PeopleService,
    private readonly relationships: RelationshipService,
    private readonly opportunities: OpportunityService,
  ) {}

  private insertDraft(d: {
    kind: "outreach" | "post";
    opportunityId?: string | null;
    projectId: string | null;
    contextId: string | null;
    personId?: string | null;
    platform: string;
    channel: string;
    title?: string | null;
    body: string;
    author: "ai" | "template" | "user";
    model?: string | null;
    sourceRefs: string[];
    meta?: Record<string, unknown>;
  }): string {
    return this.db.tx(() => {
      const id = newId("drf");
      const now = nowIso();
      this.db.run(
        `INSERT INTO drafts (id, kind, opportunity_id, project_id, project_context_id, person_id, platform, channel, current_revision, meta, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        [id, d.kind, d.opportunityId, d.projectId, d.contextId, d.personId, d.platform, d.channel, d.meta ?? {}, now, now],
      );
      this.db.run(
        `INSERT INTO draft_revisions (id, draft_id, revision, title, body, author, model, source_refs, created_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`,
        [newId("rev"), id, d.title, d.body, d.author, d.model, d.sourceRefs, now],
      );
      return id;
    });
  }

  /** Step 3: individualized, editable draft for one opportunity. */
  async createOutreachDraft(opportunityId: string, opts: { useAi?: boolean; channel?: string } = {}): Promise<DraftView> {
    const opp = this.opportunities.get(opportunityId);
    if (opp.state === "dismissed") throw conflict("opportunity was dismissed; restore it before drafting");
    const project = this.projects.get(opp.projectId);
    const ctxRow = this.projects.latestContext(opp.projectId);
    if (!ctxRow) throw badRequest("project has no summary yet; summarize it first");
    const ctx = contextForDraft(project.name, ctxRow);
    const channel = opts.channel ?? opp.suggestedChannel;
    const authorName = opp.personName ?? "there";
    const shared = (opp.scoreBreakdown.sharedTerms as string[] | undefined) ?? [];

    let body: string;
    let author: "ai" | "template" = "template";
    let model: string | null = null;
    let sourceRefs: string[];
    const meta: Record<string, unknown> = {};
    if ((opts.useAi ?? true) && this.ai.canUseFor([opp.projectId])) {
      const history = opp.personId
        ? (this.relationships.interactionsFor(opp.personId, 5) as Array<Record<string, unknown>>).map(
            (i) => `${String(i.occurred_at).slice(0, 10)} ${i.direction} ${i.type}: ${String(i.body ?? i.subject ?? "").slice(0, 300)}`,
          )
        : [];
      try {
        const res = await draftOutreachWithAi(this.ai, {
          ctx,
          post: opp.post,
          authorName,
          scenario: opp.scenario as Scenario,
          channel,
          matchReason: opp.matchReason,
          history,
          sourceRef: `opportunity:${opportunityId}`,
        });
        body = res.data.body;
        sourceRefs = res.data.source_refs;
        author = "ai";
        model = res.model;
        meta.rationale = res.data.rationale;
        meta.cautions = res.data.cautions;
      } catch (err) {
        meta.aiError = err instanceof Error ? err.message : String(err);
        ({ body, sourceRefs } = templateOutreach({ ctx, authorName, scenario: opp.scenario as Scenario, sharedTerms: shared, platform: opp.post.platform }));
      }
    } else {
      ({ body, sourceRefs } = templateOutreach({ ctx, authorName, scenario: opp.scenario as Scenario, sharedTerms: shared, platform: opp.post.platform }));
    }

    const id = this.insertDraft({
      kind: "outreach",
      opportunityId,
      projectId: opp.projectId,
      contextId: ctx.contextId,
      personId: opp.personId,
      platform: opp.post.platform,
      channel,
      body,
      author,
      model,
      sourceRefs,
      meta,
    });
    if (opp.state === "new") this.opportunities.setState(opportunityId, "shortlisted");
    return this.get(id);
  }

  /**
   * Follow-up to someone already in the network (no opportunity): grounded in past interactions,
   * the open follow-up reason and the latest context of the project most recently linked to them.
   */
  async createFollowupDraft(personId: string, opts: { useAi?: boolean; channel?: string; reason?: string } = {}): Promise<DraftView> {
    const person = this.people.get(personId);
    if (person.is_self) throw badRequest("cannot draft a follow-up to yourself");
    const followup = this.db.get<{ reason: string; project_id: string | null }>(
      "SELECT reason, project_id FROM followups WHERE person_id = ? AND state = 'open' ORDER BY COALESCE(due_at, created_at) LIMIT 1",
      [personId],
    );
    const projectId =
      followup?.project_id ??
      this.db.get<{ project_id: string }>(
        `SELECT project_id FROM (
           SELECT project_id, created_at FROM opportunities WHERE person_id = ?
           UNION ALL SELECT project_id, created_at FROM drafts WHERE person_id = ? AND project_id IS NOT NULL
         ) ORDER BY created_at DESC LIMIT 1`,
        [personId, personId],
      )?.project_id ??
      this.projects.list().find((p) => p.status === "active" && p.kind === "project")?.id;
    if (!projectId) throw badRequest("add a project folder before drafting a follow-up");
    const ctxRow = this.projects.latestContext(projectId);
    if (!ctxRow) throw badRequest("project has no summary yet; summarize it first");
    const ctx = contextForDraft(this.projects.get(projectId).name, ctxRow);
    const reason = opts.reason ?? followup?.reason ?? "Follow up on your last conversation";
    const interactions = this.relationships.interactionsFor(personId, 5) as Array<Record<string, unknown>>;
    const last = interactions[0];
    const platform = String(last?.platform ?? this.people.profiles(personId)[0]?.platform ?? "linkedin");
    const channel = opts.channel ?? "direct_message";
    const history = interactions.map(
      (i) => `${String(i.occurred_at).slice(0, 10)} ${i.direction} ${i.type}: ${String(i.body ?? i.subject ?? "").slice(0, 300)}`,
    );

    let body: string;
    let sourceRefs: string[];
    let author: "ai" | "template" = "template";
    let model: string | null = null;
    const meta: Record<string, unknown> = { followupReason: reason };
    const template = () =>
      templateOutreach({ ctx, authorName: person.display_name, scenario: "past_contact_followup", sharedTerms: parseJson<string[]>(ctxRow.keywords, []), platform });
    if ((opts.useAi ?? true) && this.ai.canUseFor([projectId])) {
      try {
        const res = await draftOutreachWithAi(this.ai, {
          ctx,
          post: { text: `${reason}\n\nLast message: ${String(last?.body ?? last?.subject ?? "(none)")}`, platform },
          authorName: person.display_name,
          scenario: "past_contact_followup",
          channel,
          matchReason: reason,
          history,
          sourceRef: `person:${personId}`,
        });
        ({ body, source_refs: sourceRefs } = res.data);
        author = "ai";
        model = res.model;
        meta.rationale = res.data.rationale;
        meta.cautions = res.data.cautions;
      } catch (err) {
        meta.aiError = err instanceof Error ? err.message : String(err);
        ({ body, sourceRefs } = template());
      }
    } else {
      ({ body, sourceRefs } = template());
    }
    const id = this.insertDraft({ kind: "outreach", projectId, contextId: ctx.contextId, personId, platform, channel, body, author, model, sourceRefs, meta });
    return this.get(id);
  }

  /** Phase 1 standalone LinkedIn/X post drafts based on meaningful project developments. */
  async createPostDraft(projectId: string, opts: { platform: "linkedin" | "x"; angle?: string; useAi?: boolean; force?: boolean }): Promise<DraftView> {
    const project = this.projects.get(projectId);
    const ctxRow = this.projects.latestContext(projectId);
    if (!ctxRow) throw badRequest("project has no summary yet; summarize it first");
    const ctx = contextForDraft(project.name, ctxRow);
    const recent = this.db
      .all<{ rel_path: string }>(
        "SELECT rel_path FROM project_files WHERE project_id = ? AND changed_at >= ? ORDER BY changed_at DESC LIMIT 30",
        [projectId, new Date(Date.now() - 14 * 86_400_000).toISOString()],
      )
      .map((r) => r.rel_path);

    let title: string;
    let body: string;
    let sourceRefs: string[];
    let author: "ai" | "template" = "template";
    let model: string | null = null;
    const meta: Record<string, unknown> = {};
    if ((opts.useAi ?? true) && this.ai.canUseFor([projectId])) {
      const res = await draftPostWithAi(this.ai, { ctx, platform: opts.platform, angle: opts.angle, recentChanges: recent, force: Boolean(opts.force) });
      if (!res.data.worth_posting && !opts.force) {
        throw conflict(`No post drafted: ${res.data.reason}`, { worthPosting: false, reason: res.data.reason });
      }
      ({ title, body } = res.data);
      sourceRefs = res.data.source_refs;
      author = "ai";
      model = res.model;
      meta.reason = res.data.reason;
      meta.cautions = res.data.cautions;
      meta.worthPosting = res.data.worth_posting;
    } else {
      ({ title, body, sourceRefs } = templatePost(ctx, opts.platform));
    }
    const id = this.insertDraft({
      kind: "post",
      projectId,
      contextId: ctx.contextId,
      platform: opts.platform,
      channel: "post",
      title,
      body,
      author,
      model,
      sourceRefs,
      meta,
    });
    return this.get(id);
  }

  get(id: string): DraftView {
    const d = this.db.get<Record<string, unknown>>("SELECT * FROM drafts WHERE id = ?", [id]);
    if (!d) throw notFound("draft");
    const rev = this.db.get<Record<string, unknown>>(
      "SELECT * FROM draft_revisions WHERE draft_id = ? AND revision = ?",
      [id, d.current_revision],
    );
    const actions = this.db.all("SELECT * FROM draft_actions WHERE draft_id = ? ORDER BY created_at DESC", [id]);
    return {
      id,
      kind: String(d.kind),
      platform: String(d.platform),
      channel: String(d.channel),
      stale: d.stale === 1,
      staleReason: (d.stale_reason as string) ?? null,
      status: String(d.status),
      opportunityId: (d.opportunity_id as string) ?? null,
      projectId: (d.project_id as string) ?? null,
      projectContextId: (d.project_context_id as string) ?? null,
      personId: (d.person_id as string) ?? null,
      currentRevision: Number(d.current_revision),
      revision: rev
        ? {
            revision: Number(rev.revision),
            title: (rev.title as string) ?? null,
            body: String(rev.body),
            author: String(rev.author),
            model: (rev.model as string) ?? null,
            sourceRefs: parseJson<string[]>(rev.source_refs, []),
            createdAt: String(rev.created_at),
          }
        : null,
      meta: parseJson<Record<string, unknown>>(d.meta, {}),
      actions,
      createdAt: String(d.created_at),
      updatedAt: String(d.updated_at),
    };
  }

  list(opts: { kind?: string; status?: string; personId?: string; projectId?: string; stale?: boolean } = {}): DraftView[] {
    const ids = this.db.all<{ id: string }>(
      `SELECT id FROM drafts WHERE (? IS NULL OR kind = ?) AND status = COALESCE(?, 'active')
         AND (? IS NULL OR person_id = ?) AND (? IS NULL OR project_id = ?) AND (? IS NULL OR stale = ?)
       ORDER BY updated_at DESC LIMIT 200`,
      [
        opts.kind ?? null, opts.kind ?? null, opts.status ?? null, opts.personId ?? null, opts.personId ?? null,
        opts.projectId ?? null, opts.projectId ?? null, opts.stale === undefined ? null : 1, opts.stale ? 1 : 0,
      ],
    );
    return ids.map((r) => this.get(r.id));
  }

  revisions(id: string) {
    this.get(id);
    return this.db.all("SELECT * FROM draft_revisions WHERE draft_id = ? ORDER BY revision DESC", [id]);
  }

  /** A user edit creates a new revision and voids approvals of earlier revisions. */
  revise(id: string, input: { body: string; title?: string | null }): DraftView {
    const draft = this.get(id);
    if (!input.body.trim()) throw badRequest("body cannot be empty");
    if (draft.actions.some((a) => a.state === "sent")) throw conflict("this draft was already sent; create a new draft instead");
    return this.db.tx(() => {
      const next = draft.currentRevision + 1;
      const now = nowIso();
      this.db.run(
        `INSERT INTO draft_revisions (id, draft_id, revision, title, body, author, model, source_refs, created_at)
         VALUES (?, ?, ?, ?, ?, 'user', NULL, ?, ?)`,
        [newId("rev"), id, next, input.title ?? draft.revision?.title ?? null, input.body, draft.revision?.sourceRefs ?? [], now],
      );
      this.db.run(
        "UPDATE drafts SET current_revision = ?, stale = 0, stale_reason = NULL, updated_at = ? WHERE id = ?",
        [next, now, id],
      );
      this.db.run(
        `UPDATE draft_actions SET state = 'cancelled', error = 'draft edited after approval request; review again', updated_at = ?
         WHERE draft_id = ? AND state IN ('awaiting_approval','approved')`,
        [now, id],
      );
      return this.get(id);
    });
  }

  archive(id: string): void {
    this.get(id);
    this.db.run("UPDATE drafts SET status = 'archived', updated_at = ? WHERE id = ?", [nowIso(), id]);
  }

  // ---- outward actions: user review before every send or publication ----

  requestApproval(draftId: string, destination: string): Record<string, unknown> {
    const draft = this.get(draftId);
    if (draft.status !== "active") throw conflict("draft is archived");
    if (!destination.trim()) throw badRequest("destination is required (e.g. the post URL or recipient handle)");
    const open = draft.actions.find(
      (a) => ["awaiting_approval", "approved", "queued", "uncertain"].includes(String(a.state)),
    );
    if (open) throw conflict("this draft already has an open action", { actionId: open.id, state: open.state });
    const id = newId("act");
    const now = nowIso();
    this.db.run(
      `INSERT INTO draft_actions (id, draft_id, revision, destination, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'awaiting_approval', ?, ?)`,
      [id, draftId, draft.currentRevision, destination.trim(), now, now],
    );
    return this.getAction(id);
  }

  getAction(id: string): Record<string, unknown> {
    const a = this.db.get<Record<string, unknown>>("SELECT * FROM draft_actions WHERE id = ?", [id]);
    if (!a) throw notFound("action");
    return a;
  }

  private transition(id: string, to: ActionState, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const a = this.getAction(id);
    const from = a.state as ActionState;
    if (!ACTION_TRANSITIONS[from].includes(to)) throw conflict(`cannot move an action from ${from} to ${to}`);
    const sets = ["state = ?", "updated_at = ?"];
    const params: unknown[] = [to, nowIso()];
    for (const [k, v] of Object.entries(extra)) {
      sets.push(`${k} = ?`);
      params.push(v);
    }
    params.push(id);
    this.db.run(`UPDATE draft_actions SET ${sets.join(", ")} WHERE id = ?`, params);
    return this.getAction(id);
  }

  /**
   * The user approves one exact revision for one destination. The client must echo the revision
   * number it displayed, so an edit made elsewhere in the meantime cannot be approved by accident.
   */
  approve(actionId: string, input: { revision: number; acknowledgeStale?: boolean }): Record<string, unknown> {
    const a = this.getAction(actionId);
    const draft = this.get(String(a.draft_id));
    if (input.revision !== Number(a.revision) || input.revision !== draft.currentRevision) {
      throw conflict("the draft changed since it was reviewed; review the current revision", {
        currentRevision: draft.currentRevision,
      });
    }
    if (draft.stale && !input.acknowledgeStale) {
      throw conflict("the project context changed after this draft was written; review it or acknowledge", {
        staleReason: draft.staleReason,
      });
    }
    return this.transition(actionId, "approved", { approved_at: nowIso() });
  }

  cancel(actionId: string): Record<string, unknown> {
    return this.transition(actionId, "cancelled");
  }

  /**
   * Records that the user sent/published the approved text (copy-and-send fallback, or an authorized
   * integration reporting success). Creates the outbound interaction and marks the opportunity acted on.
   */
  markSent(actionId: string, input: { externalMessageId?: string | null; sentAt?: string | null; url?: string | null } = {}) {
    return this.db.tx(() => {
      const a = this.getAction(actionId);
      const sentAt = input.sentAt ?? nowIso();
      const updated = this.transition(actionId, "sent", { sent_at: sentAt, external_message_id: input.externalMessageId ?? null });
      const draft = this.get(String(a.draft_id));
      const rev = this.db.get<{ body: string; title: string | null }>(
        "SELECT body, title FROM draft_revisions WHERE draft_id = ? AND revision = ?",
        [draft.id, a.revision],
      );
      const selfId = this.people.selfId();
      const participants: Array<{ personId: string; role: "sender" | "recipient" }> = [{ personId: selfId, role: "sender" }];
      if (draft.personId) participants.push({ personId: draft.personId, role: "recipient" });
      const type = draft.kind === "post" ? "comment" : draft.channel === "direct_message" ? "message" : draft.channel === "email" ? "email" : "reply";
      const interaction = this.relationships.recordInteraction({
        platform: draft.platform,
        type: draft.kind === "post" ? "note" : type,
        direction: "outbound",
        occurredAt: sentAt,
        subject: rev?.title ?? (draft.kind === "post" ? "Published post" : null),
        body: rev?.body ?? null,
        externalId: input.externalMessageId ?? null,
        sourceRef: input.url ?? String(a.destination),
        actionId,
        participants,
      });
      if (draft.opportunityId) {
        const opp = this.db.get<{ state: string }>("SELECT state FROM opportunities WHERE id = ?", [draft.opportunityId]);
        if (opp && opp.state !== "acted_on") {
          this.db.run("UPDATE opportunities SET state = 'acted_on', updated_at = ? WHERE id = ?", [nowIso(), draft.opportunityId]);
        }
      }
      return { action: updated, interactionId: interaction.id };
    });
  }

  markFailed(actionId: string, error: string) {
    return this.transition(actionId, "failed", { error });
  }

  /** The send may or may not have happened (e.g. a crash mid-request). Must be reconciled before retrying. */
  markUncertain(actionId: string, note?: string) {
    return this.transition(actionId, "uncertain", { error: note ?? "send outcome unknown; check the platform before retrying" });
  }

  reconcile(actionId: string, input: { wasSent: boolean; externalMessageId?: string | null; sentAt?: string | null }) {
    const a = this.getAction(actionId);
    if (a.state !== "uncertain") throw conflict("only uncertain actions can be reconciled");
    return input.wasSent
      ? this.markSent(actionId, { externalMessageId: input.externalMessageId, sentAt: input.sentAt })
      : { action: this.markFailed(actionId, "reconciled: not sent") };
  }

  /** After a failure, a fresh approval is required for a retry. */
  retry(actionId: string) {
    return this.transition(actionId, "awaiting_approval", { error: null, approved_at: null });
  }
}
