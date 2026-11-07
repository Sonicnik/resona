import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { MIGRATIONS } from "./schema.ts";
import { nowIso } from "../lib/util.ts";

export type Row = Record<string, unknown>;
type Params = Record<string, unknown> | unknown[];

function normalizeValue(v: unknown): SQLInputValue {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" || typeof v === "string" || typeof v === "bigint") return v;
  if (v instanceof Uint8Array) return v;
  if (v instanceof Date) return v.toISOString();
  return JSON.stringify(v);
}

/** Positional parameters are spread; a named-parameter object is passed as the single argument. */
function bind(params: Params): SQLInputValue[] | [Record<string, SQLInputValue>] {
  if (Array.isArray(params)) return params.map(normalizeValue);
  const out: Record<string, SQLInputValue> = {};
  for (const [k, v] of Object.entries(params)) out[k] = normalizeValue(v);
  return [out];
}

/**
 * Thin synchronous wrapper around node:sqlite. Synchronous access is a good fit for a
 * single-user local app: no connection pool, no lock contention, and transactions are trivial.
 */
export class Db {
  readonly raw: DatabaseSync;
  private txDepth = 0;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec("PRAGMA journal_mode = WAL;");
    this.raw.exec("PRAGMA foreign_keys = ON;");
    this.raw.exec("PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    this.raw.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    const applied = new Set(
      (this.raw.prepare("SELECT version FROM schema_migrations").all() as Row[]).map((r) => Number(r.version)),
    );
    MIGRATIONS.forEach((sql, index) => {
      const version = index + 1;
      if (applied.has(version)) return;
      this.tx(() => {
        this.raw.exec(sql);
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [version, nowIso()]);
      });
    });
  }

  run(sql: string, params: Params = []): { changes: number; lastInsertRowid: number } {
    const res = this.raw.prepare(sql).run(...(bind(params) as [never]));
    return { changes: Number(res.changes), lastInsertRowid: Number(res.lastInsertRowid) };
  }

  get<T = Row>(sql: string, params: Params = []): T | undefined {
    return this.raw.prepare(sql).get(...(bind(params) as [never])) as T | undefined;
  }

  all<T = Row>(sql: string, params: Params = []): T[] {
    return this.raw.prepare(sql).all(...(bind(params) as [never])) as T[];
  }

  /** Runs `fn` atomically. Nested calls use savepoints. */
  tx<T>(fn: () => T): T {
    const name = `sp_${this.txDepth}`;
    this.raw.exec(this.txDepth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${name}`);
    this.txDepth++;
    try {
      const result = fn();
      this.txDepth--;
      this.raw.exec(this.txDepth === 0 ? "COMMIT" : `RELEASE ${name}`);
      return result;
    } catch (err) {
      this.txDepth--;
      this.raw.exec(this.txDepth === 0 ? "ROLLBACK" : `ROLLBACK TO ${name}; RELEASE ${name}`);
      throw err;
    }
  }

  getSetting<T>(key: string, fallback: T): T {
    const row = this.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", [key]);
    if (!row) return fallback;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return fallback;
    }
  }

  setSetting(key: string, value: unknown): void {
    this.run(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [key, JSON.stringify(value)],
    );
  }

  close(): void {
    this.raw.close();
  }
}
