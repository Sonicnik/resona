import type { Db } from "../db/database.ts";
import { nowIso } from "../lib/util.ts";

export interface Job {
  name: string;
  intervalMs: number;
  /** Return false to skip this run (e.g. feature disabled in settings). */
  enabled?: () => boolean;
  run: () => Promise<unknown> | unknown;
}

export interface JobStatus {
  name: string;
  intervalMs: number;
  enabled: boolean;
  running: boolean;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  nextDueAt: string;
}

/**
 * Local scheduler with persisted run times. Work happens only while the Mac is awake and the app
 * is running; when it resumes after sleep or a restart, each overdue job runs once (catch-up),
 * rather than once per missed interval.
 */
export class Scheduler {
  private readonly jobs = new Map<string, Job>();
  private readonly running = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private lastTick = Date.now();
  resumedAfterPauseAt: string | null = null;

  constructor(
    private readonly db: Db,
    private readonly tickMs = 60_000,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  register(job: Job): void {
    this.jobs.set(job.name, job);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    void this.tick(); // catch up immediately on start
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private lastRun(name: string) {
    return this.db.get<{ last_started_at: string | null; last_finished_at: string | null; last_status: string | null; last_error: string | null }>(
      "SELECT * FROM job_runs WHERE name = ?",
      [name],
    );
  }

  isDue(job: Job, now = Date.now()): boolean {
    const last = this.lastRun(job.name);
    if (!last?.last_started_at) return true;
    return now - Date.parse(last.last_started_at) >= job.intervalMs;
  }

  async tick(): Promise<void> {
    const now = Date.now();
    if (now - this.lastTick > this.tickMs * 3) {
      this.resumedAfterPauseAt = new Date(now).toISOString();
      this.log(`resumed after a pause of ${Math.round((now - this.lastTick) / 60_000)} min; catching up`);
    }
    this.lastTick = now;
    for (const job of this.jobs.values()) {
      if (this.running.has(job.name)) continue;
      if (job.enabled && !job.enabled()) continue;
      if (!this.isDue(job, now)) continue;
      await this.runJob(job.name);
    }
  }

  async runJob(name: string): Promise<{ status: string; result?: unknown; error?: string }> {
    const job = this.jobs.get(name);
    if (!job) throw new Error(`unknown job ${name}`);
    if (this.running.has(name)) return { status: "already_running" };
    this.running.add(name);
    this.db.run(
      `INSERT INTO job_runs (name, last_started_at, last_status) VALUES (?, ?, 'running')
       ON CONFLICT(name) DO UPDATE SET last_started_at = excluded.last_started_at, last_status = 'running'`,
      [name, nowIso()],
    );
    try {
      const result = await job.run();
      this.db.run("UPDATE job_runs SET last_finished_at = ?, last_status = 'ok', last_error = NULL WHERE name = ?", [nowIso(), name]);
      return { status: "ok", result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`job ${name} failed: ${message}`);
      this.db.run("UPDATE job_runs SET last_finished_at = ?, last_status = 'error', last_error = ? WHERE name = ?", [nowIso(), message, name]);
      return { status: "error", error: message };
    } finally {
      this.running.delete(name);
    }
  }

  status(): JobStatus[] {
    return [...this.jobs.values()].map((job) => {
      const last = this.lastRun(job.name);
      const nextDue = last?.last_started_at ? Date.parse(last.last_started_at) + job.intervalMs : Date.now();
      return {
        name: job.name,
        intervalMs: job.intervalMs,
        enabled: job.enabled ? job.enabled() : true,
        running: this.running.has(job.name),
        lastStartedAt: last?.last_started_at ?? null,
        lastFinishedAt: last?.last_finished_at ?? null,
        lastStatus: last?.last_status ?? null,
        lastError: last?.last_error ?? null,
        nextDueAt: new Date(nextDue).toISOString(),
      };
    });
  }
}
