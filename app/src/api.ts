import { createContext, useContext, useEffect, useState } from "react";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: any,
  ) {
    super(message);
  }
}

/** Calls the local backend through the Vite proxy and throws its `{ error: { code, message } }` shape. */
export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch("/api" + path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(res.status, "bad_response", res.ok ? "Unexpected response" : "The backend is not reachable. Start it with `npm run demo`.");
  }
  if (!res.ok) throw new ApiError(res.status, json?.error?.code ?? "error", json?.error?.message ?? res.statusText, json?.error?.details);
  return json as T;
}

export interface Ctx {
  /** Bumped after every mutation; data hooks refetch when it changes. */
  version: number;
  bump(): void;
  notify(text: string, undo?: () => void): void;
  go(screen: Screen): void;
  openPerson(id: string, fly?: boolean): void;
  openMenu(items: MenuItem[], x: number, y: number): void;
  status: any;
  /** Manual "scan for opportunities": rescan folders, then search sources and score new posts. */
  scan(): Promise<void>;
  scanning: boolean;
  /** Wraps an async action: reports errors as a notification and refreshes data afterwards. */
  act<T>(fn: () => Promise<T>, done?: string | ((r: T) => string | void)): Promise<T | undefined>;
}
/** Set by the Mac app's preload (desktop/src/preload.ts); undefined in a browser. */
declare global {
  interface Window {
    resona?: {
      desktop: true;
      onMenu(cb: (id: string) => void): () => void;
      getLoginItem(): Promise<boolean>;
      setLoginItem(on: boolean): Promise<void>;
    };
  }
}

export type Screen = "home" | "opps" | "posts" | "network" | "projects" | "privacy";
export type MenuItem = "-" | { label: string; key?: string; check?: boolean; disabled?: boolean; run?: () => void };

export const AppCtx = createContext<Ctx>(null as unknown as Ctx);
export const useCtx = () => useContext(AppCtx);

/** GET that refetches whenever the app's data version or `path` changes. */
export function useApi<T = any>(path: string | null): { data: T | undefined; error: string | null; reload: () => void } {
  const { version } = useCtx();
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    api<T>("GET", path)
      .then((d) => live && (setData(d), setError(null)))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [path, version, tick]);
  return { data, error, reload: () => setTick((t) => t + 1) };
}

export const initials = (n = "") =>
  n
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase() || "?";

export function ago(iso?: string | null): string {
  if (!iso) return "";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 0) return `in ${Math.ceil(-s / 86400)}d`;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} hours ago`;
  const d = Math.round(s / 86400);
  return d === 1 ? "1 day ago" : `${d} days ago`;
}

export const shortDate = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "");

export const PLATFORM: Record<string, string> = { linkedin: "LinkedIn", x: "X", github: "GitHub", hackernews: "Hacker News", email: "Email" };
export const platformName = (p?: string | null) => (p ? PLATFORM[p] ?? p : "");
export const CHANNEL: Record<string, string> = { public_reply: "Public reply", direct_message: "Personal message", email: "Email", comment: "Comment", post: "Post" };
