import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeEntities, summarizeSituation } from "../src/matching/situation.ts";
import { makeServices, StubAi, tmpDir, writeFiles, SAMPLE_PROJECT } from "./helpers.ts";

test("situation: a long markdown PR becomes a headline plus one sentence", () => {
  const body = [
    "Make the scheduler survive sleep",
    "",
    "## What does this PR do?",
    "",
    "This PR makes the job scheduler catch up once after the laptop wakes, instead of running every missed interval.",
    "",
    "Demo video: https://example.com/video.mp4",
    "",
    "```ts",
    "const x = 1; // code is never a summary",
    "```",
    "",
    ...Array.from({ length: 40 }, (_, i) => `- Detail ${i} about the [implementation](https://example.com/${i}) and **tests**.`),
  ].join("\n");
  const s = summarizeSituation({ platform: "github", url: "https://github.com/o/r/pull/12", title: "Make the scheduler survive sleep", text: body }, ["scheduler"]);
  assert.equal(s.headline, "Pull request · Make the scheduler survive sleep");
  assert.equal(s.gist, "This PR makes the job scheduler catch up once after the laptop wakes, instead of running every missed interval.");
  assert.ok(s.gist.length <= 180);
});

test("situation: a real question beats the opening line; HTML entities are decoded", () => {
  const s = summarizeSituation({
    platform: "hackernews",
    url: "https://news.ycombinator.com/item?id=1",
    title: "Re: Ask HN: How do you match hackathon teams?",
    text: "We run a 300&#x2F;400 person event every year.<p>Is there a tool that balances skills across teams automatically?<p>Thanks!",
  });
  assert.equal(s.headline, "Re: Ask HN: How do you match hackathon teams?");
  assert.equal(s.gist, "Is there a tool that balances skills across teams automatically?");
  assert.equal(decodeEntities("a &amp; b &#x2F; c &#39;d&#39; &unknown;"), "a & b / c 'd' &unknown;");
});

test("situation: posts without a title use the best sentence, cut at 180 characters", () => {
  const long = `${"Our onboarding workflow is entirely manual and painful ".repeat(8)}.`;
  const s = summarizeSituation({ platform: "linkedin", text: long });
  assert.equal(s.headline, null);
  assert.ok(s.gist.endsWith("…") && s.gist.length === 180);
});

test("opportunities carry a short situation; the AI fit check replaces it with its own sentence", async () => {
  const s = makeServices({
    ai: (db, c) =>
      new StubAi(db, c, (req) =>
        req.system.includes("You judge whether")
          ? { fits: true, scenario: "technical_question", reason: "Fits.", situation: "Jane wants an automatic way to measure retrieval recall.", suggested_channel: "public_reply", suggested_action: "public_reply", relevance: 0.8, cautions: [] }
          : (() => {
              throw new Error("offline");
            })(),
      ),
  });
  try {
    const folder = tmpDir("proj-");
    writeFiles(folder, SAMPLE_PROJECT);
    const project = s.projects.create({ folderPath: folder, aiPermission: "allowed" });
    await s.pipeline.processProject(project.id, "initial");
    const { postId } = s.opportunities.ingestPost({
      platform: "linkedin",
      connector: "manual",
      externalId: "https://www.linkedin.com/posts/jane-1",
      url: "https://www.linkedin.com/posts/jane-1",
      text: "We evaluate our RAG chatbot by hand in spreadsheets. Is there a tool that measures retrieval recall automatically?",
      author: { platform: "linkedin", url: "https://www.linkedin.com/in/jane", displayName: "Jane Doe" },
    });
    const opp = s.opportunities.get(s.opportunities.matchPost(postId)[0]!.opportunityId);
    assert.equal(opp.situation.source, "extracted");
    assert.equal(opp.situation.gist, "Is there a tool that measures retrieval recall automatically?");
    assert.equal(opp.post.url, "https://www.linkedin.com/posts/jane-1");
    assert.match(opp.why, /^Jane [a-z].+ · fits .+ · shared: /);

    await s.opportunities.assessWithAi(opp.id);
    const after = s.opportunities.get(opp.id);
    assert.deepEqual(after.situation, { headline: null, gist: "Jane wants an automatic way to measure retrieval recall.", source: "ai" });
    assert.equal(after.why, "Fits.");
  } finally {
    s.close();
  }
});
