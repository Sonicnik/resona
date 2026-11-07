import path from "node:path";

export const MAX_TEXT_BYTES = 1_000_000;

const DOC_EXT = new Set([".md", ".markdown", ".mdx", ".txt", ".rst", ".adoc", ".org", ".tex", ".rtf"]);
const CODE_EXT = new Set([
  ".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".go", ".rs", ".java", ".kt", ".kts", ".swift", ".c", ".h",
  ".cc", ".cpp", ".hpp", ".m", ".mm", ".rb", ".php", ".cs", ".scala", ".r", ".jl", ".sql", ".sh", ".bash", ".zsh",
  ".lua", ".dart", ".ex", ".exs", ".erl", ".hs", ".ml", ".clj", ".vue", ".svelte", ".sol", ".zig", ".nim",
]);
const DATA_EXT = new Set([".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".csv", ".tsv", ".xml"]);
const WEB_EXT = new Set([".html", ".htm"]);
const NOTEBOOK_EXT = new Set([".ipynb"]);
const KNOWN_BINARY = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".svg", ".ico", ".mp4", ".mov", ".avi", ".mp3", ".wav", ".m4a",
  ".zip", ".tar", ".gz", ".tgz", ".bz2", ".7z", ".rar", ".dmg", ".iso", ".woff", ".woff2", ".ttf", ".otf", ".sqlite",
  ".db", ".parquet", ".npy", ".npz", ".pt", ".pth", ".onnx", ".h5", ".pkl", ".bin",
]);
const NEEDS_PARSER = new Set([".pdf", ".docx", ".pptx", ".xlsx", ".key", ".pages", ".numbers", ".doc"]);

export type FileKind = "doc" | "code" | "data" | "web" | "notebook";

export type Classification =
  | { supported: true; kind: FileKind }
  | { supported: false; reason: string };

export function classify(relPath: string, size: number): Classification {
  const ext = path.extname(relPath).toLowerCase();
  const base = path.basename(relPath).toLowerCase();
  if (KNOWN_BINARY.has(ext)) return { supported: false, reason: `binary file (${ext})` };
  if (NEEDS_PARSER.has(ext)) return { supported: false, reason: `no parser installed for ${ext} yet` };
  if (size > MAX_TEXT_BYTES * 5) return { supported: false, reason: "file too large" };
  if (DOC_EXT.has(ext) || ["readme", "license", "changelog", "authors", "contributing"].includes(base)) {
    return { supported: true, kind: "doc" };
  }
  if (CODE_EXT.has(ext) || ["dockerfile", "makefile"].includes(base)) return { supported: true, kind: "code" };
  if (DATA_EXT.has(ext)) return { supported: true, kind: "data" };
  if (WEB_EXT.has(ext)) return { supported: true, kind: "web" };
  if (NOTEBOOK_EXT.has(ext)) return { supported: true, kind: "notebook" };
  return { supported: false, reason: ext ? `unsupported type (${ext})` : "unsupported type (no extension)" };
}

function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, 8000);
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious++;
  }
  return sample.length > 0 && suspicious / sample.length > 0.1;
}

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Anthropic API key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["OpenAI-style API key", /\bsk-[A-Za-z0-9]{32,}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ["Slack token", /\bxox[abpr]-[A-Za-z0-9-]{10,}/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
];

/** Detects obvious credentials so the file is never indexed or sent to a model. */
export function detectSecret(text: string): string | null {
  for (const [name, re] of SECRET_PATTERNS) if (re.test(text)) return name;
  return null;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|h[1-6]|li|br|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

function notebookText(raw: string): string {
  try {
    const nb = JSON.parse(raw) as { cells?: Array<{ cell_type?: string; source?: string | string[] }> };
    return (nb.cells ?? [])
      .map((cell) => {
        const src = Array.isArray(cell.source) ? cell.source.join("") : (cell.source ?? "");
        return cell.cell_type === "code" ? "```\n" + src + "\n```" : src;
      })
      .join("\n\n");
  } catch {
    return raw;
  }
}

export type Extraction = { ok: true; text: string; truncated: boolean } | { ok: false; reason: string };

export function extractText(buf: Buffer, kind: FileKind): Extraction {
  if (looksBinary(buf)) return { ok: false, reason: "binary content" };
  const truncated = buf.length > MAX_TEXT_BYTES;
  let text = buf.subarray(0, MAX_TEXT_BYTES).toString("utf8");
  if (kind === "web") text = stripHtml(text);
  if (kind === "notebook") text = notebookText(text);
  if (kind === "data") {
    // Large data files carry little narrative context; keep the head only.
    const lines = text.split("\n");
    if (lines.length > 200) text = `${lines.slice(0, 200).join("\n")}\n… (${lines.length - 200} more lines)`;
  }
  const secret = detectSecret(text);
  if (secret) return { ok: false, reason: `possible credential detected (${secret}); excluded` };
  return { ok: true, text, truncated };
}
