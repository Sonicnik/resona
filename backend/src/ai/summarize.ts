import { z } from "zod";
import type { Db } from "../db/database.ts";
import type { AiService } from "./client.ts";
import type { ContentIndex } from "../search/index.ts";
import { newId, nowIso, parseJson, sha256, uniq } from "../lib/util.ts";
import { frequentPhrases, splitSentences, tfidfKeywords, truncate } from "../lib/text.ts";

const FIELD = z.enum(["contribution", "results", "problem", "audience", "status", "evidence", "other"]);

export const ProjectSummarySchema = z.object({
  summary: z.string().describe("Two to four sentence overview of the project in plain language."),
  problem: z.string().describe("The problem the project addresses. Empty string if not established."),
  audience: z.string().describe("Who the project is for. Empty string if not established."),
  built: z.string().describe("What was built, researched or written."),
  contribution: z
    .string()
    .describe("The user's individual contribution as established by the material. Empty string if not established."),
  results: z.array(
    z.object({
      claim: z.string(),
      evidence: z.array(z.string()).describe("File references like path:12-30 that support the claim."),
      confidence: z.enum(["high", "medium", "low"]),
    }),
  ),
  capabilities: z.array(z.string()),
  limitations: z.array(z.string()),
  keywords: z.array(z.string()).describe("8-20 specific topic keywords useful for finding related conversations."),
  search_phrases: z.array(z.string()).describe("5-12 natural phrases people might write when they need this work."),
  shareable_material: z.array(z.object({ ref: z.string(), description: z.string() })),
  uncertainties: z.array(z.string()),
  questions: z.array(z.object({ field: FIELD, question: z.string() })).describe("Only facts the material does not establish."),
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

const SYSTEM_PROMPT = `You help a student or early-career person describe their own project accurately so they can contribute to professional conversations about it.

You receive excerpts from files in one project folder, each prefixed with a reference like [path:start-end], plus facts the user stated directly and the previous summary if one exists.

Write a factual project context:
- Ground every result in the material and cite the file references that support it. Do not invent metrics, users, adoption or outcomes. If a result is suggested but not demonstrated, give it low confidence and list it under uncertainties.
- The user's individual contribution is often not established by files alone (a repository can have several authors). Only describe it when the material or the user's own statements establish it; otherwise leave it empty and ask.
- Limitations matter as much as capabilities: the user will be honest with others about what the project does not do.
- Keywords and search phrases should be specific enough to find people discussing the problem the project addresses, not generic terms like "software" or "project".
- Ask brief, targeted questions only for facts the material does not establish (for example the user's role or whether a result was measured). Do not ask about facts the user already stated.
- Shareable material lists files that would be appropriate to show someone (demos, write-ups, READMEs), not internal or sensitive files.
- When a previous summary exists, consolidate: keep what is still supported, update what changed, and drop claims the current material no longer supports. A file change alone does not prove the project improved.`;

interface FileForSummary {
  id: string;
  rel_path: string;
  file_kind: string;
  extracted_text: string;
  hash: string;
  changed_at: string;
}

const KIND_PRIORITY: Record<string, number> = { doc: 0, notebook: 1, web: 2, code: 3, data: 4 };

function filePriority(f: FileForSummary): number {
  const name = f.rel_path.toLowerCase();
  if (/(^|\/)readme(\.|$)/.test(name)) return -3;
  if (/(^|\/)(docs?|paper|report|writeup|notes)\//.test(name)) return -1;
  if (/(changelog|results|evaluation|benchmark)/.test(name)) return -2;
  return KIND_PRIORITY[f.file_kind] ?? 5;
}

export interface SummarizeOutcome {
  status: "created" | "unchanged";
  method: "ai" | "extractive";
  contextId: string;
  version: number;
  questionsAdded: number;
  staleDrafts: number;
  aiError?: string;
}

/**
 * Step 1 of the outreach workflow: produce a versioned, evidence-linked project context.
 * Uses Claude when the folder allows AI processing; otherwise (or on failure) falls back to a
 * local extractive summary so the app still works offline.
 */
export class ProjectSummarizer {
  constructor(
    private readonly db: Db,
    private readonly ai: AiService,
    private readonly index: ContentIndex,
  ) {}

  private loadFiles(projectId: string): FileForSummary[] {
    return this.db.all<FileForSummary>(
      `SELECT id, rel_path, file_kind, extracted_text, hash, changed_at FROM project_files
       WHERE project_id = ? AND processing_state = 'indexed' AND extracted_text IS NOT NULL`,
      [projectId],
    );
  }

  private fingerprint(projectId: string, files: FileForSummary[]): string {
    const answers = this.db.all<{ id: string; answer: string }>(
      "SELECT id, answer FROM clarification_questions WHERE project_id = ? AND status = 'answered' ORDER BY id",
      [projectId],
    );
    const parts = files.map((f) => `${f.rel_path}:${f.hash}`).sort();
    parts.push(...answers.map((a) => `q:${a.id}:${sha256(a.answer ?? "")}`));
    return sha256(parts.join("\n"));
  }

  async summarize(projectId: string, opts: { force?: boolean; preferAi?: boolean } = {}): Promise<SummarizeOutcome> {
    const project = this.db.get<{ name: string; folder_path: string }>(
      "SELECT name, folder_path FROM projects WHERE id = ?",
      [projectId],
    );
    if (!project) throw new Error("project not found");
    const files = this.loadFiles(projectId);
    const fingerprint = this.fingerprint(projectId, files);
    const latest = this.db.get<{ id: string; version: number; source_fingerprint: string; method: string } & Record<string, unknown>>(
      "SELECT * FROM project_contexts WHERE project_id = ? ORDER BY version DESC LIMIT 1",
      [projectId],
    );
    const wantAi = (opts.preferAi ?? true) && this.ai.canUseFor([projectId]);
    if (latest && latest.source_fingerprint === fingerprint && !opts.force && !(wantAi && latest.method === "extractive")) {
      return {
        status: "unchanged",
        method: latest.method as "ai" | "extractive",
        contextId: latest.id,
        version: latest.version,
        questionsAdded: 0,
        staleDrafts: 0,
      };
    }

    const facts = this.db.all<{ question: string; answer: string; field: string }>(
      "SELECT question, answer, field FROM clarification_questions WHERE project_id = ? AND status = 'answered'",
      [projectId],
    );

    let summary: ProjectSummary;
    let method: "ai" | "extractive" = "extractive";
    let model: string | null = null;
    let aiError: string | undefined;
    if (wantAi) {
      try {
        const { prompt, refs } = this.buildPrompt(project.name, files, facts, latest);
        const res = await this.ai.structured({
          purpose: "project_summary",
          projectIds: [projectId],
          inputRefs: refs,
          system: SYSTEM_PROMPT,
          user: prompt,
          schema: ProjectSummarySchema,
        });
        summary = res.data;
        method = "ai";
        model = res.model;
      } catch (err) {
        aiError = err instanceof Error ? err.message : String(err);
        summary = extractiveSummary(project.name, files, facts);
      }
    } else {
      summary = extractiveSummary(project.name, files, facts);
    }

    return this.db.tx(() => {
      const version = (latest?.version ?? 0) + 1;
      const contextId = newId("ctx");
      const now = nowIso();
      this.db.run(
        `INSERT INTO project_contexts (id, project_id, version, method, model, summary, problem, audience, built, contribution,
           results, capabilities, limitations, keywords, search_phrases, evidence, uncertainties, shareable_material, source_fingerprint, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          contextId, projectId, version, method, model, summary.summary, summary.problem, summary.audience, summary.built,
          summary.contribution, summary.results, summary.capabilities, summary.limitations, uniq(summary.keywords),
          uniq(summary.search_phrases), uniq(summary.results.flatMap((r) => r.evidence)), summary.uncertainties,
          summary.shareable_material, fingerprint, now,
        ],
      );
      // Index the context itself so it participates in hybrid matching.
      this.index.indexSource("project_context", projectId, contextText(project.name, summary), projectId);

      let questionsAdded = 0;
      const open = this.db.all<{ question: string; field: string }>(
        "SELECT question, field FROM clarification_questions WHERE project_id = ? AND status IN ('open','answered','dismissed')",
        [projectId],
      );
      const known = new Set(open.map((q) => q.question.trim().toLowerCase()));
      const answeredFields = new Set(facts.map((f) => f.field));
      for (const q of summary.questions.slice(0, 5)) {
        if (known.has(q.question.trim().toLowerCase()) || answeredFields.has(q.field)) continue;
        this.db.run(
          `INSERT INTO clarification_questions (id, project_id, context_version, field, question, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'open', ?)`,
          [newId("q"), projectId, version, q.field, q.question, now],
        );
        questionsAdded++;
      }

      const stale = this.db.run(
        `UPDATE drafts SET stale = 1, stale_reason = ?, updated_at = ?
         WHERE project_id = ? AND status = 'active' AND stale = 0 AND (project_context_id IS NULL OR project_context_id != ?)
           AND NOT EXISTS (SELECT 1 FROM draft_actions a WHERE a.draft_id = drafts.id AND a.state = 'sent')`,
        [`Project context changed (now version ${version}); review the draft against the updated summary.`, now, projectId, contextId],
      );
      this.db.run("UPDATE projects SET last_summarized_at = ?, updated_at = ? WHERE id = ?", [now, now, projectId]);
      return { status: "created", method, contextId, version, questionsAdded, staleDrafts: stale.changes, aiError };
    });
  }

  private buildPrompt(
    name: string,
    files: FileForSummary[],
    facts: Array<{ question: string; answer: string }>,
    previous: Record<string, unknown> | undefined,
  ): { prompt: string; refs: string[] } {
    const budget = this.ai.maxContextChars;
    const sorted = [...files].sort((a, b) => filePriority(a) - filePriority(b) || b.changed_at.localeCompare(a.changed_at));
    const parts: string[] = [];
    const refs: string[] = [];
    let used = 0;
    for (const f of sorted) {
      const lines = f.extracted_text.split("\n");
      const perFileCap = f.file_kind === "code" ? 12_000 : 40_000;
      const body = truncate(f.extracted_text, perFileCap);
      const shownLines = Math.min(lines.length, body.split("\n").length);
      const block = `[${f.rel_path}:1-${shownLines}]\n${body}`;
      if (used + block.length > budget) continue;
      parts.push(block);
      refs.push(`${f.rel_path}:1-${shownLines}`);
      used += block.length;
    }
    const omitted = files.length - refs.length;
    const factBlock = facts.length
      ? facts.map((f) => `- Q: ${f.question}\n  A (stated by the user): ${f.answer}`).join("\n")
      : "(none)";
    const prevBlock = previous
      ? JSON.stringify(
          {
            summary: previous.summary,
            contribution: previous.contribution,
            results: parseJson(previous.results, []),
            capabilities: parseJson(previous.capabilities, []),
            limitations: parseJson(previous.limitations, []),
          },
          null,
          2,
        )
      : "(none)";
    const prompt = `Project folder name: ${name}

<user_stated_facts>
${factBlock}
</user_stated_facts>

<previous_summary>
${prevBlock}
</previous_summary>

<project_files count="${refs.length}"${omitted > 0 ? ` omitted_for_length="${omitted}"` : ""}>
${parts.join("\n\n")}
</project_files>`;
    return { prompt, refs };
  }
}

export function contextText(name: string, s: ProjectSummary): string {
  return [
    `# ${name}`,
    s.summary,
    s.problem && `Problem: ${s.problem}`,
    s.audience && `Audience: ${s.audience}`,
    s.built && `Built: ${s.built}`,
    s.capabilities.length && `Capabilities: ${s.capabilities.join("; ")}`,
    s.results.length && `Results: ${s.results.map((r) => r.claim).join("; ")}`,
    `Keywords: ${s.keywords.join(", ")}`,
    `Phrases: ${s.search_phrases.join("; ")}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Offline fallback: README-led extractive summary with TF-IDF keywords and heuristic sections. */
export function extractiveSummary(
  name: string,
  files: Array<{ rel_path: string; file_kind: string; extracted_text: string }>,
  facts: Array<{ question: string; answer: string; field: string }> = [],
): ProjectSummary {
  const readme = files.find((f) => /(^|\/)readme(\.|$)/i.test(f.rel_path) && !f.rel_path.includes("/"))
    ?? files.find((f) => /readme/i.test(f.rel_path));
  const docs = files.filter((f) => f.file_kind === "doc" || f.file_kind === "notebook");
  const lead = readme ?? docs[0];

  const paragraphs = (lead?.extracted_text ?? "")
    .split(/\n\s*\n/)
    .map((p) => p.replace(/^#+\s.*$/gm, "").replace(/!\[[^\]]*]\([^)]*\)|\[!\[.*$/gm, "").trim())
    .filter((p) => p.length > 40 && !p.startsWith("```") && !/^[-*|]/.test(p));
  const summary = truncate(splitSentences(paragraphs.slice(0, 2).join(" ")).slice(0, 4).join(" "), 700);

  // Prose describes the project better than code identifiers; fall back to code only when there are no docs.
  const corpus = (docs.length ? docs : files).map((f) => f.extracted_text);
  const keywords = tfidfKeywords(corpus, 18).map((k) => k.term);
  const phrases = frequentPhrases(docs.map((d) => d.extracted_text).join("\n") || corpus.join("\n"), 2, 10);

  const sectionItems = (pattern: RegExp): Array<{ text: string; ref: string }> => {
    const out: Array<{ text: string; ref: string }> = [];
    for (const f of docs) {
      const lines = f.extracted_text.split("\n");
      let inSection = false;
      lines.forEach((line, i) => {
        if (/^#{1,6}\s/.test(line)) inSection = pattern.test(line);
        else if (inSection && /^\s*[-*]\s+/.test(line)) {
          out.push({ text: line.replace(/^\s*[-*]\s+/, "").trim(), ref: `${f.rel_path}:${i + 1}` });
        }
      });
    }
    return out.slice(0, 10);
  };
  const capabilities = sectionItems(/feature|capabilit|what it does|highlights|usage/i).map((x) => x.text);
  const limitations = sectionItems(/limitation|known issue|caveat|todo|roadmap|future work/i).map((x) => x.text);

  const results: ProjectSummary["results"] = [];
  for (const f of docs) {
    f.extracted_text.split("\n").forEach((line, i) => {
      if (results.length >= 6) return;
      if (/\d/.test(line) && /(%|accuracy|f1|precision|recall|latency|faster|reduc|improv|users|downloads|stars|score|ms\b|x speed)/i.test(line)) {
        results.push({ claim: truncate(line.replace(/^[-*#>\s|]+/, "").trim(), 240), evidence: [`${f.rel_path}:${i + 1}`], confidence: "low" });
      }
    });
  }

  const contributionFact = facts.find((f) => f.field === "contribution");
  const questions: ProjectSummary["questions"] = [];
  if (!contributionFact) {
    questions.push({ field: "contribution", question: `What was your individual contribution to ${name}?` });
  }
  if (results.length > 0 && !facts.some((f) => f.field === "results")) {
    questions.push({ field: "results", question: "Which of the listed results did you measure yourself, and how?" });
  }
  if (!lead) questions.push({ field: "problem", question: `In one or two sentences, what problem does ${name} address and for whom?` });

  return {
    summary: summary || `${name}: ${files.length} indexed files. Add a README or answer the questions to improve this summary.`,
    problem: facts.find((f) => f.field === "problem")?.answer ?? "",
    audience: facts.find((f) => f.field === "audience")?.answer ?? "",
    built: lead ? truncate(paragraphs[0] ?? "", 300) : "",
    contribution: contributionFact?.answer ?? "",
    results,
    capabilities,
    limitations,
    keywords,
    search_phrases: phrases,
    shareable_material: docs.slice(0, 5).map((d) => ({ ref: d.rel_path, description: "Documentation" })),
    uncertainties: results.length ? ["Results were extracted heuristically and have not been verified."] : [],
    questions,
  };
}
