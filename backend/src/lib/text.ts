/** Small, dependency-free text utilities used by ingestion, matching and the offline summarizer. */

const STOPWORDS = new Set(
  (
    "a about above after again against all also am an and any are aren't as at be because been before being below " +
    "between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each few " +
    "for from further get gets got had hadn't has hasn't have haven't having he her here hers herself him himself his " +
    "how i i'm if in into is isn't it it's its itself just let's like make made me more most much must my myself no nor " +
    "not now of off on once one only or other our ours ourselves out over own same she should shouldn't so some such " +
    "than that that's the their theirs them themselves then there there's these they this those through to too under " +
    "until up use used using very via was wasn't we we're were weren't what what's when where which while who whom why " +
    "will with won't would wouldn't you you're your yours yourself yourselves new also etc e.g i.e todo fixme true false " +
    "null undefined return const let var function import export default class public private static void int string " +
    "self def elif else http https www com org html md png jpg json yaml yml txt readme file files"
  ).split(/\s+/),
);

export function isStopword(token: string): boolean {
  return STOPWORDS.has(token);
}

/** Lower-cases and splits on non-word characters; drops stopwords, numbers and very short tokens. */
export function tokenize(text: string, { keepStopwords = false } = {}): string[] {
  const tokens = text
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^\p{L}\p{N}+#.-]+/u)
    .map((t) => t.replace(/^[.\-]+|[.\-]+$/g, ""))
    .filter((t) => t.length >= 2 && t.length <= 40 && /\p{L}/u.test(t) && !/^\d+([.,]\d+)?$/.test(t));
  return keepStopwords ? tokens : tokens.filter((t) => !STOPWORDS.has(t));
}

/** Very light stemmer so that "agents", "agent" and "agentic" collide for matching purposes. */
export function stem(token: string): string {
  if (token.length <= 4) return token;
  return token
    .replace(/(ies)$/, "y")
    .replace(/(ing|ings|edly|ed|es|s|ic|ation|ations)$/, "")
    .replace(/(.)\1$/, "$1");
}

export function termFrequencies(text: string): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokenize(text)) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

/** Bigrams that occur at least `minCount` times; good proxies for domain phrases ("vector search"). */
export function frequentPhrases(text: string, minCount = 2, limit = 20): string[] {
  const words = tokenize(text, { keepStopwords: true });
  const counts = new Map<string, number>();
  for (let i = 0; i + 1 < words.length; i++) {
    const a = words[i]!;
    const b = words[i + 1]!;
    if (STOPWORDS.has(a) || STOPWORDS.has(b)) continue;
    const phrase = `${a} ${b}`;
    counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, c]) => c >= minCount)
    .sort((x, y) => y[1] - x[1])
    .slice(0, limit)
    .map(([p]) => p);
}

/**
 * Keyword extraction with TF-IDF over a set of documents (e.g. the files of one project).
 * Returns weighted keywords for the whole collection.
 */
export function tfidfKeywords(docs: string[], limit = 25): Array<{ term: string; weight: number }> {
  const df = new Map<string, number>();
  const total = new Map<string, number>();
  for (const doc of docs) {
    const tf = termFrequencies(doc);
    for (const [term, count] of tf) {
      df.set(term, (df.get(term) ?? 0) + 1);
      total.set(term, (total.get(term) ?? 0) + Math.log1p(count));
    }
  }
  const n = Math.max(docs.length, 1);
  const scored = [...total.entries()].map(([term, tf]) => {
    const idf = Math.log((n + 1) / ((df.get(term) ?? 0) + 0.5));
    // Terms present in most files of a project still matter (they are the project's topic), so the IDF
    // is softened instead of letting it push ubiquitous terms to zero.
    return { term, weight: tf * (0.5 + Math.max(idf, 0)) };
  });
  scored.sort((a, b) => b.weight - a.weight);
  const max = scored[0]?.weight ?? 1;
  return scored.slice(0, limit).map((s) => ({ term: s.term, weight: Number((s.weight / max).toFixed(4)) }));
}

export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export function stemmedSet(text: string): Set<string> {
  return new Set(tokenize(text).map(stem));
}
