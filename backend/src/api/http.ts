import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { HttpError, badRequest } from "../lib/util.ts";
import { AiBlockedError, AiRefusedError, AiUnavailableError } from "../ai/client.ts";
import { ConnectorUnavailableError } from "../connectors/types.ts";

export function body<S extends z.ZodType>(schema: S, req: Request): z.infer<S> {
  const res = schema.safeParse(req.body ?? {});
  if (!res.success) {
    throw badRequest("invalid request body", res.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  return res.data;
}

export const query = {
  str(req: Request, name: string): string | undefined {
    const v = req.query[name];
    return typeof v === "string" && v !== "" ? v : undefined;
  },
  num(req: Request, name: string): number | undefined {
    const v = query.str(req, name);
    if (v === undefined) return undefined;
    const n = Number(v);
    if (Number.isNaN(n)) throw badRequest(`query parameter ${name} must be a number`);
    return n;
  },
  bool(req: Request, name: string): boolean | undefined {
    const v = query.str(req, name);
    if (v === undefined) return undefined;
    return ["1", "true", "yes"].includes(v.toLowerCase());
  },
  list(req: Request, name: string): string[] | undefined {
    const v = query.str(req, name);
    return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  },
};

export function param(req: Request, name: string): string {
  const v = req.params[name];
  if (typeof v !== "string" || !v) throw badRequest(`missing path parameter ${name}`);
  return v;
}

/** Maps domain errors to HTTP responses with a stable `{ error: { code, message, details } }` shape. */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  let status = 500;
  let code = "internal_error";
  let message = "Unexpected error";
  let details: unknown;
  if (err instanceof HttpError) {
    ({ status, code, message, details } = err);
  } else if (err instanceof AiBlockedError) {
    status = 403;
    code = err.code;
    message = err.message;
  } else if (err instanceof AiUnavailableError || err instanceof ConnectorUnavailableError) {
    status = 503;
    code = err.code;
    message = err.message;
  } else if (err instanceof AiRefusedError) {
    status = 422;
    code = err.code;
    message = err.message;
  } else if (err instanceof SyntaxError && "body" in (err as object)) {
    status = 400;
    code = "invalid_json";
    message = "Request body is not valid JSON";
  } else if (err instanceof Error) {
    message = err.message;
    if (/UNIQUE constraint failed/.test(err.message)) {
      status = 409;
      code = "conflict";
    } else if (/FOREIGN KEY constraint failed/.test(err.message)) {
      status = 400;
      code = "invalid_reference";
    }
  }
  if (status >= 500) console.error("[resona]", err);
  res.status(status).json({ error: { code, message, ...(details !== undefined ? { details } : {}) } });
}

/**
 * The API is meant for the local Mac app only. Rejects requests whose Host is not loopback (DNS
 * rebinding) and browser requests from origins that are not explicitly allowed; optionally requires
 * a bearer token.
 */
export function localOnly(opts: { allowedOrigins: string[]; token?: string }) {
  return (req: Request, res: Response, next: NextFunction) => {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
    if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
      res.status(403).json({ error: { code: "forbidden_host", message: "The Resona API only accepts local requests." } });
      return;
    }
    const origin = req.headers.origin;
    if (origin) {
      if (!opts.allowedOrigins.includes(origin)) {
        res.status(403).json({ error: { code: "forbidden_origin", message: `Origin ${origin} is not allowed.` } });
        return;
      }
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
      if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
      }
    }
    if (opts.token && req.headers.authorization !== `Bearer ${opts.token}`) {
      res.status(401).json({ error: { code: "unauthorized", message: "Missing or invalid API token." } });
      return;
    }
    next();
  };
}
