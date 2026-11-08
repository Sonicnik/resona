import { test } from "node:test";
import assert from "node:assert/strict";
import { Scheduler } from "../src/scheduler/scheduler.ts";
import { Db } from "../src/db/database.ts";

test("scheduler runs overdue jobs once, persists run times, and records failures", async () => {
  const db = new Db(":memory:");
  const sched = new Scheduler(db, 1000);
  let runs = 0;
  let enabled = true;
  sched.register({ name: "hourly", intervalMs: 3_600_000, enabled: () => enabled, run: () => runs++ });
  sched.register({ name: "broken", intervalMs: 3_600_000, run: () => { throw new Error("boom"); } });

  await sched.tick();
  await sched.tick();
  assert.equal(runs, 1, "not due again until the interval passes");

  // Simulate a Mac that slept for 3 hours: one catch-up run, not three.
  db.run("UPDATE job_runs SET last_started_at = ? WHERE name = 'hourly'", [new Date(Date.now() - 3 * 3_600_000).toISOString()]);
  await sched.tick();
  await sched.tick();
  assert.equal(runs, 2);

  enabled = false;
  db.run("UPDATE job_runs SET last_started_at = ? WHERE name = 'hourly'", [new Date(0).toISOString()]);
  await sched.tick();
  assert.equal(runs, 2, "disabled jobs are skipped");

  const broken = sched.status().find((j) => j.name === "broken")!;
  assert.equal(broken.lastStatus, "error");
  assert.equal(broken.lastError, "boom");
  db.close();
});

test("weekly review runs in the background only once there is a project, and writes its vault note", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { makeServices, tmpDir, writeFiles, SAMPLE_PROJECT } = await import("./helpers.ts");
  const s = makeServices();
  const job = () => s.scheduler.status().find((j) => j.name === "weekly-review")!;
  assert.equal(job().enabled, false, "no projects yet: nothing to review");
  const folder = tmpDir("proj-");
  writeFiles(folder, SAMPLE_PROJECT);
  s.projects.create({ folderPath: folder });
  assert.equal(job().enabled, true);
  const res = await s.scheduler.runJob("weekly-review");
  assert.equal(res.status, "ok");
  assert.equal(s.review.list().length, 1);
  const reviews = path.join(s.vault.vaultDir, "Reviews");
  assert.ok(fs.readdirSync(reviews).some((f) => f.startsWith("Weekly review ")), "note written with the review");
  s.close();
});
