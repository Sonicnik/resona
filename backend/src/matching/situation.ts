import { splitSentences, stem, tokenize, truncate } from "../lib/text.ts";

export interface Situation {
  /** What kind of post and its title, e.g. "Pull request · feat: add team matching". Null when the post has no title. */
  headline: string | null;
  /** The one sentence that best says what the author needs or is doing. */
  gist: string;
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m);
}

/** Markdown/HTML to plain lines: drops code, images, link targets, URLs, headings and formatting marks. */
function plainLines(text: string): string[] {
  return decodeEntities(text)
    .replace(/```[\s\S]*?```/g, "\n")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|p|div|li)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .split(/\n+/)
    .filter((l) => !/^\s{0,3}#{1,6}\s/.test(l)) // section headings ("## What does this PR do?") are not the author's point
    .map((l) =>
      l
        .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+\.|>)\s+/, "")
        .replace(/[*_`~|]+/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((l) => l.length > 0 && !/^[^.!?]{0,30}:$/.test(l)); // labels left behind by removed links ("Demo video:")
}

function kindOf(platform: string, url: string | null): string | null {
  if (platform !== "github" || !url) return null;
  return /\/pull\/\d+/.test(url) ? "Pull request" : /\/issues\/\d+/.test(url) ? "Issue" : null;
}

/**
 * A short, extractive summary of a long post: its title plus the single sentence that best states the
 * author's need (questions and sentences sharing the project's terms score highest). No model call.
 */
export function summarizeSituation(post: { text: string; title?: string | null; platform: string; url?: string | null }, sharedTerms: string[] = []): Situation {
  const title = post.title ? truncate(plainLines(post.title).join(" "), 110) : null;
  const kind = kindOf(post.platform, post.url ?? null);
  const headline = title ? (kind ? `${kind} · ${title}` : title) : null;

  const lines = plainLines(post.text);
  if (title && lines[0] && plainLines(post.title ?? "").join(" ") === lines[0]) lines.shift(); // body repeats the title
  const sentences = lines.flatMap((l) => splitSentences(/[.!?:]$/.test(l) ? l : `${l}.`));
  const terms = new Set(sharedTerms.flatMap((t) => tokenize(t)).map(stem));
  let best = "";
  let bestScore = -Infinity;
  sentences.forEach((s, i) => {
    if (s.length < 20) return;
    const words = new Set(tokenize(s).map(stem));
    const overlap = [...terms].filter((t) => words.has(t)).length;
    // A real question states the need; earlier sentences usually carry the point; long ones read badly when cut.
    const score = (/\?["')”]*$/.test(s) && s.length >= 40 ? 2 : 0) + overlap + 2 * (1 - i / sentences.length) - (s.length > 300 ? 1 : 0);
    if (score > bestScore) [best, bestScore] = [s, score];
  });
  return { headline, gist: truncate((best || lines.join(" ")).replace(/\.\.$/, "."), 180) };
}
