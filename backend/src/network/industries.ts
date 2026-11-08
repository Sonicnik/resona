/**
 * Industry groups for the people network. A person's industry is inferred from what they say about
 * themselves (title, organization, headline, bio, interests) and, more weakly, from what they post.
 * The user can override it per person; an override always wins.
 */

export interface Industry {
  id: string;
  name: string;
  /** Matched case-insensitively on word boundaries. */
  terms: string[];
  /** Broad industries (e.g. software) lose ties to specific ones (e.g. robotics). */
  weight?: number;
}

export const INDUSTRIES: Industry[] = [
  { id: "robotics", name: "Robotics", terms: ["robot", "robots", "robotics", "ros", "autonomous", "autonomy", "drone", "drones", "mechatronics", "manipulation", "slam", "actuator", "humanoid", "self-driving"] },
  { id: "finance", name: "Finance", terms: ["finance", "financial", "fintech", "bank", "banking", "quant", "quantitative", "trading", "trader", "investment", "investor", "capital", "hedge fund", "venture", "vc", "accounting", "payments", "asset management", "private equity", "insurance"] },
  { id: "health", name: "Health & Bio", terms: ["health", "healthcare", "medical", "medicine", "biotech", "biology", "bioinformatics", "clinical", "pharma", "hospital", "genomics", "neuroscience", "biomedical"] },
  { id: "climate", name: "Climate & Energy", terms: ["climate", "energy", "solar", "battery", "batteries", "carbon", "sustainability", "renewable", "grid", "ev", "electric vehicle"] },
  { id: "hardware", name: "Hardware", terms: ["hardware", "semiconductor", "chip", "chips", "fpga", "embedded", "firmware", "electronics", "pcb", "asic"] },
  { id: "ai", name: "AI & ML", terms: ["ai", "ml", "machine learning", "deep learning", "llm", "llms", "nlp", "computer vision", "data scientist", "neural", "artificial intelligence", "mlops"] },
  { id: "data", name: "Data", terms: ["data engineer", "data engineering", "analytics", "analyst", "etl", "data platform", "warehouse", "bi", "deduplication", "entity resolution"], weight: 0.9 },
  { id: "research", name: "Research", terms: ["research", "researcher", "phd", "postdoc", "professor", "university", "lab", "academic", "thesis", "eth", "scientist", "student"], weight: 0.8 },
  { id: "design", name: "Design & Product", terms: ["design", "designer", "ux", "ui", "product manager", "product designer", "product"], weight: 0.9 },
  { id: "recruiting", name: "Recruiting", terms: ["recruiter", "recruiting", "talent", "hiring", "hr", "people ops"] },
  { id: "startups", name: "Startups", terms: ["founder", "co-founder", "cofounder", "startup", "indie hacker", "entrepreneur", "hackathon"], weight: 0.85 },
  { id: "software", name: "Software", terms: ["software", "engineer", "developer", "backend", "frontend", "full-stack", "fullstack", "devops", "open-source", "open source", "oss", "maintainer", "sdk", "api", "developer advocate", "web"], weight: 0.6 },
];

export const INDUSTRY_BY_ID = new Map(INDUSTRIES.map((i) => [i.id, i]));

const PATTERNS = INDUSTRIES.map((i) => ({
  industry: i,
  res: i.terms.map((t) => new RegExp(`(^|[^\\p{L}\\p{N}])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "[\\s-]+")}($|[^\\p{L}\\p{N}])`, "iu")),
}));

export interface IndustrySignals {
  /** What the person says about themselves: title, organization, headline. Strongest signal. */
  profile: string[];
  /** Bio and interests. */
  about: string[];
  /** Text of their posts. Weakest signal: people post about many things. */
  posts: string[];
}

/** Returns the best-matching industry id, or null when nothing matches clearly enough. */
export function inferIndustry(s: IndustrySignals): string | null {
  // [text, weight per match, max matches counted]. Profile text counts once per industry, so overlapping
  // terms ("product", "product manager") don't stack; a post can count up to three distinct terms, so one
  // post clearly about trading, quants and payments still places someone.
  const sources: Array<[string, number, number]> = [
    ...s.profile.map((t): [string, number, number] => [t, 3, 1]),
    ...s.about.map((t): [string, number, number] => [t, 2, 1]),
    ...s.posts.map((t): [string, number, number] => [t, 0.5, 3]),
  ].filter(([t]) => t && t.trim());
  let best: { id: string; score: number } | null = null;
  for (const { industry, res } of PATTERNS) {
    let score = 0;
    for (const [text, w, cap] of sources) score += w * Math.min(cap, res.filter((re) => re.test(text)).length);
    score *= industry.weight ?? 1;
    if (score > (best?.score ?? 0)) best = { id: industry.id, score };
  }
  // Require at least one profile-level match, or several weaker ones.
  return best && best.score >= 1.5 ? best.id : null;
}
