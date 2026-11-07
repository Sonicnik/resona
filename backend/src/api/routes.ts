import { Router } from "express";
import { z } from "zod";
import type { Services } from "../container.ts";
import { body, param, query } from "./http.ts";
import { badRequest, notFound, parseJson } from "../lib/util.ts";
import { personToJson } from "../services/people.ts";
import { contextToJson, projectToJson, ProjectService } from "../services/projects.ts";
import type { ChunkSource } from "../search/index.ts";

const profileSchema = z.object({
  platform: z.string().min(1),
  externalId: z.string().nullish(),
  handle: z.string().nullish(),
  url: z.string().url().nullish(),
  displayName: z.string().nullish(),
  headline: z.string().nullish(),
  email: z.string().nullish(),
});

const personFields = {
  displayName: z.string().min(1),
  bio: z.string().nullish(),
  organization: z.string().nullish(),
  title: z.string().nullish(),
  location: z.string().nullish(),
  notes: z.string().nullish(),
  interests: z.array(z.string()).optional(),
};

const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO date");

const SETTINGS = {
  "schedule.discovery.enabled": z.boolean(),
  "schedule.weeklyReview.enabled": z.boolean(),
  "schedule.vaultSync.enabled": z.boolean(),
  "ai.disabled": z.boolean(),
} as const;
const SETTING_DEFAULTS: Record<keyof typeof SETTINGS, unknown> = {
  "schedule.discovery.enabled": false,
  "schedule.weeklyReview.enabled": true,
  "schedule.vaultSync.enabled": true,
  "ai.disabled": false,
};

export function apiRouter(s: Services): Router {
  const r = Router();

  // ---------- system ----------
  r.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  r.get("/status", (_req, res) => {
    const count = (sql: string) => Number(s.db.get<{ n: number }>(sql)?.n ?? 0);
    res.json({
      ai: { available: s.ai.isAvailable(), provider: "anthropic", model: s.ai.model },
      storage: { dataDir: s.config.dataDir, database: s.config.dbPath, vault: s.config.vaultDir },
      counts: {
        projects: count("SELECT COUNT(*) AS n FROM projects"),
        people: count("SELECT COUNT(*) AS n FROM people WHERE merged_into IS NULL AND is_self = 0"),
        openOpportunities: count("SELECT COUNT(*) AS n FROM opportunities WHERE state IN ('new','shortlisted')"),
        awaitingApproval: count("SELECT COUNT(*) AS n FROM draft_actions WHERE state = 'awaiting_approval'"),
        openQuestions: count("SELECT COUNT(*) AS n FROM clarification_questions WHERE status = 'open'"),
        openFollowups: count("SELECT COUNT(*) AS n FROM followups WHERE state = 'open'"),
      },
      scheduler: { resumedAfterPauseAt: s.scheduler.resumedAfterPauseAt, jobs: s.scheduler.status() },
      connectors: s.connectors.list(),
    });
  });

  r.get("/settings", (_req, res) => {
    res.json(Object.fromEntries(Object.keys(SETTINGS).map((k) => [k, s.db.getSetting(k, SETTING_DEFAULTS[k as keyof typeof SETTINGS])])));
  });

  r.patch("/settings", (req, res) => {
    const input = body(z.object(SETTINGS).partial().strict(), req);
    for (const [k, v] of Object.entries(input)) s.db.setSetting(k, v);
    res.json(Object.fromEntries(Object.keys(SETTINGS).map((k) => [k, s.db.getSetting(k, SETTING_DEFAULTS[k as keyof typeof SETTINGS])])));
  });

  r.get("/jobs", (_req, res) => {
    res.json(s.scheduler.status());
  });

  r.post("/jobs/:name/run", async (req, res) => {
    const name = param(req, "name");
    if (!s.scheduler.status().some((j) => j.name === name)) throw notFound("job");
    res.json(await s.scheduler.runJob(name));
  });

  r.get("/processing-history", (req, res) => {
    const projectId = query.str(req, "projectId") ?? null;
    const rows = s.db.all<Record<string, unknown>>(
      "SELECT * FROM ai_requests WHERE (? IS NULL OR project_id = ?) ORDER BY created_at DESC LIMIT ?",
      [projectId, projectId, query.num(req, "limit") ?? 100],
    );
    res.json(rows.map((row) => ({ ...row, input_refs: parseJson(row.input_refs, []) })));
  });

  // ---------- me ----------
  r.get("/me", (_req, res) => {
    const me = s.people.ensureSelf();
    res.json({ ...personToJson(me), profiles: s.people.profiles(me.id) });
  });

  r.patch("/me", (req, res) => {
    const input = body(z.object(personFields).partial(), req);
    const me = s.people.update(s.people.selfId(), input);
    res.json(personToJson(me));
  });

  r.post("/me/profiles", (req, res) => {
    const p = body(profileSchema, req);
    res.status(201).json({ id: s.people.addProfile(s.people.selfId(), { ...p, source: "manual" }) });
  });

  // ---------- projects ----------
  r.get("/projects", (req, res) => {
    res.json(s.projects.list({ kind: query.str(req, "kind") }).map(projectToJson));
  });

  r.get("/projects/exclusions/defaults", (_req, res) => {
    res.json(ProjectService.defaultExclusions());
  });

  r.post("/projects", async (req, res) => {
    const input = body(
      z.object({
        folderPath: z.string().min(1),
        name: z.string().optional(),
        kind: z.enum(["project", "cv"]).optional(),
        aiPermission: z.enum(["allowed", "denied"]).optional(),
        exclusions: z.array(z.string()).optional(),
        folderBookmark: z.string().optional(),
        scan: z.boolean().optional(),
      }),
      req,
    );
    const project = s.projects.create(input);
    if (s.config.watchEnabled) s.watcher.watch(project.id, project.folder_path);
    const result = input.scan === false ? null : await s.pipeline.processProject(project.id, "initial");
    res.status(201).json({ project: projectToJson(s.projects.get(project.id)), processing: result });
  });

  r.get("/projects/:id", (req, res) => {
    const id = param(req, "id");
    const project = s.projects.get(id);
    res.json({
      ...projectToJson(project),
      files: Object.fromEntries(s.projects.fileStats(id).map((x) => [x.processing_state, Number(x.n)])),
      context: contextToJson(s.projects.latestContext(id)),
      openQuestions: s.projects.questions(id, "open"),
    });
  });

  r.patch("/projects/:id", (req, res) => {
    const id = param(req, "id");
    const input = body(
      z.object({
        name: z.string().min(1).optional(),
        status: z.enum(["active", "paused", "archived"]).optional(),
        aiPermission: z.enum(["allowed", "denied"]).optional(),
        exclusions: z.array(z.string()).optional(),
        folderBookmark: z.string().optional(),
      }),
      req,
    );
    const project = s.projects.update(id, input);
    if (input.status && input.status !== "active") s.watcher.unwatch(id);
    else if (input.status === "active" && s.config.watchEnabled) s.watcher.watch(id, project.folder_path);
    res.json(projectToJson(project));
  });

  r.delete("/projects/:id", (req, res) => {
    const id = param(req, "id");
    s.watcher.unwatch(id);
    s.projects.delete(id);
    res.status(204).end();
  });

  r.post("/projects/:id/scan", async (req, res) => {
    const input = body(z.object({ forceSummary: z.boolean().optional() }), req);
    res.json(await s.pipeline.processProject(param(req, "id"), "manual", input));
  });

  r.post("/projects/:id/summarize", async (req, res) => {
    const id = param(req, "id");
    s.projects.get(id);
    const input = body(z.object({ force: z.boolean().optional(), preferAi: z.boolean().optional() }), req);
    const outcome = await s.summarizer.summarize(id, input);
    const rematched = outcome.status === "created" ? s.opportunities.rematchAll({ projectIds: [id] }) : 0;
    res.json({ ...outcome, rematched, context: contextToJson(s.projects.latestContext(id)) });
  });

  r.get("/projects/:id/files", (req, res) => {
    res.json(s.projects.files(param(req, "id"), query.str(req, "state")));
  });

  r.get("/projects/:id/runs", (req, res) => {
    res.json(s.projects.runs(param(req, "id"), query.num(req, "limit") ?? 20));
  });

  r.get("/projects/:id/context", (req, res) => {
    const ctx = s.projects.latestContext(param(req, "id"));
    if (!ctx) throw notFound("project context");
    res.json(contextToJson(ctx));
  });

  r.get("/projects/:id/contexts", (req, res) => {
    res.json(s.projects.contextHistory(param(req, "id")).map((c) => contextToJson(c as Record<string, unknown>)));
  });

  r.get("/projects/:id/questions", (req, res) => {
    res.json(s.projects.questions(param(req, "id"), query.str(req, "status")));
  });

  r.post("/questions/:id/answer", (req, res) => {
    const { answer } = body(z.object({ answer: z.string().min(1) }), req);
    s.projects.answerQuestion(param(req, "id"), answer);
    res.json({ ok: true, note: "Answers are used on the next summary; POST /projects/:id/summarize to refresh now." });
  });

  r.post("/questions/:id/dismiss", (req, res) => {
    s.projects.answerQuestion(param(req, "id"), null, true);
    res.json({ ok: true });
  });

  r.post("/projects/:id/post-drafts", async (req, res) => {
    const input = body(
      z.object({ platform: z.enum(["linkedin", "x"]), angle: z.string().optional(), useAi: z.boolean().optional(), force: z.boolean().optional() }),
      req,
    );
    res.status(201).json(await s.drafts.createPostDraft(param(req, "id"), input));
  });

  // ---------- search ----------
  r.get("/search", (req, res) => {
    const q = query.str(req, "q");
    if (!q) throw badRequest("q is required");
    const types = query.list(req, "types") as ChunkSource[] | undefined;
    const projectId = query.str(req, "projectId");
    const hits = s.index.search(q, { sourceTypes: types, projectIds: projectId ? [projectId] : undefined, limit: query.num(req, "limit") ?? 20 });
    res.json(
      hits.map((h) => {
        const file = h.sourceType === "project_file" ? s.db.get<{ rel_path: string }>("SELECT rel_path FROM project_files WHERE id = ?", [h.sourceId]) : undefined;
        return { ...h, ref: file ? `${file.rel_path}:${h.startLine}-${h.endLine}` : `${h.sourceType}:${h.sourceId}` };
      }),
    );
  });

  // ---------- conversations & discovery ----------
  r.get("/connectors", (_req, res) => {
    res.json(s.connectors.list());
  });

  r.post("/source-posts", (req, res) => {
    const input = body(
      z.object({
        platform: z.string().min(1),
        externalId: z.string().optional(),
        url: z.string().url().nullish(),
        title: z.string().nullish(),
        text: z.string().min(1),
        publishedAt: isoDate.nullish(),
        author: profileSchema.partial({ platform: true }).extend({ bio: z.string().nullish(), organization: z.string().nullish() }).optional(),
        match: z.boolean().optional(),
      }),
      req,
    );
    const externalId = input.externalId ?? input.url ?? `manual:${Date.now()}`;
    const res1 = s.opportunities.ingestPost({
      ...input,
      externalId,
      connector: "manual",
      author: input.author ? { ...input.author, platform: input.author.platform ?? input.platform } : undefined,
    });
    const opportunities = input.match === false ? [] : s.opportunities.matchPost(res1.postId);
    res.status(res1.created ? 201 : 200).json({ ...res1, opportunities });
  });

  r.get("/source-posts", (req, res) => {
    res.json(s.opportunities.listPosts({ platform: query.str(req, "platform"), limit: query.num(req, "limit") }));
  });

  r.get("/source-posts/:id", (req, res) => {
    res.json(s.opportunities.getPost(param(req, "id")));
  });

  r.post("/discovery/run", async (req, res) => {
    const input = body(
      z.object({
        projectIds: z.array(z.string()).optional(),
        connectorIds: z.array(z.string()).optional(),
        queriesPerProject: z.number().int().min(1).max(10).optional(),
        limitPerQuery: z.number().int().min(1).max(50).optional(),
        sinceDays: z.number().int().min(1).max(365).optional(),
      }),
      req,
    );
    res.json(await s.discovery.run(input));
  });

  r.get("/discovery/last", (_req, res) => {
    res.json(s.db.getSetting("discovery.lastReport", null));
  });

  // ---------- opportunities ----------
  r.get("/opportunities", (req, res) => {
    res.json(
      s.opportunities.list({
        state: query.str(req, "state"),
        projectId: query.str(req, "projectId"),
        personId: query.str(req, "personId"),
        minRelevance: query.num(req, "minRelevance"),
        limit: query.num(req, "limit"),
      }),
    );
  });

  r.post("/opportunities/rematch", (req, res) => {
    const input = body(z.object({ projectIds: z.array(z.string()).optional(), sinceDays: z.number().int().optional() }), req);
    res.json({ matched: s.opportunities.rematchAll(input) });
  });

  r.get("/opportunities/:id", (req, res) => {
    res.json(s.opportunities.get(param(req, "id")));
  });

  r.patch("/opportunities/:id", (req, res) => {
    const { state } = body(z.object({ state: z.enum(["new", "shortlisted", "dismissed", "acted_on"]) }), req);
    s.opportunities.setState(param(req, "id"), state);
    res.json(s.opportunities.get(param(req, "id")));
  });

  r.post("/opportunities/:id/assess", async (req, res) => {
    res.json(await s.opportunities.assessWithAi(param(req, "id")));
  });

  r.post("/opportunities/:id/drafts", async (req, res) => {
    const input = body(
      z.object({ useAi: z.boolean().optional(), channel: z.enum(["public_reply", "direct_message", "email", "comment"]).optional() }),
      req,
    );
    res.status(201).json(await s.drafts.createOutreachDraft(param(req, "id"), input));
  });

  // ---------- drafts & actions ----------
  r.get("/drafts", (req, res) => {
    res.json(
      s.drafts.list({
        kind: query.str(req, "kind"),
        status: query.str(req, "status"),
        personId: query.str(req, "personId"),
        projectId: query.str(req, "projectId"),
        stale: query.bool(req, "stale"),
      }),
    );
  });

  r.get("/drafts/:id", (req, res) => {
    res.json(s.drafts.get(param(req, "id")));
  });

  r.get("/drafts/:id/revisions", (req, res) => {
    res.json(s.drafts.revisions(param(req, "id")));
  });

  r.post("/drafts/:id/revisions", (req, res) => {
    const input = body(z.object({ body: z.string().min(1), title: z.string().nullish() }), req);
    res.status(201).json(s.drafts.revise(param(req, "id"), input));
  });

  r.delete("/drafts/:id", (req, res) => {
    s.drafts.archive(param(req, "id"));
    res.status(204).end();
  });

  r.post("/drafts/:id/actions", (req, res) => {
    const { destination } = body(z.object({ destination: z.string().min(1) }), req);
    res.status(201).json(s.drafts.requestApproval(param(req, "id"), destination));
  });

  r.get("/actions/:id", (req, res) => {
    res.json(s.drafts.getAction(param(req, "id")));
  });

  r.post("/actions/:id/approve", (req, res) => {
    const input = body(z.object({ revision: z.number().int().min(1), acknowledgeStale: z.boolean().optional() }), req);
    res.json(s.drafts.approve(param(req, "id"), input));
  });

  r.post("/actions/:id/cancel", (req, res) => {
    res.json(s.drafts.cancel(param(req, "id")));
  });

  r.post("/actions/:id/mark-sent", (req, res) => {
    const input = body(
      z.object({ externalMessageId: z.string().nullish(), sentAt: isoDate.nullish(), url: z.string().nullish() }),
      req,
    );
    res.json(s.drafts.markSent(param(req, "id"), input));
  });

  r.post("/actions/:id/mark-failed", (req, res) => {
    const { error } = body(z.object({ error: z.string().min(1) }), req);
    res.json(s.drafts.markFailed(param(req, "id"), error));
  });

  r.post("/actions/:id/mark-uncertain", (req, res) => {
    const { note } = body(z.object({ note: z.string().optional() }), req);
    res.json(s.drafts.markUncertain(param(req, "id"), note));
  });

  r.post("/actions/:id/reconcile", (req, res) => {
    const input = body(z.object({ wasSent: z.boolean(), externalMessageId: z.string().nullish(), sentAt: isoDate.nullish() }), req);
    res.json(s.drafts.reconcile(param(req, "id"), input));
  });

  r.post("/actions/:id/retry", (req, res) => {
    res.json(s.drafts.retry(param(req, "id")));
  });

  // ---------- people ----------
  r.get("/people", (req, res) => {
    res.json(
      s.people
        .list({ q: query.str(req, "q"), status: query.str(req, "status"), limit: query.num(req, "limit"), offset: query.num(req, "offset") })
        .map(personToJson),
    );
  });

  r.post("/people", (req, res) => {
    const input = body(
      z.object({ ...personFields, status: z.enum(["prospect", "contact"]).optional(), profiles: z.array(profileSchema).optional() }),
      req,
    );
    const person = s.db.tx(() => {
      const p = s.people.create(input);
      for (const prof of input.profiles ?? []) s.people.addProfile(p.id, { ...prof, source: "manual" });
      return p;
    });
    res.status(201).json(personToJson(person));
  });

  r.get("/people/duplicates", (_req, res) => {
    res.json(s.people.duplicateCandidates());
  });

  r.get("/people/:id", (req, res) => {
    res.json(s.network.personDetail(param(req, "id")));
  });

  r.patch("/people/:id", (req, res) => {
    const input = body(z.object({ ...personFields, status: z.enum(["prospect", "contact", "archived"]) }).partial(), req);
    res.json(personToJson(s.people.update(param(req, "id"), input)));
  });

  r.delete("/people/:id", (req, res) => {
    s.people.delete(param(req, "id"));
    res.status(204).end();
  });

  r.post("/people/:id/profiles", (req, res) => {
    const p = body(profileSchema, req);
    res.status(201).json({ id: s.people.addProfile(param(req, "id"), { ...p, source: "manual" }) });
  });

  r.delete("/profiles/:id", (req, res) => {
    s.people.removeProfile(param(req, "id"));
    res.status(204).end();
  });

  r.post("/people/:id/merge", (req, res) => {
    const { mergeId } = body(z.object({ mergeId: z.string().min(1) }), req);
    res.json(personToJson(s.people.merge(param(req, "id"), mergeId)));
  });

  r.get("/people/:id/paths", (req, res) => {
    res.json(s.network.paths(param(req, "id"), { k: query.num(req, "k"), maxHops: query.num(req, "maxHops") }));
  });

  // ---------- relationships, interactions, follow-ups ----------
  r.get("/relationships", (req, res) => {
    res.json(s.relationships.listRelationships(query.str(req, "personId")));
  });

  r.post("/relationships", (req, res) => {
    const input = body(
      z.object({
        fromPersonId: z.string(),
        toPersonId: z.string(),
        type: z.enum(["connection", "follows", "colleague", "classmate", "mentor", "introduced", "other"]),
        direction: z.enum(["directed", "mutual"]).optional(),
        platform: z.string().nullish(),
        observedAt: isoDate.nullish(),
        verificationSource: z.enum(["platform_api", "archive_import", "user_confirmed", "observed"]).default("user_confirmed"),
        evidence: z.string().nullish(),
      }),
      req,
    );
    res.status(201).json({ id: s.relationships.upsertRelationship(input) });
  });

  r.delete("/relationships/:id", (req, res) => {
    s.relationships.deleteRelationship(param(req, "id"));
    res.status(204).end();
  });

  r.get("/interactions", (req, res) => {
    res.json(s.relationships.listInteractions({ since: query.str(req, "since"), limit: query.num(req, "limit") }));
  });

  r.post("/interactions", (req, res) => {
    const input = body(
      z.object({
        platform: z.string().min(1),
        type: z.enum(["message", "reply", "comment", "meeting", "email", "post_engagement", "note"]),
        direction: z.enum(["outbound", "inbound", "mutual", "none"]),
        occurredAt: isoDate,
        subject: z.string().nullish(),
        body: z.string().nullish(),
        externalId: z.string().nullish(),
        threadId: z.string().nullish(),
        sourceRef: z.string().nullish(),
        participants: z
          .array(z.object({ personId: z.string(), role: z.enum(["sender", "recipient", "attendee", "mentioned", "member"]) }))
          .min(1),
        includeMe: z.boolean().default(true),
      }),
      req,
    );
    const selfId = s.people.selfId();
    const participants = [...input.participants];
    if (input.includeMe && !participants.some((p) => p.personId === selfId)) {
      participants.push({ personId: selfId, role: input.direction === "outbound" ? "sender" : input.type === "meeting" ? "attendee" : "recipient" });
    }
    res.status(201).json(s.relationships.recordInteraction({ ...input, participants }));
  });

  r.delete("/interactions/:id", (req, res) => {
    s.relationships.deleteInteraction(param(req, "id"));
    res.status(204).end();
  });

  r.get("/followups", (req, res) => {
    res.json(
      s.relationships.listFollowups({ state: query.str(req, "state"), personId: query.str(req, "personId"), dueBefore: query.str(req, "dueBefore") }),
    );
  });

  r.post("/followups", (req, res) => {
    const input = body(
      z.object({
        personId: z.string(),
        reason: z.string().min(1),
        dueAt: isoDate.nullish(),
        interactionId: z.string().nullish(),
        projectId: z.string().nullish(),
      }),
      req,
    );
    res.status(201).json({ id: s.relationships.createFollowup(input) });
  });

  r.patch("/followups/:id", (req, res) => {
    const input = body(
      z.object({ state: z.enum(["open", "done", "snoozed", "dismissed"]).optional(), dueAt: isoDate.nullish(), reason: z.string().optional() }),
      req,
    );
    s.relationships.updateFollowup(param(req, "id"), input);
    res.json({ ok: true });
  });

  // ---------- network ----------
  r.get("/network/graph", (req, res) => {
    res.json(
      s.network.graph({
        projectId: query.str(req, "projectId"),
        includeProposed: query.bool(req, "includeProposed"),
        includeArchived: query.bool(req, "includeArchived"),
        includeInterestLinks: query.bool(req, "includeInterestLinks"),
        minStrength: query.num(req, "minStrength"),
      }),
    );
  });

  r.get("/network/recommendations", (req, res) => {
    res.json(s.network.recommendations({ limit: query.num(req, "limit"), dormantDays: query.num(req, "dormantDays") }));
  });

  r.get("/network/paths/:personId", (req, res) => {
    res.json(s.network.paths(param(req, "personId"), { k: query.num(req, "k"), maxHops: query.num(req, "maxHops") }));
  });

  r.get("/network/stats", (_req, res) => {
    res.json(s.network.stats());
  });

  // ---------- imports ----------
  r.post("/imports/linkedin-archive", (req, res) => {
    const input = body(
      z.object({ path: z.string().optional(), files: z.record(z.string(), z.string()).optional(), selfProfileUrl: z.string().url().optional() }),
      req,
    );
    res.json(s.imports.linkedInArchive(input));
  });

  // ---------- vault ----------
  r.get("/vault", (_req, res) => {
    const files = s.db.all<{ entity_type: string; n: number }>("SELECT entity_type, COUNT(*) AS n FROM vault_files GROUP BY entity_type");
    res.json({ vaultDir: s.vault.vaultDir, files: Object.fromEntries(files.map((f) => [f.entity_type, Number(f.n)])) });
  });

  r.post("/vault/sync", (_req, res) => {
    res.json(s.vault.sync());
  });

  // ---------- weekly reviews ----------
  r.get("/reviews", (req, res) => {
    res.json(s.review.list(query.num(req, "limit") ?? 10));
  });

  r.post("/reviews", (_req, res) => {
    res.status(201).json(s.review.generate());
  });

  r.get("/reviews/:id", (req, res) => {
    const row = s.review.get(param(req, "id"));
    if (!row) throw notFound("review");
    res.json({ ...row, payload: parseJson(row.payload, {}) });
  });

  return r;
}
