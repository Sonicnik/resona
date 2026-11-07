import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/api/app.ts";
import { makeServices, tmpDir, writeFiles, SAMPLE_PROJECT, MATCHING_POST } from "./helpers.ts";

test("HTTP API: end-to-end outreach workflow", async () => {
  const s = makeServices();
  const server = createApp(s).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };

  try {
    assert.equal((await call("GET", "/health")).json.ok, true);
    assert.equal((await call("GET", "/health", undefined, { Origin: "https://evil.example" })).status, 403);
    assert.equal((await call("POST", "/projects", { folderPath: "/definitely/not/here" })).status, 400);
    assert.equal((await call("POST", "/projects", { nope: 1 })).json.error.code, "bad_request");

    const folder = tmpDir("proj-");
    writeFiles(folder, SAMPLE_PROJECT);
    const created = await call("POST", "/projects", { folderPath: folder });
    assert.equal(created.status, 201);
    const pid = created.json.project.id;
    assert.equal((await call("POST", "/projects", { folderPath: folder })).status, 409);

    const detail = await call("GET", `/projects/${pid}`);
    assert.equal(detail.json.files.indexed, 3);
    assert.ok(detail.json.context.keywords.length > 0);
    assert.ok(detail.json.openQuestions.length > 0);
    const q = detail.json.openQuestions[0];
    assert.equal((await call("POST", `/questions/${q.id}/answer`, { answer: "I built the metrics module and the evaluation runner." })).status, 200);
    const resum = await call("POST", `/projects/${pid}/summarize`, {});
    assert.equal(resum.json.status, "created", "an answered question changes the source fingerprint");

    const post = await call("POST", "/source-posts", {
      platform: "linkedin",
      url: "https://www.linkedin.com/posts/jane-1",
      text: MATCHING_POST,
      publishedAt: new Date().toISOString(),
      author: { url: "https://www.linkedin.com/in/jane", displayName: "Jane Doe" },
    });
    assert.equal(post.status, 201);
    assert.equal(post.json.opportunities.length, 1);
    const oppId = post.json.opportunities[0].opportunityId;

    const list = await call("GET", "/opportunities?state=new");
    assert.equal(list.json[0].id, oppId);

    const draft = await call("POST", `/opportunities/${oppId}/drafts`, {});
    assert.equal(draft.status, 201);
    const action = await call("POST", `/drafts/${draft.json.id}/actions`, { destination: "https://www.linkedin.com/posts/jane-1" });
    assert.equal((await call("POST", `/actions/${action.json.id}/mark-sent`, {})).status, 409);
    assert.equal((await call("POST", `/actions/${action.json.id}/approve`, { revision: 1 })).json.state, "approved");
    const sent = await call("POST", `/actions/${action.json.id}/mark-sent`, { externalMessageId: "x1" });
    assert.equal(sent.json.action.state, "sent");

    const person = await call("GET", `/people/${post.json.authorPersonId}`);
    assert.equal(person.json.connectionStatus.sentByYou, 1);
    assert.equal(person.json.connectionStatus.repliesReceived, 0);
    assert.equal(person.json.discoveredVia.length, 1);
    assert.equal(person.json.projects[0].projectId, pid);

    const graph = await call("GET", "/network/graph?includeInterestLinks=1");
    assert.ok(graph.json.nodes.some((n: { isSelf: boolean }) => n.isSelf));
    assert.ok(graph.json.legend.proposed);
    const recs = await call("GET", "/network/recommendations");
    assert.ok(Array.isArray(recs.json.engage));

    const search = await call("GET", "/search?q=hybrid%20search&types=project_file");
    assert.ok(search.json[0].ref.includes(".md:"));

    const vault = await call("POST", "/vault/sync");
    assert.ok(vault.json.written > 0);
    const review = await call("POST", "/reviews");
    assert.match(review.json.markdown, /Outreach sent: 1/);

    const settings = await call("PATCH", "/settings", { "schedule.discovery.enabled": true });
    assert.equal(settings.json["schedule.discovery.enabled"], true);
    assert.equal((await call("PATCH", "/settings", { "not.a.setting": 1 })).status, 400);

    const history = await call("GET", "/processing-history");
    assert.deepEqual(history.json, [], "offline mode sends nothing to a model provider");
    const connectors = await call("GET", "/connectors");
    assert.equal(connectors.json.find((c: { id: string }) => c.id === "linkedin").available, false);
    assert.equal((await call("GET", "/nope")).status, 404);
  } finally {
    server.close();
    s.close();
  }
});
