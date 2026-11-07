/**
 * Minimal Markdown + YAML-frontmatter helpers compatible with Obsidian. Supports the frontmatter
 * subset the vault writes: strings, numbers, booleans, null and lists of scalars.
 */

export type FrontmatterValue = string | number | boolean | null | Array<string | number | boolean>;
export type Frontmatter = Record<string, FrontmatterValue>;

export const GENERATED_START = "%% resona:generated:start (edits inside this block are overwritten) %%";
export const GENERATED_END = "%% resona:generated:end %%";

function yamlScalar(v: string | number | boolean | null): string {
  if (v === null) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v === "" || /^[\s]|[\s]$|[:#\[\]{},&*!|>'"%@`]|^(true|false|null|yes|no|~|-?\d+(\.\d+)?)$/i.test(v) || v.includes("\n")) {
    return JSON.stringify(v);
  }
  return v;
}

export function stringifyFrontmatter(fm: Frontmatter): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(fm)) {
    if (Array.isArray(value)) {
      if (value.length === 0) lines.push(`${key}: []`);
      else {
        lines.push(`${key}:`);
        for (const item of value) lines.push(`  - ${yamlScalar(item)}`);
      }
    } else {
      lines.push(`${key}: ${yamlScalar(value)}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

function parseScalar(raw: string): string | number | boolean | null {
  const v = raw.trim();
  if (v === "" || v === "~" || v === "null") return null;
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v) as string;
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

export function parseNote(content: string): { frontmatter: Frontmatter; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { frontmatter: {}, body: content };
  const fm: Frontmatter = {};
  let currentList: string | null = null;
  for (const line of match[1]!.split(/\r?\n/)) {
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && currentList) {
      (fm[currentList] as Array<string | number | boolean>).push(parseScalar(item[1]!) as string);
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_\-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, rest] = kv as unknown as [string, string, string];
    if (rest.trim() === "") {
      fm[key] = [];
      currentList = key;
    } else if (rest.trim().startsWith("[") && rest.trim().endsWith("]")) {
      const inner = rest.trim().slice(1, -1).trim();
      fm[key] = inner ? inner.split(",").map((s) => parseScalar(s) as string) : [];
      currentList = null;
    } else {
      fm[key] = parseScalar(rest);
      currentList = null;
    }
  }
  return { frontmatter: fm, body: content.slice(match[0].length) };
}

/** Splits a note body into the generated block and the user-owned text around it. */
export function splitGenerated(body: string): { before: string; generated: string | null; after: string } {
  const start = body.indexOf(GENERATED_START);
  const end = body.indexOf(GENERATED_END);
  if (start === -1 || end === -1 || end < start) return { before: body, generated: null, after: "" };
  return {
    before: body.slice(0, start),
    generated: body.slice(start + GENERATED_START.length, end),
    after: body.slice(end + GENERATED_END.length),
  };
}

/** Text of a `## Heading` section within user-owned content (until the next heading of the same or higher level). */
export function extractSection(text: string, heading: string): string | null {
  const lines = text.split(/\r?\n/);
  const idx = lines.findIndex((l) => new RegExp(`^##\\s+${heading}\\s*$`, "i").test(l));
  if (idx === -1) return null;
  const out: string[] = [];
  for (let i = idx + 1; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i]!)) break;
    out.push(lines[i]!);
  }
  return out.join("\n").trim();
}

export function extractWikilinks(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|[^\]]*)?]]/g)) out.add(m[1]!.trim());
  return [...out];
}

/** File-system safe note name that still reads well in Obsidian. */
export function safeNoteName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return cleaned || "Untitled";
}

export function wikilink(path: string, alias?: string): string {
  const target = path.replace(/\.md$/, "");
  return alias ? `[[${target}|${alias}]]` : `[[${target}]]`;
}
