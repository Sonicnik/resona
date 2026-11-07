import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { detectScenario } from "../src/matching/scenarios.ts";
import { AiBlockedError } from "../src/ai/client.ts";
import { makeServices, StubAi, tmpDir, writeFiles, SAMPLE_PROJECT, MATCHING_POST } from "./helpers.ts";

const AI_SUMMARY = {
  summary: "An evaluation harness for RAG pipelines.",
  problem: "Teams evaluate RAG retrieval by hand.",
  audience: "Developers building RAG chatbots",
  built: "A Python harness with recall metrics.",
  contribution: "",
  results: [{ claim: "Recall@5 rose from 0.61 to 0.78 with hybrid search", evidence: ["README.md:1-20"], confidence: "medium" }],
  capabilities: ["Retrieval recall@k metrics"],
  limitations: ["English only"],
  keywords: ["rag", "retrieval recall", "evaluation", "hybrid search"],
  search_phrases: ["evaluate rag retrieval"],
  shareable_material: [{ ref: "README.md", description: "Overview" }],
  uncertainties: [],
  questions: [{ field: "contribution", question: "What part of rag-eval did you build yourself?" }],
};

function stubResponder(req: { schema: unknown; system: string }) {
  if (req.system.includes("describe their own project")) return AI_SUMMARY;
  if (req.system.includes("draft an individual reply")) {
    return { body: "Hi Jane - I hit the same problem. [link]", rationale: "Answer first.", source_refs: ["README.md:1-20"], cautions: [] };
  }
  if (req.system.includes("standalone")) {
    return { worth_posting: false, reason: "Only a typo fix changed.", title: "x", body: "x", source_refs: [], cautions: [] };
  }
  throw new Error("unexpected request");
}

function setupProject(s: ReturnType<typeof makeServices>, aiPermission: "allowed" | "denied") {
  const folder = tmpDir("proj-");
  writeFiles(folder, SAMPLE_PROJECT);
  return { folder, project: s.projects.create({ folderPath: folder, aiPermission }) };
}

test("scenario detection distinguishes requests from resolved threads and pitches", () => {
  assert.equal(detectScenario("Any recommendations for a vector database? What do you use?").scenario, "recommendation_request");
  assert.equal(detectScenario("I wish there was a tool that did this").scenario, "wish_for_tool");
  assert.equal(detectScenario("We're hiring an ML intern, join our team").scenario, "hiring");
  assert.ok(detectScenario("[SOLVED] figured it out, thanks everyone").openness < 0.5);
  assert.ok(detectScenario("Looking for recommendations. No vendors please.").openness < 0.2);
  assert.equal(detectScenario("bug report", { platform: "github" }).scenario, "open_source_issue");
});

test("offline pipeline: extractive summary, questions, matching, template draft", async () => {
  const s = makeServices();
  const { project } = setupProject(s, "denied");
  const res = await s.pipeline.processProject(project.id, "initial");
  assert.equal(res.summary?.method, "extractive");
  assert.ok((res.summary?.questionsAdded ?? 0) >= 1, "asks about the user's contribution");
  const ctx = s.projects.latestContext(project.id)!;
  assert.match(String(ctx.summary), /evaluation harness/);
  assert.ok(JSON.parse(String(ctx.limitations)).includes("English only"));

  const post = s.opportunities.ingestPost({
    platform: "linkedin",
    externalId: "p1",
    text: MATCHING_POST,
    publishedAt: new Date().toISOString(),
    connector: "manual",
    author: { platform: "linkedin", url: "https://www.linkedin.com/in/jane", displayName: "Jane Doe" },
  });
  const unrelated = s.opportunities.ingestPost({ platform: "linkedin", externalId: "p2", text: "Great marathon this weekend!", connector: "manual" });
  assert.equal(s.opportunities.matchPost(unrelated.postId).length, 0);
  const matches = s.opportunities.matchPost(post.postId);
  assert.equal(matches.length, 1);
  const opp = s.opportunities.get(matches[0]!.opportunityId);
  assert.ok(opp.relevance > 0.4);
  assert.ok(opp.evidence.some((e) => e.ref.startsWith("README.md")), "evidence cites project files");

  // Re-ingesting the same post is idempotent and does not duplicate the author.
  const again = s.opportunities.ingestPost({
    platform: "linkedin",
    externalId: "p1",
    text: MATCHING_POST,
    connector: "manual",
    author: { platform: "linkedin", url: "https://linkedin.com/in/jane/", displayName: "Jane D." },
  });
  assert.equal(again.created, false);
  assert.equal(again.authorPersonId, post.authorPersonId);

  const draft = await s.drafts.createOutreachDraft(opp.id);
  assert.equal(draft.revision?.author, "template");
  assert.match(draft.revision!.body, /English only/, "template states a limitation");
  assert.equal(s.opportunities.get(opp.id).state, "shortlisted");
  assert.equal(s.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM ai_requests")!.n, 0, "nothing was sent to a model");
  s.close();
});

test("AI summary requires per-folder permission and records processing history", async () => {
  let stub!: StubAi;
  const s = makeServices({ ai: (db, config) => (stub = new StubAi(db, config, stubResponder as never)) });
  const { project } = setupProject(s, "denied");
  await s.pipeline.processProject(project.id, "initial");
  assert.equal(s.projects.latestContext(project.id)!.method, "extractive", "denied folder never reaches the model");
  assert.equal(stub.calls.length, 0);
  await assert.rejects(
    s.ai.structured({ purpose: "x", projectIds: [project.id], inputRefs: [], system: "", user: "", schema: (await import("zod")).z.object({}) }),
    AiBlockedError,
  );
  assert.equal(s.db.get<{ status: string }>("SELECT status FROM ai_requests ORDER BY created_at DESC")!.status, "blocked");

  s.projects.update(project.id, { aiPermission: "allowed" });
  const out = await s.summarizer.summarize(project.id);
  assert.equal(out.method, "ai");
  assert.equal(out.version, 2);
  const ctx = s.projects.latestContext(project.id)!;
  assert.equal(ctx.problem, AI_SUMMARY.problem);
  const req = stub.calls[0]!;
  assert.match(req.user, /\[README\.md:1-\d+\]/, "files are sent with line references");
  assert.doesNotMatch(req.user, /node_modules/);
  const history = s.db.all<{ status: string; input_refs: string; purpose: string }>("SELECT * FROM ai_requests WHERE status = 'ok'");
  assert.equal(history.length, 1);
  assert.ok(JSON.parse(history[0]!.input_refs).some((r: string) => r.startsWith("README.md")));
  const q = s.projects.questions(project.id, "open") as Array<{ question: string }>;
  assert.ok(q.some((x) => x.question.includes("build yourself")));
  s.close();
});

test("context change flags unsent drafts as stale; AI post draft can decline", async () => {
  const s = makeServices({ ai: (db, config) => new StubAi(db, config, stubResponder as never) });
  const { project, folder } = setupProject(s, "allowed");
  await s.pipeline.processProject(project.id, "initial");
  const post = s.opportunities.ingestPost({ platform: "linkedin", externalId: "p1", text: MATCHING_POST, connector: "manual", author: { platform: "linkedin", url: "https://www.linkedin.com/in/jane", displayName: "Jane" } });
  const [m] = s.opportunities.matchPost(post.postId);
  const draft = await s.drafts.createOutreachDraft(m!.opportunityId);
  assert.equal(draft.revision?.author, "ai");
  assert.equal(draft.revision?.body, "Hi Jane - I hit the same problem. [link]");

  fs.appendFileSync(path.join(folder, "README.md"), "\nNew: MRR metric added.\n");
  const res = await s.pipeline.processProject(project.id, "watch");
  assert.equal(res.summary?.staleDrafts, 1);
  const stale = s.drafts.get(draft.id);
  assert.equal(stale.stale, true);

  const action = s.drafts.requestApproval(draft.id, "https://linkedin.com/post/1");
  assert.throws(() => s.drafts.approve(String(action.id), { revision: 1 }), /context changed/);
  assert.equal(s.drafts.approve(String(action.id), { revision: 1, acknowledgeStale: true }).state, "approved");

  await assert.rejects(s.drafts.createPostDraft(project.id, { platform: "linkedin" }), /No post drafted/);
  const forced = await s.drafts.createPostDraft(project.id, { platform: "x", force: true });
  assert.equal(forced.kind, "post");
  s.close();
});

test("approval state machine: exact revision, edits void approvals, uncertain sends must be reconciled", async () => {
  const s = makeServices();
  const { project } = setupProject(s, "denied");
  await s.pipeline.processProject(project.id, "initial");
  const post = s.opportunities.ingestPost({ platform: "linkedin", externalId: "p1", text: MATCHING_POST, connector: "manual", author: { platform: "linkedin", url: "https://www.linkedin.com/in/jane", displayName: "Jane" } });
  const [m] = s.opportunities.matchPost(post.postId);
  const draft = await s.drafts.createOutreachDraft(m!.opportunityId);

  const a1 = s.drafts.requestApproval(draft.id, "https://linkedin.com/post/1");
  assert.throws(() => s.drafts.requestApproval(draft.id, "x"), /open action/);
  assert.throws(() => s.drafts.markSent(String(a1.id)), /awaiting_approval to sent/);
  assert.throws(() => s.drafts.approve(String(a1.id), { revision: 2 }), /changed since/);
  s.drafts.approve(String(a1.id), { revision: 1 });
  s.drafts.revise(draft.id, { body: "Edited text" });
  assert.equal(s.drafts.getAction(String(a1.id)).state, "cancelled", "edit voids the approval");

  const a2 = s.drafts.requestApproval(draft.id, "https://linkedin.com/post/1");
  assert.equal(a2.revision, 2);
  s.drafts.approve(String(a2.id), { revision: 2 });
  s.drafts.markUncertain(String(a2.id));
  assert.throws(() => s.drafts.retry(String(a2.id)), /uncertain to awaiting_approval/, "cannot retry before reconciling");
  const { interactionId } = s.drafts.reconcile(String(a2.id), { wasSent: true, externalMessageId: "m-1" }) as { interactionId: string };
  assert.ok(interactionId);
  assert.equal(s.opportunities.get(m!.opportunityId).state, "acted_on");
  const parts = s.relationships.participants(interactionId);
  assert.deepEqual(parts.map((p) => p.role).sort(), ["recipient", "sender"]);
  assert.throws(() => s.drafts.revise(draft.id, { body: "again" }), /already sent/);

  // Outbound alone does not make someone a contact; a reply does.
  const jane = s.people.get(post.authorPersonId!);
  assert.equal(jane.status, "prospect");
  s.relationships.recordInteraction({
    platform: "linkedin",
    type: "reply",
    direction: "inbound",
    occurredAt: new Date().toISOString(),
    participants: [{ personId: jane.id, role: "sender" }, { personId: s.people.selfId(), role: "recipient" }],
  });
  assert.equal(s.people.get(jane.id).status, "contact");

  // Previously contacted people are flagged and down-ranked on new matches.
  const post2 = s.opportunities.ingestPost({ platform: "linkedin", externalId: "p9", text: MATCHING_POST, connector: "manual", author: { platform: "linkedin", url: "https://www.linkedin.com/in/jane", displayName: "Jane" } });
  const [m2] = s.opportunities.matchPost(post2.postId);
  const opp2 = s.opportunities.get(m2!.opportunityId);
  assert.ok(opp2.flags.some((f) => /already contacted/.test(f)));
  assert.equal(opp2.scoreBreakdown.duplicatePenalty, 0.6);
  assert.ok(opp2.relevance < s.opportunities.get(m!.opportunityId).relevance);
  s.close();
});
