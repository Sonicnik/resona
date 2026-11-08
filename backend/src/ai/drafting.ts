import { z } from "zod";
import type { AiService } from "./client.ts";
import { parseJson } from "../lib/util.ts";
import { truncate } from "../lib/text.ts";
import { scenarioInfo, type Scenario } from "../matching/scenarios.ts";

export const OutreachDraftSchema = z.object({
  body: z.string().describe("The reply or message text, ready for the user to edit."),
  rationale: z.string().describe("Why this framing; shown to the user, not sent."),
  source_refs: z.array(z.string()).describe("Project file references the draft relies on."),
  cautions: z.array(z.string()).describe("Claims the user should double-check before sending."),
});

export const PostDraftSchema = z.object({
  worth_posting: z.boolean().describe("False when the material has no meaningful update worth a public post."),
  reason: z.string(),
  title: z.string().describe("Short internal title for the draft."),
  body: z.string(),
  source_refs: z.array(z.string()),
  cautions: z.array(z.string()),
});

export interface ContextForDraft {
  projectId: string;
  contextId: string;
  projectName: string;
  summary: string;
  problem: string;
  contribution: string;
  capabilities: string[];
  limitations: string[];
  results: Array<{ claim: string; evidence: string[]; confidence: string }>;
  shareable: Array<{ ref: string; description: string }>;
}

export function contextForDraft(projectName: string, ctx: Record<string, unknown>): ContextForDraft {
  return {
    projectId: String(ctx.project_id),
    contextId: String(ctx.id),
    projectName,
    summary: String(ctx.summary ?? ""),
    problem: String(ctx.problem ?? ""),
    contribution: String(ctx.contribution ?? ""),
    capabilities: parseJson(ctx.capabilities, []),
    limitations: parseJson(ctx.limitations, []),
    results: parseJson(ctx.results, []),
    shareable: parseJson(ctx.shareable_material, []),
  };
}

const VOICE_RULES = `Voice and honesty rules:
- Write as the user, in first person, plainly and briefly. No hype, no buzzwords, no emoji unless the platform norm calls for it.
- Only state results that appear in the project context; do not round up or invent numbers, users or adoption.
- Mention a relevant limitation when it affects whether the project fits.
- Never describe the user's role beyond what the context establishes; if the contribution is unknown, avoid claiming sole authorship.
- Use [square-bracket placeholders] for links or details the user must fill in.
- The user will read and edit the draft; it is never sent automatically.`;

function contextBlock(c: ContextForDraft): string {
  return `<project name="${c.projectName}">
Summary: ${c.summary}
Problem: ${c.problem || "(not stated)"}
User's contribution: ${c.contribution || "(not established - do not claim sole authorship)"}
Capabilities: ${c.capabilities.join("; ") || "(none listed)"}
Limitations: ${c.limitations.join("; ") || "(none listed)"}
Results: ${c.results.map((r) => `${r.claim} [${r.confidence}; ${r.evidence.join(", ")}]`).join("; ") || "(none established)"}
Shareable material: ${c.shareable.map((s) => `${s.ref} (${s.description})`).join("; ") || "(none)"}
</project>`;
}

export async function draftOutreachWithAi(
  ai: AiService,
  args: {
    ctx: ContextForDraft;
    post: { text: string; title?: string | null; platform: string; url?: string | null };
    authorName: string;
    scenario: Scenario;
    channel: string;
    matchReason: string;
    history: string[];
    /** What triggered the draft, kept in processing history, e.g. `opportunity:opp_…`. */
    sourceRef: string;
  },
) {
  const info = scenarioInfo(args.scenario);
  const lengthRule =
    args.post.platform === "x" ? "Keep it under 270 characters." : args.channel === "direct_message" ? "Keep it under 120 words." : "Keep it under 150 words.";
  return ai.structured({
    purpose: "outreach_draft",
    projectIds: [args.ctx.projectId],
    inputRefs: [args.sourceRef, `project_context:${args.ctx.contextId}`],
    system: `You draft an individual reply or message from a student or early-career person to someone whose post relates to the user's project. The goal is a genuinely useful contribution that can start a professional relationship, not a sales pitch.

${VOICE_RULES}
- Address the specific point the author made; reference it concretely in the first sentence.
- Offer something useful (an answer, a tested approach, a demo, a question about their requirements) before mentioning the project.
- End with a low-pressure next step appropriate to the channel.`,
    user: `Channel: ${args.channel} on ${args.post.platform}. ${lengthRule}
Scenario: the author ${info.label}. Suggested contribution: ${info.contribution}
Why this matched: ${args.matchReason}

<post author="${args.authorName}"${args.post.url ? ` url="${args.post.url}"` : ""}>
${args.post.title ? `${args.post.title}\n` : ""}${truncate(args.post.text, 6000)}
</post>

${contextBlock(args.ctx)}

<previous_interactions_with_author>
${args.history.length ? args.history.join("\n") : "(none)"}
</previous_interactions_with_author>`,
    schema: OutreachDraftSchema,
    maxTokens: 4000,
  });
}

export async function draftPostWithAi(
  ai: AiService,
  args: { ctx: ContextForDraft; platform: "linkedin" | "x"; angle?: string; recentChanges: string[]; force: boolean },
) {
  const limit = args.platform === "x" ? "Maximum 280 characters." : "120-220 words, short paragraphs.";
  return ai.structured({
    purpose: "post_draft",
    projectIds: [args.ctx.projectId],
    inputRefs: [`project_context:${args.ctx.contextId}`, ...args.recentChanges.map((c) => `changed:${c}`)],
    system: `You draft a standalone ${args.platform === "x" ? "X" : "LinkedIn"} post about a meaningful development in the user's project: a milestone, a useful finding, a method, a demo, a failure and its lesson, or a documented result.

${VOICE_RULES}
- Not every change warrants a public post. If nothing in the material is a meaningful, shareable development, set worth_posting to false and explain why${args.force ? " (the user asked for a draft anyway, so still write the best honest draft)" : ""}.
- Lead with the concrete insight or result, then the context; end with a question or invitation that could start a conversation.`,
    user: `Platform: ${args.platform}. ${limit}
${args.angle ? `Angle requested by the user: ${args.angle}\n` : ""}Recently changed files: ${args.recentChanges.slice(0, 30).join(", ") || "(none recorded)"}

${contextBlock(args.ctx)}`,
    schema: PostDraftSchema,
    maxTokens: 4000,
  });
}

/** Offline template fallback; deliberately plain and full of placeholders so the user personalizes it. */
export function templateOutreach(args: {
  ctx: ContextForDraft;
  authorName: string;
  scenario: Scenario;
  sharedTerms: string[];
  platform: string;
}): { body: string; sourceRefs: string[] } {
  const first = args.authorName.split(/\s+/)[0] || "there";
  const topic = args.sharedTerms[0] ?? "this";
  const cap = args.ctx.capabilities[0];
  const lim = args.ctx.limitations[0];
  const result = args.ctx.results.find((r) => r.confidence !== "low");
  const openers: Partial<Record<Scenario, string>> = {
    problem_described: `Hi ${first}, I ran into the same ${topic} problem you describe [mention their specific detail].`,
    wish_for_tool: `Hi ${first}, I've been building something close to what you describe: ${args.ctx.projectName}.`,
    recommendation_request: `Hi ${first}, one option to consider, with the caveat that I built it: ${args.ctx.projectName}.`,
    manual_workflow: `Hi ${first}, the manual step you describe [quote it] is exactly what I tried to automate in ${args.ctx.projectName}.`,
    adjacent_product: `Hi ${first}, congrats on the launch. I've been working on ${args.ctx.projectName}, which seems complementary.`,
    technical_question: `Hi ${first}, I hit this while working on ${args.ctx.projectName}. What worked for me: [describe the approach].`,
    method_published: `Hi ${first}, thanks for sharing this. I applied [the method] in ${args.ctx.projectName} and found [your finding].`,
    examples_requested: `Hi ${first}, here's an example that might fit: ${args.ctx.projectName}.`,
    open_source_issue: `I looked into this while working on ${args.ctx.projectName}; here's what I found: [explanation / repro].`,
    hiring: `Hi ${first}, the [requirement] in this role lines up with work I did on ${args.ctx.projectName}.`,
    collaborator_search: `Hi ${first}, I'd be interested in contributing. I've worked on ${args.ctx.projectName}.`,
    past_contact_followup: `Hi ${first}, following up on our conversation about ${topic}: I have a new result that might help.`,
  };
  const lines = [
    openers[args.scenario] ?? `Hi ${first}, your post about ${topic} connects with something I've been working on.`,
    cap ? `The relevant part: ${cap.charAt(0).toLowerCase()}${cap.slice(1).replace(/\.$/, "")}.` : args.ctx.summary ? truncate(args.ctx.summary, 200) : "",
    result ? `So far: ${result.claim}.` : "",
    lim ? `One limitation to be upfront about: ${lim.replace(/\.$/, "")}.` : "",
    "Happy to share [demo/repo link] if it's useful, or to hear which requirements matter most for you.",
  ].filter(Boolean);
  let body = lines.join(" ");
  if (args.platform === "x") body = truncate(body, 280);
  return { body, sourceRefs: result?.evidence ?? [] };
}

export function templatePost(ctx: ContextForDraft, platform: "linkedin" | "x"): { title: string; body: string; sourceRefs: string[] } {
  const result = ctx.results[0];
  const body =
    platform === "x"
      ? truncate(`Working on ${ctx.projectName}: ${result?.claim ?? ctx.summary} [what you learned] [link]`, 280)
      : [
          `I've been working on ${ctx.projectName}${ctx.problem ? ` to address ${ctx.problem.replace(/\.$/, "")}` : ""}.`,
          result ? `A recent result: ${result.claim}.` : "[Describe the milestone, finding or lesson.]",
          ctx.limitations[0] ? `What's still hard: ${ctx.limitations[0]}.` : "[What's still hard or unresolved.]",
          "[A question for readers who work on similar problems.]",
        ].join("\n\n");
  return { title: `${ctx.projectName} update`, body, sourceRefs: result?.evidence ?? [] };
}
