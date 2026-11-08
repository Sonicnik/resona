import { test } from "node:test";
import assert from "node:assert/strict";
import { makeServices, tmpDir, writeFiles, SAMPLE_PROJECT, MATCHING_POST } from "./helpers.ts";

test("discovery: searches run at once and a slow source is cut off at timeoutMs", async () => {
  const s = makeServices();
  const dir = tmpDir();
  writeFiles(dir, SAMPLE_PROJECT);
  const project = s.projects.create({ folderPath: dir });
  await s.pipeline.processProject(project.id, "initial");
  const status = (id: string) => ({ id, name: id, available: true, capabilities: ["search" as const], note: "" });
  s.connectors.register({ id: "fast", status: () => status("fast"), search: async () => [{ platform: "hackernews", externalId: "hn-1", connector: "fast", url: "https://news.ycombinator.com/item?id=1", text: MATCHING_POST }] } as any);
  s.connectors.register({ id: "hung", status: () => status("hung"), search: () => new Promise(() => {}) } as any);

  const t0 = Date.now();
  const r = await s.discovery.run({ connectorIds: ["fast", "hung"], queriesPerProject: 1, timeoutMs: 500, rank: false });
  assert.ok(Date.now() - t0 < 1500, "a hung source must not hold up the scan");
  assert.equal(r.newPosts, 1);
  assert.deepEqual(r.queries.filter((q) => q.error).map((q) => [q.connector, q.error]), [["hung", "timed out"]]);
});
