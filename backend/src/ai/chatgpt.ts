import http from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Db } from "../db/database.ts";
import type { SecretStore } from "../system/mac.ts";
import { AiUnavailableError } from "./client.ts";

/**
 * "Sign in with ChatGPT" with ChatGPT plan usage, OpenAI's flow for open-source and locally hosted apps
 * (developers.openai.com/siwc/token-sharing-open-source). Preview: the user's Plus/Pro plan pays for
 * Responses API calls; the app never sees an API key or the user's ChatGPT conversations.
 */
const AUTH = "https://auth.openai.com";
const API = "https://api.openai.com/v1";
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const SECRET = "chatgpt"; // Keychain account holding the token set as JSON
export const USAGE_URL = "https://chatgpt.com/settings/usage";

interface TokenSet {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  idToken: string;
  expiresAt: number;
  scope: string;
  email: string | null;
  subject: string;
}

interface Pending {
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  clientId: string | null; // set when re-authorizing an already registered client
  server: http.Server;
  timer: NodeJS.Timeout;
}

type FetchLike = typeof fetch;
const b64url = (b: Buffer) => b.toString("base64url");
const decodeJwtPart = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
const UNUSABLE_REFRESH = new Set(["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"]);

export class ChatGptAuth {
  private tokens: TokenSet | null = null;
  private pending: Pending | null = null;
  private refreshing: Promise<TokenSet> | null = null;
  private modelCache: Array<{ slug: string; displayName: string }> | null = null;
  lastError: string | null = null;

  constructor(
    private readonly db: Db,
    private readonly secrets: SecretStore,
    private readonly opts: { fetch?: FetchLike; callbackPort?: number; log?: (m: string) => void } = {},
  ) {}

  private get fetch(): FetchLike {
    return this.opts.fetch ?? fetch;
  }

  /** Reads a saved sign-in from the Keychain. Call once at startup. */
  async load(): Promise<void> {
    const raw = await this.secrets.get(SECRET);
    try {
      this.tokens = raw ? (JSON.parse(raw) as TokenSet) : null;
    } catch {
      this.tokens = null;
    }
  }

  /** Signed in and the user granted plan usage (identity alone does not authorize inference). */
  get connected(): boolean {
    return Boolean(this.tokens?.scope.split(" ").includes(PLAN_SCOPE));
  }

  status() {
    return {
      connected: this.connected,
      signedIn: Boolean(this.tokens),
      email: this.tokens?.email ?? null,
      planUsage: this.connected,
      signingIn: Boolean(this.pending),
      error: this.lastError,
      model: this.db.getSetting<string>("ai.chatgptModel", "") || null,
      usageUrl: USAGE_URL,
    };
  }

  /** Stable, opaque per-install host id, persisted before the first sign-in as the docs require. */
  private hostId(): string {
    let id = this.db.getSetting<string | null>("chatgpt.hostId", null);
    if (!id) {
      id = `urn:uuid:${crypto.randomUUID()}`;
      this.db.setSetting("chatgpt.hostId", id);
    }
    return id;
  }

  /** Starts the loopback listener and returns the URL to open in the browser. */
  async startSignIn(): Promise<string> {
    this.cancelSignIn();
    this.lastError = null;
    const verifier = b64url(crypto.randomBytes(32));
    const state = b64url(crypto.randomBytes(24));
    const nonce = b64url(crypto.randomBytes(24));
    const server = http.createServer((req, res) => void this.handleCallback(req, res));
    const port = await listenLoopback(server, this.opts.callbackPort ?? 1455);
    // The docs require 127.0.0.1 (not localhost); only the port may differ between sign-ins.
    const redirectUri = `http://127.0.0.1:${port}/auth/callback`;
    const registered = this.db.getSetting<string | null>("chatgpt.clientId", null);
    const timer = setTimeout(() => this.cancelSignIn("Sign-in timed out. Try again."), 10 * 60_000);
    timer.unref();
    this.pending = { state, nonce, verifier, redirectUri, clientId: registered, server, timer };

    const params = new URLSearchParams({
      client_id: registered ?? "dynamic_agent_client",
      response_type: "code",
      redirect_uri: redirectUri,
      scope: SCOPES,
      resource: API,
      state,
      nonce,
      code_challenge: b64url(crypto.createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
      ext_agent_host_id: this.hostId(),
    });
    if (!registered) params.set("agent_name_hint", "Resona"); // display metadata, first registration only
    return `${AUTH}/api/accounts/authorize?${params}`;
  }

  cancelSignIn(error?: string): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending.server.close();
    this.pending = null;
    if (error) this.lastError = error;
  }

  private async handleCallback(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const page = (status: number, title: string, body: string) => {
      res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      // Fixed strings only: nothing from the query string is reflected into the page.
      res.end(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:15px -apple-system,sans-serif;padding:48px;max-width:520px"><h2>${title}</h2><p>${body}</p></body>`);
    };
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const p = this.pending;
    if (url.pathname !== "/auth/callback" || !p) return page(404, "Not found", "This sign-in link is no longer active.");
    if (url.searchParams.get("state") !== p.state) return page(400, "Sign-in failed", "The sign-in response didn't match. Start again from the app.");
    if (url.searchParams.get("error")) {
      this.cancelSignIn(url.searchParams.get("error") === "access_denied" ? "Sign-in was cancelled." : "OpenAI reported a sign-in error. Try again.");
      return page(200, "Sign-in cancelled", "You can close this tab and return to the app.");
    }
    const code = url.searchParams.get("code");
    const clientId = url.searchParams.get("client_id") ?? p.clientId;
    if (!code || !clientId || (p.clientId && clientId !== p.clientId)) {
      this.cancelSignIn("OpenAI returned an incomplete sign-in. Try again.");
      return page(400, "Sign-in failed", "Return to the app and try again.");
    }
    try {
      const t = await this.tokenRequest({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: p.verifier, redirect_uri: p.redirectUri, resource: API });
      const claims = await this.verifyIdToken(String(t.id_token), clientId, p.nonce);
      const tokens: TokenSet = {
        clientId,
        accessToken: String(t.access_token),
        refreshToken: String(t.refresh_token),
        idToken: String(t.id_token),
        expiresAt: Date.now() + Number(t.expires_in ?? 3600) * 1000,
        scope: String(t.scope ?? ""),
        email: typeof claims.email === "string" ? claims.email : null,
        subject: String(claims.sub),
      };
      await this.save(tokens);
      this.db.setSetting("chatgpt.clientId", clientId);
      this.cancelSignIn();
      if (!this.connected) {
        this.lastError = "Signed in, but plan usage wasn't granted, so the app can't use your ChatGPT plan.";
        return page(200, "Signed in, plan usage not granted", "Return to the app to try again.");
      }
      // First provider connected: use it, unless a Claude key is already set up.
      if (!process.env.ANTHROPIC_API_KEY) this.db.setSetting("ai.provider", "chatgpt");
      page(200, "You're signed in", "Eligible usage in this app uses your ChatGPT plan. You can close this tab and return to the app.");
    } catch (err) {
      this.opts.log?.(`ChatGPT sign-in failed: ${(err as Error).message}`);
      this.cancelSignIn(`Sign-in failed: ${(err as Error).message}`);
      page(500, "Sign-in failed", "Return to the app for details and try again.");
    }
  }

  private async tokenRequest(form: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await this.fetch(`${AUTH}/api/accounts/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw Object.assign(new Error(`token endpoint returned ${res.status} ${String(json.error ?? "")}`), { code: String(json.error ?? "") });
    return json;
  }

  private async discovery(): Promise<{ issuer: string; jwks_uri: string; revocation_endpoint?: string }> {
    const res = await this.fetch(`${AUTH}/.well-known/openid-configuration`);
    if (!res.ok) throw new Error(`OpenID discovery failed (${res.status})`);
    return (await res.json()) as { issuer: string; jwks_uri: string; revocation_endpoint?: string };
  }

  /** Verifies the ID token's signature against OpenAI's JWKS, then issuer, audience, expiry and nonce. */
  private async verifyIdToken(idToken: string, clientId: string, nonce: string): Promise<Record<string, unknown>> {
    const [h, p, sig] = idToken.split(".");
    if (!h || !p || !sig) throw new Error("malformed ID token");
    const header = decodeJwtPart(h) as { alg?: string; kid?: string };
    const claims = decodeJwtPart(p) as Record<string, unknown>;
    const disco = await this.discovery();
    const jwks = (await (await this.fetch(disco.jwks_uri)).json()) as { keys: Array<Record<string, unknown>> };
    const jwk = jwks.keys.find((k) => k.kid === header.kid);
    if (!jwk) throw new Error("ID token signing key not found");
    const key = crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: "jwk" });
    const data = Buffer.from(`${h}.${p}`);
    const signature = Buffer.from(sig, "base64url");
    // shortcut: RS256 and ES256 only, the algorithms OpenID providers use in practice; add others if OpenAI changes.
    const ok =
      header.alg === "RS256" ? crypto.verify("sha256", data, key, signature)
      : header.alg === "ES256" ? crypto.verify("sha256", data, { key, dsaEncoding: "ieee-p1363" }, signature)
      : false;
    if (!ok) throw new Error(`ID token signature is invalid or uses an unsupported algorithm (${header.alg})`);
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== disco.issuer) throw new Error("ID token issuer mismatch");
    if (!aud.includes(clientId)) throw new Error("ID token audience mismatch");
    if (Number(claims.exp) * 1000 <= Date.now()) throw new Error("ID token expired");
    if (claims.nonce !== nonce) throw new Error("ID token nonce mismatch");
    return claims;
  }

  private async save(tokens: TokenSet | null): Promise<void> {
    this.tokens = tokens;
    if (tokens) await this.secrets.set(SECRET, JSON.stringify(tokens));
    else await this.secrets.delete(SECRET);
  }

  /** A valid access token, refreshing (serialized, with rotation) when it is about to expire. */
  async accessToken(): Promise<string> {
    if (!this.tokens) throw new AiUnavailableError("Not signed in with ChatGPT. Use Continue with ChatGPT in Privacy.");
    if (Date.now() < this.tokens.expiresAt - 60_000) return this.tokens.accessToken;
    this.refreshing ??= this.refresh().finally(() => (this.refreshing = null));
    return (await this.refreshing).accessToken;
  }

  private async refresh(): Promise<TokenSet> {
    const cur = this.tokens!;
    try {
      // Omit scope so the grant is kept; send the issued client id, not dynamic_agent_client.
      const t = await this.tokenRequest({ grant_type: "refresh_token", client_id: cur.clientId, refresh_token: cur.refreshToken, resource: API });
      const next: TokenSet = {
        ...cur,
        accessToken: String(t.access_token),
        refreshToken: String(t.refresh_token ?? cur.refreshToken),
        idToken: String(t.id_token ?? cur.idToken),
        expiresAt: Date.now() + Number(t.expires_in ?? 3600) * 1000,
        scope: String(t.scope ?? cur.scope),
      };
      await this.save(next);
      return next;
    } catch (err) {
      if (UNUSABLE_REFRESH.has((err as { code?: string }).code ?? "")) {
        await this.save(null);
        throw new AiUnavailableError("Your ChatGPT sign-in has expired. Use Continue with ChatGPT in Privacy to sign in again.");
      }
      throw err;
    }
  }

  /** Revokes the renewable session (best effort) and forgets the tokens. */
  async signOut(): Promise<void> {
    const cur = this.tokens;
    this.cancelSignIn();
    await this.save(null);
    this.modelCache = null;
    this.lastError = null;
    if (!cur) return;
    try {
      const disco = await this.discovery();
      if (disco.revocation_endpoint) {
        await this.fetch(disco.revocation_endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: cur.refreshToken, token_type_hint: "refresh_token", client_id: cur.clientId }),
        });
      }
    } catch (err) {
      this.opts.log?.(`ChatGPT revocation failed (tokens were removed locally): ${(err as Error).message}`);
    }
  }

  /** Models available to the signed-in account. */
  async models(): Promise<Array<{ slug: string; displayName: string }>> {
    if (this.modelCache) return this.modelCache;
    const res = await this.fetch(`${API}/models`, { headers: { Authorization: `Bearer ${await this.accessToken()}` } });
    if (!res.ok) throw await this.apiError(res);
    const json = (await res.json()) as { models?: Array<Record<string, unknown>>; data?: Array<Record<string, unknown>> };
    this.modelCache = (json.models ?? json.data ?? [])
      .filter((m) => m.visibility === undefined || m.visibility === "list")
      .map((m) => ({ slug: String(m.slug ?? m.id), displayName: String(m.display_name ?? m.slug ?? m.id) }));
    return this.modelCache;
  }

  async chosenModel(): Promise<string> {
    const saved = this.db.getSetting<string>("ai.chatgptModel", "");
    if (saved) return saved;
    const first = (await this.models())[0]?.slug;
    if (!first) throw new AiUnavailableError("No models are available to this ChatGPT account.");
    return first;
  }

  /** One streamed Responses API call billed to the user's plan. Success only after response.completed. */
  async respond(model: string, instructions: string, input: string): Promise<{ text: string; model: string; inputTokens?: number; outputTokens?: number }> {
    const res = await this.fetch(`${API}/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json" },
      // store:false and stream:true are required in this flow; system items are rejected, so use instructions.
      body: JSON.stringify({ model, instructions, input: [{ role: "user", content: input }], store: false, stream: true }),
    });
    if (!res.ok || !res.body) throw await this.apiError(res);
    let text = "";
    let completed: Record<string, any> | null = null;
    for await (const ev of sseEvents(res.body)) {
      if (ev.type === "response.output_text.delta") text += String(ev.delta ?? "");
      else if (ev.type === "response.completed") completed = ev.response ?? {};
      else if (ev.type === "response.failed") throw planError(0, ev.response?.error?.code, ev.response?.error?.message);
      else if (ev.type === "response.incomplete") throw new Error(`ChatGPT stopped early (${ev.response?.incomplete_details?.reason ?? "incomplete"}). Try again with less material.`);
    }
    if (!completed) throw new Error("The ChatGPT response stream ended before it completed. Try again.");
    return { text, model: String(completed.model ?? model), inputTokens: completed.usage?.input_tokens, outputTokens: completed.usage?.output_tokens };
  }

  private async apiError(res: Response): Promise<Error> {
    const json = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string }; detail?: string };
    return planError(res.status, json.error?.code, json.error?.message ?? json.detail);
  }
}

/** Maps OpenAI's plan-sharing errors to messages that say what to do, as the docs ask. */
export function planError(status: number, code?: string, message?: string): Error {
  switch (code) {
    case "subscription_sharing_usage_limit_exceeded":
      return new AiUnavailableError(`Usage limit reached. Review your plan or this app's limit in ChatGPT settings: ${USAGE_URL}`);
    case "subscription_sharing_user_not_eligible":
      return new AiUnavailableError("This ChatGPT account can't share plan usage with apps (it needs an eligible Plus or Pro plan).");
    case "subscription_sharing_usage_unavailable":
      return new Error("ChatGPT plan usage is temporarily unavailable. The agent will try again later.");
  }
  if (status === 401) return new AiUnavailableError("Your ChatGPT sign-in is no longer valid. Sign in again in Privacy.");
  return new Error(`ChatGPT request failed${status ? ` (${status})` : ""}${code ? ` [${code}]` : ""}: ${message ?? "unknown error"}`);
}

async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, any>> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i).replace(/^\r?\n\r?\n/, "");
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (data && data !== "[DONE]") yield JSON.parse(data);
    }
  }
}

async function listenLoopback(server: http.Server, port: number): Promise<number> {
  const attempt = (p: number) =>
    new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(p, "127.0.0.1", () => {
        server.off("error", reject);
        resolve((server.address() as AddressInfo).port);
      });
    });
  try {
    return await attempt(port);
  } catch (err) {
    // Preferred port busy: any loopback port works, since only the port may vary between sign-ins.
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE" && port !== 0) return attempt(0);
    throw err;
  }
}
