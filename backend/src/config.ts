import os from "node:os";
import path from "node:path";

export interface Config {
  dataDir: string;
  dbPath: string;
  vaultDir: string;
  host: string;
  port: number;
  /** Browser origins allowed to call the API (e.g. the app's webview dev server). */
  allowedOrigins: string[];
  /** Optional bearer token required on every request. */
  apiToken?: string;
  /** Built UI (app/dist) to serve at `/`, so the Mac app loads the UI and API from one origin. */
  staticDir?: string;
  ai: {
    model: string;
    effort: "low" | "medium" | "high" | "xhigh" | "max";
    /** Hard cap on characters of project material sent in a single summarization request. */
    maxContextChars: number;
  };
  connectors: {
    githubToken?: string;
    xBearerToken?: string;
  };
  schedulerEnabled: boolean;
  watchEnabled: boolean;
  /** Embedding model identifier stored next to every vector. */
  embeddingModel: string;
}

function defaultDataDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Resona");
  }
  return path.join(os.homedir(), ".resona");
}

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const dataDir = path.resolve(env.RESONA_DATA_DIR || defaultDataDir());
  const effortEnv = env.RESONA_AI_EFFORT as Config["ai"]["effort"] | undefined;
  const config: Config = {
    dataDir,
    dbPath: path.join(dataDir, "resona.db"),
    vaultDir: path.resolve(env.RESONA_VAULT_DIR || path.join(dataDir, "vault")),
    host: env.RESONA_HOST || "127.0.0.1",
    port: Number(env.RESONA_PORT || 4317),
    // Default: the app's Vite dev server (app/vite.config.ts).
    allowedOrigins: (env.RESONA_ALLOWED_ORIGINS ?? "http://localhost:1420").split(",").map((o) => o.trim()).filter(Boolean),
    apiToken: env.RESONA_API_TOKEN || undefined,
    staticDir: env.RESONA_STATIC_DIR ? path.resolve(env.RESONA_STATIC_DIR) : undefined,
    ai: {
      model: env.RESONA_MODEL || "claude-opus-5-5",
      effort: effortEnv && EFFORTS.includes(effortEnv) ? effortEnv : "medium",
      maxContextChars: Number(env.RESONA_MAX_CONTEXT_CHARS || 400_000),
    },
    connectors: {
      githubToken: env.GITHUB_TOKEN || undefined,
      xBearerToken: env.X_BEARER_TOKEN || undefined,
    },
    schedulerEnabled: flag(env.RESONA_SCHEDULER, true),
    watchEnabled: flag(env.RESONA_WATCH, true),
    embeddingModel: "resona-hash-v1-512",
  };
  return { ...config, ...overrides };
}
