/**
 * Outreach scenario detection (product reference §4). A lexicon-based classifier that is cheap,
 * explainable and runs offline; the optional AI assessment can refine it per opportunity.
 */

export type Scenario =
  | "problem_described"
  | "wish_for_tool"
  | "recommendation_request"
  | "manual_workflow"
  | "adjacent_product"
  | "technical_question"
  | "method_published"
  | "examples_requested"
  | "open_source_issue"
  | "hiring"
  | "collaborator_search"
  | "past_contact_followup"
  | "general_discussion";

export type Channel = "public_reply" | "direct_message" | "email" | "comment";
export type NextAction = "public_reply" | "personal_message" | "question" | "demo" | "collaboration_proposal";

interface ScenarioDef {
  label: string;
  patterns: RegExp[];
  contribution: string;
  channel: Channel;
  action: NextAction;
}

export const SCENARIOS: Record<Exclude<Scenario, "general_discussion">, ScenarioDef> = {
  problem_described: {
    label: "describes a problem the project addresses",
    patterns: [/\bstruggl\w*/i, /\b(pain|painful|frustrat\w*)\b/i, /\b(can'?t|cannot|unable to) (figure|get|make|find)\b/i, /\bproblem (is|with)\b/i, /\bkeeps? (failing|breaking)\b/i, /\bstuck (on|with)\b/i],
    contribution: "Explain the relevant capability, share a demo, and state limitations.",
    channel: "public_reply",
    action: "demo",
  },
  wish_for_tool: {
    label: "wishes a tool or implementation existed",
    patterns: [/\bi wish (there (was|were)|i had|someone)\b/i, /\bis there (a|any) (tool|library|app|way)\b/i, /\bwould (love|kill for) (a|an|some)\b/i, /\bsomeone should (build|make)\b/i, /\bdoes anything exist\b/i],
    contribution: "Show what you actually implemented and ask which requirements matter.",
    channel: "public_reply",
    action: "question",
  },
  recommendation_request: {
    label: "asks for recommendations",
    patterns: [/\brecommend(ation)?s?\b/i, /\bwhat (do|does|would) (you|people|everyone) use\b/i, /\balternatives? to\b/i, /\bbest (tool|library|way|approach) (for|to)\b/i, /\blooking for (a|an) (tool|library|solution)\b/i, /\bsuggestions?\b/i],
    contribution: "Compare the project's capabilities with their requirements honestly.",
    channel: "public_reply",
    action: "public_reply",
  },
  manual_workflow: {
    label: "describes a cumbersome manual workflow",
    patterns: [/\bmanually\b/i, /\bby hand\b/i, /\bcopy(-| and )?past(e|ing)\b/i, /\btedious\b/i, /\bspreadsheets?\b/i, /\bhours? (every|each) (day|week)\b/i, /\btime[- ]consuming\b/i],
    contribution: "Demonstrate a specific step the project could simplify.",
    channel: "public_reply",
    action: "demo",
  },
  adjacent_product: {
    label: "is building an adjacent product",
    patterns: [/\bjust (shipped|launched|released)\b/i, /\bintroducing\b/i, /\bshow hn\b/i, /\bwe('re| are) building\b/i, /\bi built\b/i, /\bopen[- ]sourced?\b/i, /\bv\d+(\.\d+)* (is )?out\b/i],
    contribution: "Offer a complementary component, dataset, integration or experiment.",
    channel: "direct_message",
    action: "collaboration_proposal",
  },
  technical_question: {
    label: "asks a technical question you have encountered",
    patterns: [/\bhow (do|can|would|should) (i|you|we|one)\b/i, /\banyone (know|tried|managed|solved)\b/i, /\bwhy (does|is|do)\b.*\?/i, /\b(error|exception|traceback|segfault|timeout)\b/i, /\bhas anyone\b/i],
    contribution: "Share a tested approach, results, or a reproducible example.",
    channel: "public_reply",
    action: "public_reply",
  },
  method_published: {
    label: "published a method you applied",
    patterns: [/\b(our|new) (paper|preprint|method|approach)\b/i, /\barxiv\b/i, /\bwe propose\b/i, /\bpublished\b/i, /\bblog post\b/i, /\bwrite-?up\b/i],
    contribution: "Credit the original work and report your application and findings.",
    channel: "public_reply",
    action: "public_reply",
  },
  examples_requested: {
    label: "requests examples or case studies",
    patterns: [/\bexamples? of\b/i, /\bcase stud(y|ies)\b/i, /\bshare (your|some)\b/i, /\bshow me\b/i, /\bwho('s| has| is) (using|built)\b/i, /\bcollecting\b/i],
    contribution: "Contribute a documented example.",
    channel: "public_reply",
    action: "public_reply",
  },
  open_source_issue: {
    label: "has an open-source issue that overlaps with your work",
    patterns: [/\bhelp wanted\b/i, /\bgood first issue\b/i, /\bcontributions? welcome\b/i, /\bpull request\b/i, /\bfeature request\b/i, /\bsteps to reproduce\b/i],
    contribution: "Offer a relevant explanation, reproducible example, or contribution.",
    channel: "comment",
    action: "public_reply",
  },
  hiring: {
    label: "is hiring for work that resembles your project",
    patterns: [/\b(we('re| are)|i'm|i am|is|are|now) hiring\b/i, /^\s*hiring\b/im, /\bjob (opening|posting)\b/i, /\binternships?\b/i, /\bjoin (our|the) team\b/i, /\bopen (role|position)s?\b/i, /\bnew grad\b/i],
    contribution: "Connect a specific requirement to demonstrated work.",
    channel: "direct_message",
    action: "personal_message",
  },
  collaborator_search: {
    label: "is explicitly looking for collaborators or expertise",
    patterns: [/\blooking for (collaborators?|co-?founders?|partners?|contributors?|someone (who|with))\b/i, /\banyone (interested|want) (in|to)\b/i, /\bjoin me\b/i, /\bteam ?up\b/i, /\bneed (help|an expert|someone)\b/i],
    contribution: "Show relevant experience and suggest a bounded contribution.",
    channel: "direct_message",
    action: "collaboration_proposal",
  },
  past_contact_followup: {
    label: "is a past contact whose question has become relevant again",
    patterns: [],
    contribution: "Share a new result that addresses the earlier conversation.",
    channel: "direct_message",
    action: "personal_message",
  },
};

const RESOLVED = [/\[solved\]/i, /\b(solved|resolved|fixed) it\b/i, /\bnever ?mind\b/i, /\bfigured (it )?out\b/i, /\bupdate:? (it )?(works|solved|fixed)\b/i, /\bthanks? (everyone|all),? (found|got)\b/i];
const NO_PROMOTION = [/\bno (self[- ]?promotion|vendors?|promo|sales pitches?)\b/i, /\bnot looking for (tools|products|vendors)\b/i, /\bplease don'?t (pitch|dm|sell)\b/i];
const RANT = [/\b(rant|vent(ing)?)\b/i, /\bugh+\b/i, /\bi hate\b/i, /\bworst\b/i];

export interface ScenarioResult {
  scenario: Scenario;
  confidence: number;
  matched: Scenario[];
  signals: string[];
  /** Multiplier in (0, 1] describing whether the conversation is still a useful opening. */
  openness: number;
}

export function detectScenario(text: string, opts: { platform?: string; isPastContact?: boolean } = {}): ScenarioResult {
  const scores: Array<[Scenario, number]> = [];
  const signals: string[] = [];
  for (const [name, def] of Object.entries(SCENARIOS) as Array<[Scenario, ScenarioDef]>) {
    const hits = def.patterns.filter((p) => p.test(text)).length;
    if (hits > 0) scores.push([name, Math.min(1, 0.45 + 0.2 * hits)]);
  }
  if (opts.platform === "github") {
    const existing = scores.find(([s]) => s === "open_source_issue");
    if (existing) existing[1] = Math.min(1, existing[1] + 0.2);
    else scores.push(["open_source_issue", 0.55]);
  }
  const isQuestion = /\?/.test(text);
  if (isQuestion) {
    for (const s of scores) if (["technical_question", "recommendation_request", "wish_for_tool"].includes(s[0])) s[1] = Math.min(1, s[1] + 0.1);
  }
  if (opts.isPastContact) scores.push(["past_contact_followup", 0.7]);
  scores.sort((a, b) => b[1] - a[1]);

  let openness = 1;
  if (RESOLVED.some((p) => p.test(text))) {
    openness *= 0.3;
    signals.push("discussion appears resolved");
  }
  if (NO_PROMOTION.some((p) => p.test(text))) {
    openness *= 0.15;
    signals.push("author asked not to be pitched");
  }
  if (RANT.some((p) => p.test(text)) && !isQuestion && !scores.some(([s]) => s === "wish_for_tool" || s === "recommendation_request")) {
    openness *= 0.5;
    signals.push("reads as frustration rather than a request for help");
  }
  const top = scores[0];
  return {
    scenario: top?.[0] ?? "general_discussion",
    confidence: top?.[1] ?? 0.15,
    matched: scores.map(([s]) => s),
    signals,
    openness,
  };
}

export function scenarioInfo(s: Scenario): { label: string; contribution: string; channel: Channel; action: NextAction } {
  if (s === "general_discussion") {
    return {
      label: "is discussing a related topic",
      contribution: "Add a specific, useful perspective from your work only if it adds value.",
      channel: "public_reply",
      action: "public_reply",
    };
  }
  const def = SCENARIOS[s];
  return { label: def.label, contribution: def.contribution, channel: def.channel, action: def.action };
}
