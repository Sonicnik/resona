import crypto from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function sha256(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function daysBetween(a: string | Date, b: string | Date): number {
  const ta = typeof a === "string" ? Date.parse(a) : a.getTime();
  const tb = typeof b === "string" ? Date.parse(b) : b.getTime();
  return Math.abs(tb - ta) / 86_400_000;
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value === "") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = "error",
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} not found`, "not_found");
export const conflict = (message: string, details?: unknown) => new HttpError(409, message, "conflict", details);
export const badRequest = (message: string, details?: unknown) => new HttpError(400, message, "bad_request", details);

export function clamp(x: number, lo = 0, hi = 1): number {
  return Math.min(hi, Math.max(lo, x));
}

export function uniq<T>(items: Iterable<T>): T[] {
  return [...new Set(items)];
}
