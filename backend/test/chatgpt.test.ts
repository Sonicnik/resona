import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { z } from "zod";
import { ChatGptAuth } from "../src/ai/chatgpt.ts";
import { AiService, AiUnavailableError } from "../src/ai/client.ts";
import type { MemoryStore } from "../src/system/mac.ts";
import { makeServices } from "./helpers.ts";

const ISSUER = "https://auth.openai.com";

/** A fake OpenAI: OpenID discovery, JWKS, token endpoint with PKCE, models, streamed Responses API, revocation. */
function fakeOpenAI() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
  const st = {
    challenge: "",
    nonce: "",
    badNonce: false,
    expiresIn: 3600,
    refreshError: "" as string,
    responseMode: "ok" as "ok" | "limit",
    tokenForms: [] as Array<Record<string, string>>,
    responseBodies: [] as any[],
    revoked: [] as Array<Record<string, string>>,
    refreshCount: 0,
  };
  const sign = (claims: Record<string, unknown>) => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const data = `${enc({ alg: "RS256", kid: "k1", typ: "JWT" })}.${enc(claims)}`;
    return `${data}.${crypto.sign("sha256", Buffer.from(data), privateKey).toString("base64url")}`;
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const sse = (events: unknown[]) =>
    new Response(new Blob(events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`)).stream(), { headers: { "Content-Type": "text/event-stream" } });

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const form = init?.body instanceof URLSearchParams ? Object.fromEntries(init.body) : {};
    if (url === `${ISSUER}/.well-known/openid-configuration`) return json({ issuer: ISSUER, jwks_uri: `${ISSUER}/jwks`, revocation_endpoint: `${ISSUER}/revoke` });
    if (url === `${ISSUER}/jwks`) return json({ keys: [jwk] });
    if (url === `${ISSUER}/revoke`) return st.revoked.push(form), new Response("", { status: 200 });
    if (url === `${ISSUER}/api/accounts/oauth/token`) {
      st.tokenForms.push(form);
      if (form.grant_type === "authorization_code") {
        const expected = crypto.createHash("sha256").update(form.code_verifier ?? "").digest("base64url");
        if (expected !== st.challenge || form.resource !== "https://api.openai.com/v1") return json({ error: "invalid_grant" }, 400);
        const id_token = sign({ iss: ISSUER, aud: form.client_id, sub: "user-1", email: "me@example.com", nonce: st.badNonce ? "other" : st.nonce, exp: Math.floor(Date.now() / 1000) + 3600 });
        return json({ access_token: "at-1", refresh_token: "rt-1", id_token, token_type: "Bearer", expires_in: st.expiresIn, scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct" });
      }
      if (st.refreshError) return json({ error: st.refreshError }, 400);
      st.refreshCount++;
      return json({ access_token: `at-r${st.refreshCount}`, refresh_token: `rt-r${st.refreshCount}`, expires_in: 3600, scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct" });
    }
    if (url === "https://api.openai.com/v1/models") return json({ models: [{ slug: "gpt-test", display_name: "GPT Test", visibility: "list" }, { slug: "hidden", visibility: "hidden" }] });
    if (url === "https://api.openai.com/v1/responses") {
      const body = JSON.parse(String(init?.body));
      st.responseBodies.push({ ...body, auth: (init?.headers as Record<string, string>).Authorization });
      if (st.responseMode === "limit") return sse([{ type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } } }]);
      return sse([
        { type: "response.created", response: {} },
        { type: "response.output_text.delta", delta: '{"body": "Hi Pri' },
        { type: "response.output_text.delta", delta: 'ya"}' },
        { type: "response.completed", response: { model: "gpt-test", usage: { input_tokens: 12, output_tokens: 7 } } },
      ]);
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  return { st, fetchFn };
}

async function signIn(auth: ChatGptAuth, st: ReturnType<typeof fakeOpenAI>["st"]) {
  const url = new URL(await auth.startSignIn());
  st.challenge = url.searchParams.get("code_challenge")!;
  st.nonce = url.searchParams.get("nonce")!;
  const cb = new URL(url.searchParams.get("redirect_uri")!);
  cb.search = new URLSearchParams({ code: "code-1", state: url.searchParams.get("state")!, client_id: "cli_issued", scope: "chatgpt.tokens.use.direct" }).toString();
  return { url, callback: await fetch(cb) };
}

test("Sign in with ChatGPT: PKCE loopback sign-in, plan-billed structured calls, refresh rotation, sign-out", async () => {
  const savedKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const s = makeServices({ ai: (db, c) => new AiService(db, c) }); // the real gateway; OfflineAi is always unavailable
  const { st, fetchFn } = fakeOpenAI();
  const auth = new ChatGptAuth(s.db, s.secrets, { fetch: fetchFn, callbackPort: 0 });
  s.chatgpt = auth;
  s.ai.chatgpt = auth;
  try {
    const first = new URL(await auth.startSignIn());
    assert.equal(first.origin + first.pathname, `${ISSUER}/api/accounts/authorize`);
    const q = first.searchParams;
    assert.equal(q.get("client_id"), "dynamic_agent_client");
    assert.equal(q.get("agent_name_hint"), "Resona");
    assert.match(q.get("ext_agent_host_id")!, /^urn:uuid:[0-9a-f-]{36}$/);
    assert.equal(q.get("code_challenge_method"), "S256");
    assert.equal(q.get("resource"), "https://api.openai.com/v1");
    assert.ok(q.get("scope")!.split(" ").includes("chatgpt.tokens.use.direct"));
    assert.match(q.get("redirect_uri")!, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    // A response with the wrong state is refused and nothing is exchanged.
    const bad = new URL(q.get("redirect_uri")!);
    bad.search = "code=x&state=forged&client_id=cli_issued";
    assert.equal((await fetch(bad)).status, 400);
    assert.equal(st.tokenForms.length, 0);
    auth.cancelSignIn();

    const { callback } = await signIn(auth, st);
    assert.equal(callback.status, 200, await callback.text());
    assert.equal(auth.status().connected, true);
    assert.equal(auth.status().email, "me@example.com");
    assert.equal(auth.status().signingIn, false);
    assert.equal(s.db.getSetting("ai.provider", ""), "chatgpt", "first connected provider becomes active");
    assert.equal(s.db.getSetting("chatgpt.clientId", ""), "cli_issued");
    assert.ok((s.secrets as MemoryStore).values.get("chatgpt")!.includes("rt-1"), "tokens live in the secret store");
    assert.equal(st.tokenForms[0]!.client_id, "cli_issued");

    // Model calls go to the Responses API with the required flags and are validated against the schema.
    const out = await s.ai.structured({ purpose: "test", projectIds: [], inputRefs: ["x"], system: "Be brief.", user: "Draft", schema: z.object({ body: z.string() }) });
    assert.deepEqual(out, { data: { body: "Hi Priya" }, model: "gpt-test" });
    const sent = st.responseBodies[0];
    assert.equal(sent.store, false);
    assert.equal(sent.stream, true);
    assert.equal(sent.model, "gpt-test");
    assert.equal(sent.auth, "Bearer at-1");
    assert.match(sent.instructions, /^Be brief\.[\s\S]*JSON Schema/);
    assert.ok(!sent.input.some((i: any) => i.role === "system"), "system items are rejected by the API");
    const row = s.db.get<{ provider: string; model: string; status: string }>("SELECT provider, model, status FROM ai_requests ORDER BY created_at DESC LIMIT 1")!;
    assert.deepEqual({ ...row }, { provider: "openai-chatgpt-plan", model: "gpt-test", status: "ok" });

    st.responseMode = "limit";
    await assert.rejects(
      () => s.ai.structured({ purpose: "test", projectIds: [], inputRefs: [], system: "s", user: "u", schema: z.object({ body: z.string() }) }),
      (e: Error) => e instanceof AiUnavailableError && /Usage limit reached/.test(e.message) && /chatgpt\.com\/settings\/usage/.test(e.message),
    );
    st.responseMode = "ok";

    // Sign out revokes the refresh token with the issued client id and forgets everything.
    await auth.signOut();
    assert.deepEqual(st.revoked[0], { token: "rt-1", token_type_hint: "refresh_token", client_id: "cli_issued" });
    assert.equal(auth.status().connected, false);
    assert.equal((s.secrets as MemoryStore).values.has("chatgpt"), false);

    // Re-authorization reuses the issued client id; an access token near expiry is refreshed and rotated.
    st.expiresIn = 30;
    const again = await signIn(auth, st);
    assert.equal(again.url.searchParams.get("client_id"), "cli_issued");
    assert.equal(again.url.searchParams.get("agent_name_hint"), null);
    assert.equal(await auth.accessToken(), "at-r1");
    const refreshForm = st.tokenForms.at(-1)!;
    assert.deepEqual(refreshForm, { grant_type: "refresh_token", client_id: "cli_issued", refresh_token: "rt-1", resource: "https://api.openai.com/v1" });
    assert.ok((s.secrets as MemoryStore).values.get("chatgpt")!.includes("rt-r1"), "rotated refresh token is saved");

    // An unusable refresh token clears the sign-in and asks the user to sign in again.
    st.expiresIn = 30;
    await signIn(auth, st);
    st.refreshError = "refresh_token_reused";
    await assert.rejects(() => auth.accessToken(), /sign in again/);
    assert.equal(auth.status().signedIn, false);
  } finally {
    auth.cancelSignIn();
    s.close();
    if (savedKey) process.env.ANTHROPIC_API_KEY = savedKey;
  }
});

test("Sign in with ChatGPT: an ID token with the wrong nonce is rejected", async () => {
  const s = makeServices();
  const { st, fetchFn } = fakeOpenAI();
  const auth = new ChatGptAuth(s.db, s.secrets, { fetch: fetchFn, callbackPort: 0 });
  try {
    st.badNonce = true;
    const { callback } = await signIn(auth, st);
    assert.equal(callback.status, 500);
    assert.equal(auth.status().connected, false);
    assert.match(auth.status().error ?? "", /nonce/);
    assert.equal((s.secrets as MemoryStore).values.has("chatgpt"), false);
  } finally {
    auth.cancelSignIn();
    s.close();
  }
});
