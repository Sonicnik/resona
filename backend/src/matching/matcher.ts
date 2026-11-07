import { clamp, daysBetween } from "../lib/util.ts";
import { stem, tokenize } from "../lib/text.ts";
import { cosine } from "../search/embeddings.ts";
import { detectScenario, scenarioInfo, type Scenario } from "./scenarios.ts";

export interface ProjectProfile {
  projectId: string;
  contextId: string | null;
  name: string;
  problem: string;
  keywords: string[];
  phrases: string[];
  capabilities: string[];
  limitations: string[];
  vector: Float32Array | null;
}

export interface PostForMatching {
  text: string;
  title?: string | null;
  platform: string;
  publishedAt?: string | null;
}

export interface MatchContext {
  isPastContact: boolean;
  previouslyContacted: boolean;
  now?: Date;
}

export interface MatchResult {
  relevance: number;
  scenario: Scenario;
  scenarioConfidence: number;
  sharedTerms: string[];
  matchedPhrases: string[];
  limitationConflicts: string[];
  flags: string[];
  breakdown: {
    semantic: number;
    keyword: number;
    intent: number;
    freshness: number;
    openness: number;
    requirementFit: number;
    duplicatePenalty: number;
  };
  reason: string;
  suggestedChannel: string;
  suggestedAction: string;
}

const WEIGHTS = { semantic: 0.4, keyword: 0.35, intent: 0.25 };

/** Map raw cosine (hashing embedder lives roughly in 0.0-0.6 for related texts) to 0..1. */
function semanticScale(cos: number): number {
  return clamp((cos - 0.05) / 0.4);
}

/**
 * Scores how useful it would be for the user to contribute to a conversation with one project.
 * Topic similarity alone is not enough: the score combines similarity with the detected
 * scenario (is there an actual request or opening?), freshness, signals that the conversation is
 * resolved or closed to pitches, conflicts with the project's stated limitations, and previous outreach.
 */
export function scoreMatch(post: PostForMatching, postVector: Float32Array, project: ProjectProfile, ctx: MatchContext): MatchResult {
  const fullText = `${post.title ?? ""}\n${post.text}`;
  const postStems = new Set(tokenize(fullText).map(stem));
  const lower = fullText.toLowerCase();

  // Keyword evidence: project keywords weighted by rank (earlier keywords are more central).
  const kw = project.keywords.slice(0, 30);
  let kwTotal = 0;
  let kwHit = 0;
  const sharedTerms: string[] = [];
  kw.forEach((k, i) => {
    const weight = 1 - (i / Math.max(kw.length, 1)) * 0.5;
    kwTotal += weight;
    const kStems = tokenize(k).map(stem);
    if (kStems.length > 0 && kStems.every((s) => postStems.has(s))) {
      kwHit += weight;
      sharedTerms.push(k);
    }
  });
  const matchedPhrases = project.phrases.filter((p) => p.length > 3 && lower.includes(p.toLowerCase()));
  // Saturating: three solid keyword hits already carry most of the evidence.
  const keyword = clamp(kwTotal > 0 ? (kwHit / Math.min(kwTotal, 3)) * 0.85 + matchedPhrases.length * 0.15 : 0);

  const semantic = project.vector ? semanticScale(cosine(postVector, project.vector)) : 0;
  const det = detectScenario(fullText, { platform: post.platform, isPastContact: ctx.isPastContact });
  const intent = det.scenario === "general_discussion" ? 0.15 : det.confidence;

  const ageDays = post.publishedAt ? daysBetween(post.publishedAt, ctx.now ?? new Date()) : 7;
  const freshness = clamp(Math.exp(-ageDays / 45), 0.2, 1);

  // Requirement fit: penalize when the post centres on something the project lists as a limitation.
  const limitationConflicts = project.limitations.filter((lim) => {
    const stems = tokenize(lim).map(stem).filter((s) => s.length > 3);
    if (stems.length === 0) return false;
    const overlap = stems.filter((s) => postStems.has(s)).length;
    return overlap / stems.length >= 0.6;
  });
  const requirementFit = limitationConflicts.length > 0 ? 0.6 : 1;
  const duplicatePenalty = ctx.previouslyContacted ? 0.6 : 1;

  const flags = [...det.signals];
  if (limitationConflicts.length) flags.push("post asks for something the project lists as a limitation");
  if (ctx.previouslyContacted) flags.push("you have already contacted this person recently");
  if (ageDays > 60) flags.push(`conversation is ${Math.round(ageDays)} days old`);
  if (sharedTerms.length === 0 && semantic < 0.35) flags.push("weak topical overlap");

  const base = WEIGHTS.semantic * semantic + WEIGHTS.keyword * keyword + WEIGHTS.intent * intent;
  const relevance = clamp(base * freshness ** 0.5 * det.openness * requirementFit * duplicatePenalty);

  const info = scenarioInfo(det.scenario);
  const termText = sharedTerms.length ? `mentions ${sharedTerms.slice(0, 4).join(", ")}` : "discusses a closely related topic";
  const reason =
    `The author ${info.label} and ${termText}. ` +
    (project.problem ? `${project.name} addresses: ${project.problem}. ` : `${project.name} is relevant work. `) +
    `Suggested contribution: ${info.contribution}`;

  return {
    relevance: Number(relevance.toFixed(4)),
    scenario: det.scenario,
    scenarioConfidence: det.confidence,
    sharedTerms,
    matchedPhrases,
    limitationConflicts,
    flags,
    breakdown: {
      semantic: round(semantic),
      keyword: round(keyword),
      intent: round(intent),
      freshness: round(freshness),
      openness: round(det.openness),
      requirementFit,
      duplicatePenalty,
    },
    reason,
    suggestedChannel: info.channel,
    suggestedAction: info.action,
  };
}

function round(x: number): number {
  return Number(x.toFixed(3));
}

/** Minimum evidence needed before a match becomes an opportunity. */
export function isWorthSurfacing(m: MatchResult, threshold = 0.3): boolean {
  if (m.relevance < threshold) return false;
  // Topic similarity alone is insufficient: require some lexical evidence or a strong semantic match with a real opening.
  if (m.sharedTerms.length === 0 && m.matchedPhrases.length === 0 && m.breakdown.semantic < 0.5) return false;
  return true;
}
