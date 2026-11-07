import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db/database.ts";
import type { PeopleService } from "../services/people.ts";
import { nowIso, parseJson, sha256 } from "../lib/util.ts";
import {
  GENERATED_END,
  GENERATED_START,
  extractSection,
  extractWikilinks,
  parseNote,
  safeNoteName,
  splitGenerated,
  stringifyFrontmatter,
  wikilink,
  type Frontmatter,
} from "./markdown.ts";

type EntityType = "person" | "project" | "conversation" | "draft" | "review" | "home";

interface NoteSpec {
  entityType: EntityType;
  entityId: string;
  folder: string;
  title: string;
  frontmatter: Frontmatter;
  generated: string;
  /** Initial user-owned section(s), written only when the note is first created. */
  initialUserContent: string;
}

export interface VaultSyncReport {
  vaultDir: string;
  written: number;
  unchanged: number;
  imported: number;
  removed: number;
  kept: number;
  conflicts: string[];
}

const FOLDERS: Record<EntityType, string> = {
  person: "People",
  project: "Projects",
  conversation: "Conversations",
  draft: "Drafts",
  review: "Reviews",
  home: "",
};

/** Frontmatter keys the user may edit in Obsidian; they are imported back into the database. */
const PERSON_EDITABLE = ["organization", "title", "location", "interests"] as const;

/**
 * Obsidian-style Markdown vault mirroring the local database. Each person, project and conversation
 * becomes a note with YAML frontmatter and [[wikilinks]], so the network can be browsed and graphed
 * in Obsidian. Generated content lives between `%% resona:generated %%` markers; everything outside
 * belongs to the user and is preserved. Person notes and a few frontmatter fields sync back.
 */
export class VaultService {
  constructor(
    private readonly db: Db,
    private readonly people: PeopleService,
    readonly vaultDir: string,
  ) {}

  private abs(rel: string): string {
    return path.join(this.vaultDir, rel);
  }

  /** Maps resona_id → current relative path by scanning managed folders (handles user renames/moves). */
  private scanIds(): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(this.abs(dir), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (e.isDirectory()) walk(rel);
        else if (e.name.endsWith(".md")) {
          try {
            const id = parseNote(fs.readFileSync(this.abs(rel), "utf8")).frontmatter.resona_id;
            if (typeof id === "string") out.set(id, rel);
          } catch {
            /* unreadable */
          }
        }
      }
    };
    walk("");
    return out;
  }

  private mappedPath(entityType: EntityType, entityId: string, ids: Map<string, string>): string | undefined {
    const onDisk = ids.get(`${entityType}:${entityId}`);
    if (onDisk) return onDisk;
    return this.db.get<{ path: string }>("SELECT path FROM vault_files WHERE entity_type = ? AND entity_id = ?", [entityType, entityId])?.path;
  }

  private choosePath(spec: NoteSpec, ids: Map<string, string>, taken: Set<string>): string {
    const existing = this.mappedPath(spec.entityType, spec.entityId, ids);
    if (existing && fs.existsSync(this.abs(existing))) return existing;
    const folder = spec.folder;
    const base = safeNoteName(spec.title);
    let rel = folder ? `${folder}/${base}.md` : `${base}.md`;
    if (taken.has(rel.toLowerCase()) || (fs.existsSync(this.abs(rel)) && ids.get(`${spec.entityType}:${spec.entityId}`) !== rel)) {
      rel = folder ? `${folder}/${base} (${spec.entityId.slice(-6)}).md` : `${base} (${spec.entityId.slice(-6)}).md`;
    }
    return rel;
  }

  private writeNote(spec: NoteSpec, rel: string, report: VaultSyncReport): void {
    const file = this.abs(rel);
    const generated = `${GENERATED_START}\n${spec.generated.trim()}\n${GENERATED_END}`;
    const fm: Frontmatter = { resona_id: `${spec.entityType}:${spec.entityId}`, ...spec.frontmatter };
    let content: string;
    if (fs.existsSync(file)) {
      const current = fs.readFileSync(file, "utf8");
      const parsed = parseNote(current);
      // Keep frontmatter keys the user added; resona-owned keys are refreshed.
      const merged: Frontmatter = { ...parsed.frontmatter, ...fm };
      const parts = splitGenerated(parsed.body);
      const body = parts.generated === null ? `${generated}\n\n${parsed.body.trim()}\n` : `${parts.before}${generated}${parts.after}`;
      content = `${stringifyFrontmatter(merged)}\n${body}`;
      if (content === current) {
        report.unchanged++;
        this.recordFile(rel, spec, generated, content);
        return;
      }
    } else {
      content = `${stringifyFrontmatter(fm)}\n# ${spec.title}\n\n${generated}\n\n${spec.initialUserContent}`.trimEnd() + "\n";
      fs.mkdirSync(path.dirname(file), { recursive: true });
    }
    const tmp = `${file}.resona-tmp`;
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
    this.recordFile(rel, spec, generated, content);
    report.written++;
  }

  private recordFile(rel: string, spec: NoteSpec, generated: string, content: string): void {
    this.db.run("DELETE FROM vault_files WHERE entity_type = ? AND entity_id = ? AND path != ?", [spec.entityType, spec.entityId, rel]);
    this.db.run(
      `INSERT INTO vault_files (path, entity_type, entity_id, generated_hash, file_hash, last_written_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET entity_type = excluded.entity_type, entity_id = excluded.entity_id,
         generated_hash = excluded.generated_hash, file_hash = excluded.file_hash, last_written_at = excluded.last_written_at`,
      [rel, spec.entityType, spec.entityId, sha256(generated), sha256(content), nowIso()],
    );
  }

  /**
   * Imports user edits from person notes (Notes section + editable frontmatter) and records
   * wikilinks typed in user-owned text as mentions. Runs before export so user edits win.
   */
  importEdits(report: VaultSyncReport, ids: Map<string, string>): void {
    const tracked = this.db.all<{ path: string; entity_type: string; entity_id: string; file_hash: string }>("SELECT * FROM vault_files");
    const byBasename = new Map<string, { type: string; id: string }>();
    // Links resolve by display name (when unambiguous) and then by note file name, which wins.
    const names = new Map<string, string[]>();
    for (const p of this.db.all<{ id: string; display_name: string }>("SELECT id, display_name FROM people WHERE merged_into IS NULL")) {
      const key = p.display_name.trim().toLowerCase();
      names.set(key, [...(names.get(key) ?? []), p.id]);
    }
    for (const [name, idsForName] of names) if (idsForName.length === 1) byBasename.set(name, { type: "person", id: idsForName[0]! });
    for (const t of tracked) byBasename.set(path.basename(t.path, ".md").toLowerCase(), { type: t.entity_type, id: t.entity_id });

    for (const t of tracked) {
      const rel = ids.get(`${t.entity_type}:${t.entity_id}`) ?? t.path;
      const file = this.abs(rel);
      if (!fs.existsSync(file)) continue;
      const content = fs.readFileSync(file, "utf8");
      if (sha256(content) === t.file_hash) continue; // untouched since we wrote it
      const { frontmatter, body } = parseNote(content);
      const { before, after } = splitGenerated(body);
      const userText = `${before}\n${after}`;

      this.db.run("DELETE FROM vault_links WHERE from_entity_type = ? AND from_entity_id = ?", [t.entity_type, t.entity_id]);
      for (const target of extractWikilinks(userText)) {
        const resolved = byBasename.get(path.basename(target).toLowerCase());
        this.db.run(
          "INSERT OR IGNORE INTO vault_links (from_entity_type, from_entity_id, target, resolved_type, resolved_id) VALUES (?, ?, ?, ?, ?)",
          [t.entity_type, t.entity_id, target, resolved?.type ?? null, resolved?.id ?? null],
        );
      }

      if (t.entity_type === "person") {
        const exists = this.db.get("SELECT 1 FROM people WHERE id = ?", [t.entity_id]);
        if (!exists) continue;
        const notes = extractSection(userText, "Notes");
        const patch: Record<string, unknown> = {};
        if (notes !== null) patch.notes = notes || null;
        for (const key of PERSON_EDITABLE) {
          if (!(key in frontmatter)) continue;
          const v = frontmatter[key];
          if (key === "interests") patch.interests = Array.isArray(v) ? v.map(String).filter(Boolean) : [];
          else patch[key] = v === null || v === "" ? null : String(v);
        }
        this.people.update(t.entity_id, {
          notes: patch.notes as string | null | undefined,
          organization: patch.organization as string | undefined,
          title: patch.title as string | undefined,
          location: patch.location as string | undefined,
          interests: patch.interests as string[] | undefined,
        });
        report.imported++;
      }
    }
  }

  sync(): VaultSyncReport {
    fs.mkdirSync(this.vaultDir, { recursive: true });
    const report: VaultSyncReport = { vaultDir: this.vaultDir, written: 0, unchanged: 0, imported: 0, removed: 0, kept: 0, conflicts: [] };
    let ids = this.scanIds();
    // Follow renames made in Obsidian before anything else.
    for (const [key, rel] of ids) {
      const [type, ...rest] = key.split(":");
      const id = rest.join(":");
      this.db.run("UPDATE vault_files SET path = ? WHERE entity_type = ? AND entity_id = ? AND path != ?", [rel, type, id, rel]);
    }
    this.importEdits(report, ids);
    ids = this.scanIds();

    const specs = [...this.personSpecs(), ...this.projectSpecs(), ...this.conversationSpecs(), ...this.draftSpecs(), ...this.reviewSpecs()];
    const taken = new Set<string>();
    const paths = new Map<string, string>();
    for (const spec of specs) {
      const rel = this.choosePath(spec, ids, taken);
      taken.add(rel.toLowerCase());
      paths.set(`${spec.entityType}:${spec.entityId}`, rel);
    }
    // Second pass so notes can link to each other's final paths.
    this.linkResolver = (type, id, alias) => {
      const rel = paths.get(`${type}:${id}`);
      return rel ? wikilink(rel, alias) : alias ?? id;
    };
    const rebuilt = [...this.personSpecs(), ...this.projectSpecs(), ...this.conversationSpecs(), ...this.draftSpecs(), ...this.reviewSpecs()];
    for (const spec of rebuilt) this.writeNote(spec, paths.get(`${spec.entityType}:${spec.entityId}`)!, report);
    const home = this.homeSpec();
    this.writeNote(home, "Resona Home.md", report);
    paths.set("home:home", "Resona Home.md");

    // Remove notes whose records are gone, unless the user edited them.
    for (const t of this.db.all<{ path: string; entity_type: string; entity_id: string; file_hash: string }>("SELECT * FROM vault_files")) {
      if (paths.has(`${t.entity_type}:${t.entity_id}`)) continue;
      const file = this.abs(t.path);
      if (fs.existsSync(file) && sha256(fs.readFileSync(file, "utf8")) !== t.file_hash) {
        report.kept++;
        report.conflicts.push(`${t.path}: record deleted but note has your edits; left in place`);
      } else if (fs.existsSync(file)) {
        fs.rmSync(file);
        report.removed++;
      }
      this.db.run("DELETE FROM vault_files WHERE path = ?", [t.path]);
    }
    this.linkResolver = null;
    return report;
  }

  private linkResolver: ((type: EntityType, id: string, alias?: string) => string) | null = null;

  private link(type: EntityType, id: string, alias?: string): string {
    return this.linkResolver ? this.linkResolver(type, id, alias) : alias ?? id;
  }

  // ---- note builders ----

  private personSpecs(): NoteSpec[] {
    const rows = this.db.all<Record<string, unknown>>("SELECT * FROM people WHERE merged_into IS NULL");
    return rows.map((p) => {
      const id = String(p.id);
      const profiles = this.db.all<Record<string, unknown>>("SELECT * FROM person_profiles WHERE person_id = ?", [id]);
      const rels = this.db.all<Record<string, unknown>>(
        `SELECT r.*, a.display_name AS from_name, b.display_name AS to_name FROM relationships r
         JOIN people a ON a.id = r.from_person_id JOIN people b ON b.id = r.to_person_id
         WHERE r.from_person_id = ? OR r.to_person_id = ?`,
        [id, id],
      );
      const threads = this.db.all<{ thread: string; n: number; last: string }>(
        `SELECT COALESCE(i.thread_id, i.id) AS thread, COUNT(*) AS n, MAX(i.occurred_at) AS last
         FROM interactions i JOIN interaction_participants ip ON ip.interaction_id = i.id WHERE ip.person_id = ?
         GROUP BY thread ORDER BY last DESC LIMIT 50`,
        [id],
      );
      const opps = this.db.all<Record<string, unknown>>(
        `SELECT o.id, o.state, o.relevance, o.scenario, o.project_id, pr.name AS project_name, sp.url
         FROM opportunities o JOIN projects pr ON pr.id = o.project_id JOIN source_posts sp ON sp.id = o.source_post_id
         WHERE o.person_id = ? ORDER BY o.relevance DESC LIMIT 10`,
        [id],
      );
      const followups = this.db.all<Record<string, unknown>>("SELECT * FROM followups WHERE person_id = ? AND state = 'open'", [id]);
      const lines: string[] = [];
      if (p.bio) lines.push(`> ${String(p.bio).replace(/\n/g, " ")}`, "");
      if (profiles.length) {
        lines.push("## Profiles");
        for (const pr of profiles) lines.push(`- **${pr.platform}**: ${pr.url ? `[${pr.handle ?? pr.url}](${pr.url})` : pr.handle ?? pr.external_id ?? ""}`);
        lines.push("");
      }
      if (rels.length) {
        lines.push("## Relationships");
        for (const r of rels) {
          const otherId = r.from_person_id === id ? String(r.to_person_id) : String(r.from_person_id);
          const otherName = r.from_person_id === id ? String(r.to_name) : String(r.from_name);
          const dir = r.direction === "mutual" ? "↔" : r.from_person_id === id ? "→" : "←";
          lines.push(`- ${dir} ${this.link("person", otherId, otherName)}: ${r.type}${r.platform ? ` on ${r.platform}` : ""} (${r.verification_source}${r.observed_at ? `, ${String(r.observed_at).slice(0, 10)}` : ""})`);
        }
        lines.push("");
      }
      if (opps.length) {
        lines.push("## Projects and opportunities");
        for (const o of opps) {
          lines.push(`- ${this.link("project", String(o.project_id), String(o.project_name))}: ${String(o.scenario).replace(/_/g, " ")} (${o.state}, relevance ${Number(o.relevance).toFixed(2)})${o.url ? ` [source](${o.url})` : ""}`);
        }
        lines.push("");
      }
      if (threads.length) {
        lines.push("## Conversations");
        for (const t of threads) lines.push(`- ${this.link("conversation", t.thread, `${t.last.slice(0, 10)} (${t.n})`)}`);
        lines.push("");
      }
      if (followups.length) {
        lines.push("## Follow-ups");
        for (const f of followups) lines.push(`- [ ] ${f.reason}${f.due_at ? ` (due ${String(f.due_at).slice(0, 10)})` : ""}`);
        lines.push("");
      }
      const interests = parseJson<string[]>(p.interests, []);
      return {
        entityType: "person" as const,
        entityId: id,
        folder: FOLDERS.person,
        title: String(p.display_name),
        frontmatter: {
          type: "person",
          status: String(p.status),
          organization: (p.organization as string) ?? null,
          title: (p.title as string) ?? null,
          location: (p.location as string) ?? null,
          interests,
          platforms: [...new Set(profiles.map((pr) => String(pr.platform)))],
          tags: [`resona/person`, `resona/${p.status}`],
          aliases: [...new Set(profiles.map((pr) => pr.handle).filter((h): h is string => typeof h === "string" && h.length > 0))],
          updated: String(p.updated_at),
        },
        generated: lines.join("\n") || "_No recorded activity yet._",
        initialUserContent: `## Notes\n\n${p.notes ?? ""}\n`,
      };
    });
  }

  private projectSpecs(): NoteSpec[] {
    return this.db.all<Record<string, unknown>>("SELECT * FROM projects").map((p) => {
      const id = String(p.id);
      const ctx = this.db.get<Record<string, unknown>>("SELECT * FROM project_contexts WHERE project_id = ? ORDER BY version DESC LIMIT 1", [id]);
      const questions = this.db.all<Record<string, unknown>>("SELECT * FROM clarification_questions WHERE project_id = ? AND status = 'open'", [id]);
      const people = this.db.all<{ person_id: string; display_name: string }>(
        `SELECT DISTINCT o.person_id, pe.display_name FROM opportunities o JOIN people pe ON pe.id = o.person_id WHERE o.project_id = ? LIMIT 50`,
        [id],
      );
      const lines: string[] = [];
      if (ctx) {
        lines.push(String(ctx.summary), "");
        const field = (label: string, v: unknown) => v && lines.push(`**${label}:** ${v}`);
        field("Problem", ctx.problem);
        field("Audience", ctx.audience);
        field("Built", ctx.built);
        field("Your contribution", ctx.contribution || "_not established yet - see open questions_");
        lines.push("");
        const list = (heading: string, items: string[]) => {
          if (!items.length) return;
          lines.push(`## ${heading}`, ...items.map((i) => `- ${i}`), "");
        };
        list("Results", parseJson<Array<{ claim: string; evidence: string[]; confidence: string }>>(ctx.results, []).map((r) => `${r.claim} _(${r.confidence}; ${r.evidence.join(", ")})_`));
        list("Capabilities", parseJson<string[]>(ctx.capabilities, []));
        list("Limitations", parseJson<string[]>(ctx.limitations, []));
        list("Uncertainties", parseJson<string[]>(ctx.uncertainties, []));
        lines.push(`_Context v${ctx.version} (${ctx.method}${ctx.model ? `, ${ctx.model}` : ""}) generated ${String(ctx.created_at).slice(0, 10)}._`, "");
      } else {
        lines.push("_Not summarized yet._", "");
      }
      if (questions.length) lines.push("## Open questions", ...questions.map((q) => `- ${q.question}`), "");
      if (people.length) lines.push("## People", ...people.map((x) => `- ${this.link("person", x.person_id, x.display_name)}`), "");
      return {
        entityType: "project" as const,
        entityId: id,
        folder: FOLDERS.project,
        title: String(p.name),
        frontmatter: {
          type: "project",
          folder: String(p.folder_path),
          kind: String(p.kind),
          ai_permission: String(p.ai_permission),
          status: String(p.status),
          keywords: ctx ? parseJson<string[]>(ctx.keywords, []) : [],
          tags: ["resona/project"],
          last_scan: (p.last_scan_at as string) ?? null,
        },
        generated: lines.join("\n"),
        initialUserContent: "## Notes\n\n",
      };
    });
  }

  private conversationSpecs(): NoteSpec[] {
    const rows = this.db.all<Record<string, unknown>>(
      `SELECT i.*, COALESCE(i.thread_id, i.id) AS thread FROM interactions i ORDER BY i.occurred_at`,
    );
    const threads = new Map<string, Array<Record<string, unknown>>>();
    for (const r of rows) threads.set(String(r.thread), [...(threads.get(String(r.thread)) ?? []), r]);
    const selfId = this.people.selfId();
    return [...threads.entries()].map(([thread, items]) => {
      const participantRows = this.db.all<{ person_id: string; display_name: string; role: string; interaction_id: string }>(
        `SELECT ip.person_id, p.display_name, ip.role, ip.interaction_id FROM interaction_participants ip JOIN people p ON p.id = ip.person_id
         WHERE ip.interaction_id IN (${items.map(() => "?").join(",")})`,
        items.map((i) => i.id),
      );
      const others = [...new Map(participantRows.filter((p) => p.person_id !== selfId).map((p) => [p.person_id, p.display_name])).entries()];
      const first = items[0]!;
      const titleWho = others.map(([, n]) => n).slice(0, 3).join(", ") || "Note";
      const title = `${String(first.occurred_at).slice(0, 10)} ${titleWho}${first.subject ? ` - ${first.subject}` : ""}`;
      const lines = [
        `**Participants:** ${others.map(([pid, n]) => this.link("person", pid, n)).join(", ") || "you"}`,
        `**Platform:** ${first.platform}${items.some((i) => i.is_group === 1) ? " (group)" : ""}`,
        "",
      ];
      for (const it of items) {
        const sender = participantRows.find((p) => p.interaction_id === it.id && p.role === "sender");
        const who = sender ? (sender.person_id === selfId ? "You" : sender.display_name) : String(it.direction);
        lines.push(`### ${String(it.occurred_at).replace("T", " ").slice(0, 16)} · ${who} · ${it.type}`);
        if (it.body) lines.push("", String(it.body).trim());
        if (it.source_ref) lines.push("", `_Source: ${it.source_ref}_`);
        lines.push("");
      }
      return {
        entityType: "conversation" as const,
        entityId: thread,
        folder: FOLDERS.conversation,
        title,
        frontmatter: {
          type: "conversation",
          platform: String(first.platform),
          started: String(first.occurred_at),
          last: String(items[items.length - 1]!.occurred_at),
          messages: items.length,
          tags: ["resona/conversation"],
        },
        generated: lines.join("\n"),
        initialUserContent: "## Notes\n\n",
      };
    });
  }

  private draftSpecs(): NoteSpec[] {
    const rows = this.db.all<Record<string, unknown>>(
      `SELECT d.*, r.body, r.title AS rev_title, r.author, p.display_name, pr.name AS project_name,
              (SELECT state FROM draft_actions a WHERE a.draft_id = d.id ORDER BY a.created_at DESC LIMIT 1) AS action_state
       FROM drafts d JOIN draft_revisions r ON r.draft_id = d.id AND r.revision = d.current_revision
       LEFT JOIN people p ON p.id = d.person_id LEFT JOIN projects pr ON pr.id = d.project_id
       WHERE d.status = 'active'`,
    );
    return rows.map((d) => ({
      entityType: "draft" as const,
      entityId: String(d.id),
      folder: FOLDERS.draft,
      title: `${String(d.created_at).slice(0, 10)} ${d.kind === "post" ? `${d.platform} post` : `to ${d.display_name ?? "unknown"}`}${d.project_name ? ` - ${d.project_name}` : ""}`,
      frontmatter: {
        type: "draft",
        kind: String(d.kind),
        platform: String(d.platform),
        channel: String(d.channel),
        revision: Number(d.current_revision),
        state: (d.action_state as string) ?? "draft",
        stale: d.stale === 1,
        tags: ["resona/draft"],
      },
      generated: [
        d.person_id ? `**To:** ${this.link("person", String(d.person_id), String(d.display_name))}` : "",
        d.project_id ? `**Project:** ${this.link("project", String(d.project_id), String(d.project_name))}` : "",
        d.stale === 1 ? `> [!warning] ${d.stale_reason}` : "",
        "",
        "> [!note] Edit drafts in the app: edits made here are not imported, and nothing is sent without your approval.",
        "",
        String(d.body),
      ]
        .filter((l) => l !== undefined)
        .join("\n"),
      initialUserContent: "",
    }));
  }

  private reviewSpecs(): NoteSpec[] {
    return this.db.all<Record<string, unknown>>("SELECT * FROM weekly_reviews ORDER BY created_at DESC LIMIT 26").map((r) => {
      const payload = parseJson<Record<string, unknown>>(r.payload, {});
      return {
        entityType: "review" as const,
        entityId: String(r.id),
        folder: FOLDERS.review,
        title: `Weekly review ${String(r.period_end).slice(0, 10)}`,
        frontmatter: { type: "weekly-review", period_start: String(r.period_start), period_end: String(r.period_end), tags: ["resona/review"] },
        generated: String(payload.markdown ?? "```json\n" + JSON.stringify(payload, null, 2) + "\n```"),
        initialUserContent: "## Reflections\n\n",
      };
    });
  }

  private homeSpec(): NoteSpec {
    const counts = this.db.get<Record<string, number>>(
      `SELECT (SELECT COUNT(*) FROM people WHERE merged_into IS NULL AND is_self = 0) AS people,
              (SELECT COUNT(*) FROM projects) AS projects,
              (SELECT COUNT(*) FROM opportunities WHERE state IN ('new','shortlisted')) AS open_opportunities,
              (SELECT COUNT(*) FROM followups WHERE state = 'open') AS open_followups`,
    )!;
    const due = this.db.all<Record<string, unknown>>(
      `SELECT f.reason, f.due_at, f.person_id, p.display_name FROM followups f JOIN people p ON p.id = f.person_id
       WHERE f.state = 'open' ORDER BY COALESCE(f.due_at, '9999') LIMIT 10`,
    );
    const projects = this.db.all<{ id: string; name: string }>("SELECT id, name FROM projects ORDER BY name");
    return {
      entityType: "home",
      entityId: "home",
      folder: "",
      title: "Resona Home",
      frontmatter: { type: "home", tags: ["resona"] },
      generated: [
        `People: ${counts.people} · Projects: ${counts.projects} · Open opportunities: ${counts.open_opportunities} · Open follow-ups: ${counts.open_followups}`,
        "",
        "## Projects",
        ...projects.map((p) => `- ${this.link("project", p.id, p.name)}`),
        "",
        "## Follow-ups",
        ...(due.length ? due.map((f) => `- [ ] ${this.link("person", String(f.person_id), String(f.display_name))}: ${f.reason}${f.due_at ? ` (due ${String(f.due_at).slice(0, 10)})` : ""}`) : ["_None._"]),
        "",
        `_Synced ${nowIso().slice(0, 16).replace("T", " ")}. Open Obsidian's graph view, filtered to the People folder, to see the people-only network._`,
      ].join("\n"),
      initialUserContent: "",
    };
  }
}
