import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { Db } from "../db/database.ts";
import type { ChatGptAuth } from "./chatgpt.ts";
import type { Config } from "../config.ts";
import { newId, nowIso } from "../lib/util.ts";

export class AiUnavailableError extends Error {
  readonly code = "ai_unavailable";
}
export class AiBlockedError extends Error {
  readonly code = "ai_permission_denied";
}
export class AiRefusedError extends Error {
  readonly code = "ai_refused";
}

export interface StructuredRequest<S extends z.ZodType> {
  purpose: string;
  /** Every project whose material appears in the request; each must have AI permission. */
  projectIds: string[];
  /** File/line references or record ids describing what is being sent, kept in processing history. */
  inputRefs: string[];
  system: string;
  user: string;
  schema: S;
  maxTokens?: number;
}

export interface ModelCall {
  output: unknown;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Gateway for every model request. It enforces per-folder AI permission, records processing
 * history (what was sent, for which purpose, to which provider/model) and returns validated,
 * typed output. Nothing outward-facing is ever sent from here; it only produces drafts and summaries.
 */
export class AiService {
  private client: Anthropic | null = null;
  /** Set by the container; used when the user picks their ChatGPT plan as the provider. */
  chatgpt: ChatGptAuth | null = null;

  constructor(
    protected readonly db: Db,
    protected readonly config: Config,
  ) {}

  /** "anthropic" (API key) or "chatgpt" (the user's ChatGPT plan via Sign in with ChatGPT). */
  get provider(): "anthropic" | "chatgpt" {
    return this.db.getSetting<string>("ai.provider", "anthropic") === "chatgpt" ? "chatgpt" : "anthropic";
  }

  /** Claude credentials resolve from ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile. */
  isAvailable(): boolean {
    if (this.db.getSetting<boolean>("ai.disabled", false)) return false;
    if (this.provider === "chatgpt") return Boolean(this.chatgpt?.connected);
    return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE);
  }

  get model(): string {
    if (this.provider === "chatgpt") return this.db.getSetting<string>("ai.chatgptModel", "") || "ChatGPT plan";
    return this.config.ai.model;
  }

  get maxContextChars(): number {
    return this.config.ai.maxContextChars;
  }

  private getClient(): Anthropic {
    if (!this.client) this.client = new Anthropic({ maxRetries: 3 });
    return this.client;
  }

  /** Drops the cached client so a key connected or removed in-app takes effect immediately. */
  resetClient(): void {
    this.client = null;
  }

  /** Throws (with `status` 401 for a bad key) unless the key authenticates. Sends no user material. */
  async verifyKey(apiKey: string): Promise<void> {
    await new Anthropic({ apiKey, maxRetries: 1 }).models.list({ limit: 1 });
  }

  /** Raises AiBlockedError unless every project allows AI processing. */
  assertPermitted(projectIds: string[]): void {
    for (const id of projectIds) {
      const row = this.db.get<{ ai_permission: string; name: string }>(
        "SELECT ai_permission, name FROM projects WHERE id = ?",
        [id],
      );
      if (!row || row.ai_permission !== "allowed") {
        throw new AiBlockedError(
          `AI processing is not permitted for folder "${row?.name ?? id}". Grant permission per folder before sending its content to a model provider.`,
        );
      }
    }
  }

  canUseFor(projectIds: string[]): boolean {
    if (!this.isAvailable()) return false;
    try {
      this.assertPermitted(projectIds);
      return true;
    } catch {
      return false;
    }
  }

  async structured<S extends z.ZodType>(req: StructuredRequest<S>): Promise<{ data: z.infer<S>; model: string }> {
    const base = {
      purpose: req.purpose,
      projectId: req.projectIds[0] ?? null,
      inputRefs: req.inputRefs,
      inputChars: req.system.length + req.user.length,
    };
    try {
      this.assertPermitted(req.projectIds);
    } catch (err) {
      this.record({ ...base, status: "blocked", error: (err as Error).message });
      throw err;
    }
    if (!this.isAvailable()) {
      throw new AiUnavailableError(
        this.provider === "chatgpt" ? "Not signed in with ChatGPT. Use Continue with ChatGPT in Privacy." : "No Claude API credentials configured. Connect Claude in Privacy.",
      );
    }
    try {
      const call = await this.callModel(req);
      const parsed = req.schema.safeParse(call.output);
      if (!parsed.success) throw new Error(`model output failed validation: ${parsed.error.message}`);
      this.record({ ...base, status: "ok", model: call.model, inputTokens: call.inputTokens, outputTokens: call.outputTokens });
      return { data: parsed.data, model: call.model };
    } catch (err) {
      const status = err instanceof AiRefusedError ? "refused" : "error";
      this.record({ ...base, status, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  /** Performs the provider call. Overridable in tests. */
  protected async callModel<S extends z.ZodType>(req: StructuredRequest<S>): Promise<ModelCall> {
    if (this.provider === "chatgpt") return this.callChatGpt(req);
    const client = this.getClient();
    try {
      const response = await client.beta.messages.parse({
        model: this.config.ai.model,
        max_tokens: req.maxTokens ?? 16000,
        // Server-side fallback: if a safeguard declines, the API retries on a suitable model.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: {
          effort: this.config.ai.effort,
          format: betaZodOutputFormat(req.schema),
        },
        system: req.system,
        messages: [{ role: "user", content: req.user }],
      });
      if (response.stop_reason === "refusal") {
        throw new AiRefusedError("The model declined this request.");
      }
      if (response.stop_reason === "max_tokens") {
        throw new Error("The model response was cut off (max_tokens). Try again with less material.");
      }
      return {
        output: response.parsed_output,
        model: response.model,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) {
        throw new AiUnavailableError("Claude API authentication failed; check ANTHROPIC_API_KEY.");
      }
      if (err instanceof Anthropic.RateLimitError) {
        throw new Error("Claude API rate limit reached; the scheduler will retry later.");
      }
      if (err instanceof Anthropic.APIConnectionError) {
        throw new Error("Could not reach the Claude API; processing will catch up when the network is back.");
      }
      throw err;
    }
  }

  /**
   * ChatGPT plan path. Structured outputs aren't documented for this preview flow, so the schema goes in the
   * instructions and structured() validates the reply with the same Zod schema.
   */
  private async callChatGpt<S extends z.ZodType>(req: StructuredRequest<S>): Promise<ModelCall> {
    if (!this.chatgpt) throw new AiUnavailableError("ChatGPT sign-in is not available.");
    const schema = JSON.stringify(z.toJSONSchema(req.schema));
    const instructions = `${req.system}\n\nReply with only one JSON object, no prose and no code fences, that matches this JSON Schema:\n${schema}`;
    const r = await this.chatgpt.respond(await this.chatgpt.chosenModel(), instructions, req.user);
    const start = r.text.indexOf("{");
    const end = r.text.lastIndexOf("}");
    let output: unknown;
    try {
      output = JSON.parse(r.text.slice(start, end + 1));
    } catch {
      throw new Error("ChatGPT did not return valid JSON. Try again.");
    }
    return { output, model: r.model, inputTokens: r.inputTokens, outputTokens: r.outputTokens };
  }

  private record(entry: {
    purpose: string;
    projectId: string | null;
    inputRefs: string[];
    inputChars: number;
    status: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    error?: string;
  }): void {
    this.db.run(
      `INSERT INTO ai_requests (id, purpose, project_id, provider, model, input_refs, input_chars, input_tokens, output_tokens, status, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId("air"),
        entry.purpose,
        entry.projectId,
        this.provider === "chatgpt" ? "openai-chatgpt-plan" : "anthropic",
        entry.model ?? this.model,
        entry.inputRefs,
        entry.inputChars,
        entry.inputTokens ?? null,
        entry.outputTokens ?? null,
        entry.status,
        entry.error ?? null,
        nowIso(),
      ],
    );
  }
}
