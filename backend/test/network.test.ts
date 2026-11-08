import { test } from "node:test";
import assert from "node:assert/strict";
import {
  betweenness,
  buildAdjacency,
  labelPropagation,
  pageRank,
  shortestPath,
  alternativePaths,
  decay,
} from "../src/network/algorithms.ts";
import { makeServices } from "./helpers.ts";

const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

test("pageRank sums to 1 and favours hubs", () => {
  const adj = buildAdjacency(["a", "b", "c", "d"], [
    { from: "a", to: "b", weight: 1, directed: false },
    { from: "a", to: "c", weight: 1, directed: false },
    { from: "a", to: "d", weight: 1, directed: false },
  ]);
  const pr = pageRank(adj);
  const total = [...pr.values()].reduce((x, y) => x + y, 0);
  assert.ok(Math.abs(total - 1) < 1e-6);
  assert.ok(pr.get("a")! > pr.get("b")!);
});

test("label propagation finds two dense groups joined by a weak bridge", () => {
  const e = (from: string, to: string, weight = 0.9) => ({ from, to, weight, directed: false });
  const adj = buildAdjacency(
    ["a1", "a2", "a3", "b1", "b2", "b3"],
    [e("a1", "a2"), e("a2", "a3"), e("a1", "a3"), e("b1", "b2"), e("b2", "b3"), e("b1", "b3"), e("a3", "b1", 0.1)],
  );
  const labels = labelPropagation(adj);
  assert.equal(labels.get("a1"), labels.get("a2"));
  assert.equal(labels.get("a2"), labels.get("a3"));
  assert.equal(labels.get("b1"), labels.get("b3"));
  assert.notEqual(labels.get("a1"), labels.get("b1"));
  const bc = betweenness(adj);
  assert.ok(bc.get("a3")! > bc.get("a1")!, "bridge endpoints have the highest betweenness");
});

test("shortest path prefers strong ties over fewer hops", () => {
  const adj = buildAdjacency(["me", "weak", "x", "y", "t"], [
    { from: "me", to: "weak", weight: 0.05, directed: false },
    { from: "weak", to: "t", weight: 0.05, directed: false },
    { from: "me", to: "x", weight: 0.9, directed: false },
    { from: "x", to: "y", weight: 0.9, directed: false },
    { from: "y", to: "t", weight: 0.9, directed: false },
  ]);
  const p = shortestPath(adj, "me", "t")!;
  assert.deepEqual(p.nodes, ["me", "x", "y", "t"]);
  assert.ok(p.warmth > 0.7);
  const alts = alternativePaths(adj, "me", "t", 3);
  assert.equal(alts.length, 2);
  assert.deepEqual(alts[1]!.nodes, ["me", "weak", "t"]);
  assert.equal(decay(180, 180), 0.5);
});

test("network graph: evidence-based edges, group threads never create edges, interests are not relationships", () => {
  const s = makeServices();
  const me = s.people.selfId();
  const ana = s.people.create({ displayName: "Ana", interests: ["rag", "evaluation"] });
  const ben = s.people.create({ displayName: "Ben", interests: ["rag", "search"] });
  const cy = s.people.create({ displayName: "Cy" });

  s.relationships.upsertRelationship({ fromPersonId: me, toPersonId: ana.id, type: "connection", platform: "linkedin", verificationSource: "archive_import" });
  s.relationships.recordInteraction({
    platform: "linkedin", type: "message", direction: "inbound", occurredAt: daysAgo(10),
    participants: [{ personId: ana.id, role: "sender" }, { personId: me, role: "recipient" }],
  });
  s.relationships.recordInteraction({
    platform: "linkedin", type: "message", direction: "outbound", occurredAt: daysAgo(9),
    participants: [{ personId: me, role: "sender" }, { personId: ana.id, role: "recipient" }],
  });
  // Group thread with Ben and Cy: context only.
  s.relationships.recordInteraction({
    platform: "slack", type: "message", direction: "inbound", occurredAt: daysAgo(3),
    participants: [{ personId: ben.id, role: "sender" }, { personId: me, role: "member" }, { personId: cy.id, role: "member" }],
  });
  // You follow Cy (directed).
  s.relationships.upsertRelationship({ fromPersonId: me, toPersonId: cy.id, type: "follows", platform: "x", verificationSource: "observed" });

  const g = s.network.graph({ includeInterestLinks: true });
  const has = (a: string, b: string, kind: string) => g.edges.some((e) => e.kind === kind && ((e.from === a && e.to === b) || (e.from === b && e.to === a)));
  assert.ok(has(me, ana.id, "relationship"));
  assert.ok(has(me, ana.id, "interaction"));
  assert.ok(!has(ben.id, cy.id, "interaction"), "group participation does not create person-to-person edges");
  assert.ok(!has(me, ben.id, "interaction"));
  const follow = g.edges.find((e) => e.kind === "relationship" && e.to === cy.id)!;
  assert.equal(follow.directed, true);
  const anaNode = g.nodes.find((n) => n.id === ana.id)!;
  const cyNode = g.nodes.find((n) => n.id === cy.id)!;
  assert.ok(anaNode.tieStrength > cyNode.tieStrength, "reciprocal conversation + connection beats a follow");
  const link = g.interestLinks.find((l) => [l.a, l.b].includes(ana.id) && [l.a, l.b].includes(ben.id))!;
  assert.equal(link.establishesRelationship, false);
  assert.deepEqual(link.sharedInterests, ["rag"]);
  assert.ok(g.edges.every((e) => e.explanation.length > 0));
  s.close();
});

test("warm introduction paths only traverse known relationships", () => {
  const s = makeServices();
  const me = s.people.selfId();
  const friend = s.people.create({ displayName: "Friend" });
  const target = s.people.create({ displayName: "Target" });
  const stranger = s.people.create({ displayName: "Stranger", interests: ["x"] });
  assert.deepEqual(s.network.paths(target.id), []);
  s.relationships.upsertRelationship({ fromPersonId: me, toPersonId: friend.id, type: "colleague", verificationSource: "user_confirmed" });
  s.relationships.upsertRelationship({ fromPersonId: friend.id, toPersonId: target.id, type: "colleague", verificationSource: "user_confirmed" });
  const [path] = s.network.paths(target.id);
  assert.deepEqual(path!.people.map((p) => p.name), ["Me", "Friend", "Target"]);
  assert.ok(path!.steps.every((st) => st.because.length > 0));
  assert.deepEqual(s.network.paths(stranger.id), []);
  s.close();
});

test("recommendations: dormant ties whose topics match an updated project are suggested for reconnecting", async () => {
  const s = makeServices();
  const me = s.people.selfId();
  const old = s.people.create({ displayName: "Old Friend" });
  s.relationships.upsertRelationship({ fromPersonId: me, toPersonId: old.id, type: "colleague", verificationSource: "user_confirmed" });
  s.relationships.recordInteraction({
    platform: "email", type: "email", direction: "inbound", occurredAt: daysAgo(200), body: "How do you evaluate retrieval recall for RAG?",
    participants: [{ personId: old.id, role: "sender" }, { personId: me, role: "recipient" }],
  });
  const { tmpDir, writeFiles, SAMPLE_PROJECT } = await import("./helpers.ts");
  const folder = tmpDir("proj-");
  writeFiles(folder, SAMPLE_PROJECT);
  const p = s.projects.create({ folderPath: folder });
  await s.pipeline.processProject(p.id, "initial");
  const recs = s.network.recommendations();
  const r = recs.reconnect.find((x) => x.personId === old.id);
  assert.ok(r, "dormant contact is suggested");
  assert.match(r!.reason, /retrieval|recall|rag/);
  s.close();
});

test("identity: dedupe by profile URL, never by name; explicit merge moves references", () => {
  const s = makeServices();
  const a = s.people.upsertByProfile({ platform: "linkedin", url: "https://www.linkedin.com/in/Alex-K/" }, { displayName: "Alex K" });
  const b = s.people.upsertByProfile({ platform: "linkedin", url: "https://linkedin.com/in/alex-k" }, { displayName: "Alexander K" });
  assert.equal(a.person.id, b.person.id);
  const sameName = s.people.upsertByProfile({ platform: "github", handle: "alexk", externalId: "42" }, { displayName: "Alex K" });
  assert.notEqual(sameName.person.id, a.person.id, "same name alone never merges");
  assert.ok(s.people.duplicateCandidates().some((d) => [d.a, d.b].includes(a.person.id)));
  s.relationships.upsertRelationship({ fromPersonId: s.people.selfId(), toPersonId: sameName.person.id, type: "follows", platform: "github", verificationSource: "observed" });
  const merged = s.people.merge(a.person.id, sameName.person.id);
  assert.equal(s.people.profiles(merged.id).length, 2);
  assert.equal(s.people.get(sameName.person.id).merged_into, a.person.id);
  assert.equal(s.relationships.listRelationships(a.person.id).length, 1);
  s.close();
});

test("industry groups: inferred from profile and posts, user override wins, never on yourself", async () => {
  const { inferIndustry } = await import("../src/network/industries.ts");
  assert.equal(inferIndustry({ profile: ["Robotics engineer", "Kinetica Robotics"], about: [], posts: [] }), "robotics");
  assert.equal(inferIndustry({ profile: ["Quant analyst", "Harbor Capital"], about: [], posts: [] }), "finance");
  assert.equal(inferIndustry({ profile: ["ML engineer"], about: [], posts: [] }), "ai", "specific beats generic 'engineer'");
  assert.equal(inferIndustry({ profile: ["Fintech product manager"], about: [], posts: [] }), "finance", "overlapping terms don't stack");
  assert.equal(inferIndustry({ profile: ["Ivy"], about: [], posts: ["hello"] }), null);

  const s = makeServices();
  const ana = s.people.create({ displayName: "Ana", title: "Robotics engineer" });
  const ben = s.people.create({ displayName: "Ben" });
  s.opportunities.ingestPost({
    platform: "x", externalId: "1", connector: "manual", text: "Our trading desk is hiring a quant to work on payments and banking risk.",
    author: { platform: "x", externalId: "ben", displayName: "Ben" },
  });
  const g1 = s.network.graph();
  const node = (id: string) => g1.nodes.find((n) => n.id === id)!;
  assert.deepEqual(node(ana.id).industry, { id: "robotics", name: "Robotics", source: "inferred" });
  assert.equal(node(s.people.selfId()).industry, null);
  const postAuthor = g1.nodes.find((n) => n.label === "Ben" && n.id !== ben.id)!;
  assert.equal(postAuthor.industry?.id, "finance", "posts alone can place someone");
  assert.ok(g1.industries.some((i) => i.id === "finance"));

  s.people.update(ana.id, { industry: "finance" });
  assert.deepEqual(s.network.graph().nodes.find((n) => n.id === ana.id)!.industry, { id: "finance", name: "Finance", source: "user" });
  s.people.update(ana.id, { industry: null });
  assert.equal(s.network.graph().nodes.find((n) => n.id === ana.id)!.industry?.source, "inferred");
  s.close();
});
