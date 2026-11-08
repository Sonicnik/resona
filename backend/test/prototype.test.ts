import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/api/app.ts";
import { MemoryStore } from "../src/system/mac.ts";
import { makeServices, OfflineAi, StubAi, tmpDir, writeFiles, SAMPLE_PROJECT } from "./helpers.ts";

async function serve(s: ReturnType<typeof makeServices>) {
  const server = createApp(s).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, text, json: text ? JSON.parse(text) : null };
  };
  return { call, close: () => new Promise((r) => server.close(r)) };
}

class RejectingKeyAi extends OfflineAi {
  override async verifyKey(): Promise<void> {
    throw Object.assign(new Error("invalid x-api-key"), { status: 401 });
  }
}

test("credentials: stored in the secret store, never echoed, bad Anthropic keys rejected", async () => {
  const saved = { gh: process.env.GITHUB_TOKEN, ant: process.env.ANTHROPIC_API_KEY };
  delete process.env.GITHUB_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  const s = makeServices({ ai: (db, c) => new RejectingKeyAi(db, c) });
  const store = s.secrets as MemoryStore;
  const { call, close } = await serve(s);
  try {
    const list = await call("GET", "/credentials");
    assert.deepEqual(list.json.map((c: { name: string }) => c.name), ["anthropic", "github", "x"]);
    assert.ok(list.json.every((c: { connected: boolean }) => !c.connected));

    const token = "ghp_testtoken1234wxyz";
    const put = await call("PUT", "/credentials/github", { value: token });
    assert.equal(put.status, 200);
    assert.deepEqual(put.json, { name: "github", connected: true, hint: "…wxyz" });
    assert.ok(!put.text.includes(token), "the value is never returned");
    assert.equal(store.values.get("github"), token);
    assert.equal(process.env.GITHUB_TOKEN, token);
    assert.ok(!(await call("GET", "/credentials")).text.includes(token));
    assert.ok(s.connectors.list().find((c) => c.id === "github")?.note?.startsWith("Authenticated"), "connector picks up the token without a restart");

    const bad = await call("PUT", "/credentials/anthropic", { value: "sk-ant-not-a-real-key" });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, "invalid_credential");
    assert.ok(!bad.text.includes("sk-ant-not-a-real-key"));
    assert.equal(store.values.has("anthropic"), false);

    const oat = await call("PUT", "/credentials/anthropic", { value: "sk-ant-oat01-subscriptiontoken" });
    assert.equal(oat.status, 400);
    assert.match(oat.json.error.message, /subscription login token/);
    assert.equal(store.values.has("anthropic"), false);

    // A pasted `export NAME="value"` line is reduced to the value.
    await call("PUT", "/credentials/x", { value: ' export X_BEARER_TOKEN="AAAAbearer9876" ' });
    assert.equal(store.values.get("x"), "AAAAbearer9876");
    await call("DELETE", "/credentials/x");

    assert.equal((await call("PUT", "/credentials/nope", { value: "12345678" })).status, 404);
    const del = await call("DELETE", "/credentials/github");
    assert.equal(del.json.connected, false);
    assert.equal(store.values.has("github"), false);
    assert.equal(process.env.GITHUB_TOKEN, undefined);
  } finally {
    await close();
    s.close();
    if (saved.gh) process.env.GITHUB_TOKEN = saved.gh;
    if (saved.ant) process.env.ANTHROPIC_API_KEY = saved.ant;
  }
});

test("credentials: a Keychain failure never echoes the key", async () => {
  const saved = process.env.GITHUB_TOKEN;
  const s = makeServices();
  s.secrets.set = async (_n, value) => {
    throw Object.assign(new Error(`Command failed: security add-generic-password -w ${value}`), { stderr: "SecKeychainItemCreateFromContent: User interaction is not allowed." });
  };
  const { call, close } = await serve(s);
  try {
    const res = await call("PUT", "/credentials/github", { value: "ghp_secretvalue999" });
    assert.equal(res.status, 500);
    assert.equal(res.json.error.code, "keychain_error");
    assert.match(res.json.error.message, /User interaction is not allowed/);
    assert.ok(!res.text.includes("ghp_secretvalue999"));
    assert.equal(process.env.GITHUB_TOKEN, saved);
  } finally {
    await close();
    s.close();
  }
});

test("global pause: scheduled jobs skip while paused and catch up after resuming", async () => {
  const s = makeServices();
  let runs = 0;
  s.scheduler.register({ name: "probe", intervalMs: 60_000, run: async () => ++runs });
  const { call, close } = await serve(s);
  try {
    assert.equal((await call("GET", "/status")).json.agent.state, "running");
    assert.equal((await call("PATCH", "/settings", { "agent.paused": true })).json["agent.paused"], true);
    await s.scheduler.tick();
    assert.equal(runs, 0);
    assert.equal((await call("GET", "/status")).json.agent.state, "paused");

    await call("PATCH", "/settings", { "agent.paused": false });
    await s.scheduler.tick();
    assert.equal(runs, 1);
    assert.ok(s.scheduler.resumedAfterPauseAt);
    assert.equal((await call("GET", "/status")).json.agent.state, "catching_up");
  } finally {
    await close();
    s.close();
  }
});

test("native picker: returns the chosen path or null on cancel", async () => {
  const s = makeServices();
  const asked: string[] = [];
  s.chooser = async (kind, prompt) => {
    asked.push(`${kind}:${prompt}`);
    return kind === "folder" ? "/Users/me/code/demo" : null;
  };
  const { call, close } = await serve(s);
  try {
    assert.deepEqual((await call("POST", "/system/choose", { kind: "folder", prompt: "Add a project" })).json, { path: "/Users/me/code/demo" });
    assert.deepEqual((await call("POST", "/system/choose", { kind: "file" })).json, { path: null });
    assert.deepEqual(asked, ["folder:Add a project", "file:Choose a folder"]);
    assert.equal((await call("POST", "/system/choose", { kind: "disk" })).status, 400);
  } finally {
    await close();
    s.close();
  }
});

test("follow-up drafts: template offline, AI when the folder allows it, same approval flow", async () => {
  for (const mode of ["template", "ai"] as const) {
    const s = makeServices(
      mode === "ai"
        ? {
            ai: (db, c) =>
              new StubAi(db, c, (req) =>
                req.system.includes("draft an individual reply")
                  ? { body: "Hi Priya, here is the eval notebook you asked about.", rationale: "Answers her ask.", source_refs: ["README.md:1-20"], cautions: [] }
                  : (() => {
                      throw new Error("offline summary expected");
                    })(),
              ),
          }
        : {},
    );
    const folder = tmpDir("proj-");
    writeFiles(folder, SAMPLE_PROJECT);
    const project = s.projects.create({ folderPath: folder, aiPermission: mode === "ai" ? "allowed" : "denied" });
    await s.pipeline.processProject(project.id, "initial");
    const priya = s.people.create({ displayName: "Priya Menon", status: "contact" });
    s.relationships.recordInteraction({
      platform: "linkedin",
      type: "message",
      direction: "inbound",
      occurredAt: "2026-10-16T10:00:00Z",
      body: "Could you share the eval notebook?",
      participants: [
        { personId: priya.id, role: "sender" },
        { personId: s.people.selfId(), role: "recipient" },
      ],
    });
    s.relationships.createFollowup({ personId: priya.id, reason: "Send the eval notebook she asked about", projectId: project.id });

    const { call, close } = await serve(s);
    try {
      const res = await call("POST", `/people/${priya.id}/drafts`, {});
      assert.equal(res.status, 201, res.text);
      assert.equal(res.json.kind, "outreach");
      assert.equal(res.json.opportunityId, null);
      assert.equal(res.json.personId, priya.id);
      assert.equal(res.json.platform, "linkedin");
      assert.equal(res.json.revision.author, mode);
      assert.match(res.json.revision.body, /Priya/);
      if (mode === "ai") {
        const history = (await call("GET", "/processing-history")).json;
        assert.ok(history.some((h: { input_refs: string[] }) => h.input_refs.includes(`person:${priya.id}`)));
      }
      const action = await call("POST", `/drafts/${res.json.id}/actions`, { destination: "linkedin:priya" });
      assert.equal(action.status, 201, action.text);
      assert.equal((await call("POST", `/people/${s.people.selfId()}/drafts`, {})).status, 400);
    } finally {
      await close();
      s.close();
    }
  }
});

test("posts: write your own, edit title and text, approve, mark posted", async () => {
  const s = makeServices();
  const folder = tmpDir("proj-");
  writeFiles(folder, SAMPLE_PROJECT);
  const project = s.projects.create({ folderPath: folder, aiPermission: "denied" }); // never summarized: own posts don't need it
  const { call, close } = await serve(s);
  try {
    assert.equal((await call("POST", `/projects/${project.id}/post-drafts`, { platform: "linkedin", text: "   " })).status, 400);
    const created = await call("POST", `/projects/${project.id}/post-drafts`, { platform: "linkedin", title: "My take", text: "We cut eval time in half." });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.json.kind, "post");
    assert.equal(created.json.revision.author, "user");
    assert.equal(created.json.revision.title, "My take");

    const edited = await call("POST", `/drafts/${created.json.id}/revisions`, { title: "My honest take", body: "We cut eval time in half. Here is how." });
    assert.equal(edited.json.currentRevision, 2);
    assert.equal(edited.json.revision.title, "My honest take");

    const action = await call("POST", `/drafts/${created.json.id}/actions`, { destination: "linkedin feed" });
    assert.equal((await call("POST", `/actions/${action.json.id}/approve`, { revision: 2 })).json.state, "approved");
    assert.equal((await call("POST", `/actions/${action.json.id}/mark-sent`, {})).json.action.state, "sent");
  } finally {
    await close();
    s.close();
  }
});
