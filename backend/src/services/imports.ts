import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db/database.ts";
import type { PeopleService } from "./people.ts";
import { normalizeProfileUrl } from "./people.ts";
import type { RelationshipService } from "./relationships.ts";
import { csvRecords } from "../lib/csv.ts";
import { badRequest, sha256 } from "../lib/util.ts";

export interface ArchiveInput {
  /** Folder containing the extracted LinkedIn archive (Connections.csv, messages.csv). */
  path?: string;
  /** Alternatively, the file contents keyed by file name. */
  files?: Record<string, string>;
  /** The user's own LinkedIn profile URL; inferred from messages when omitted. */
  selfProfileUrl?: string;
}

export interface ArchiveReport {
  connections: { rows: number; peopleCreated: number; relationships: number };
  messages: { rows: number; conversations: number; interactionsCreated: number; duplicates: number; peopleCreated: number };
  selfProfileUrl: string | null;
  warnings: string[];
}

function parseLinkedInDate(s: string): string | null {
  if (!s) return null;
  const t = Date.parse(s.replace(" UTC", "Z").replace(" ", "T"));
  if (!Number.isNaN(t)) return new Date(t).toISOString();
  const t2 = Date.parse(s); // e.g. "07 Nov 2026"
  return Number.isNaN(t2) ? null : new Date(t2).toISOString();
}

function findFile(files: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(files).find((k) => path.basename(k).toLowerCase() === name.toLowerCase());
  return key ? files[key] : undefined;
}

function splitList(s: string): string[] {
  // Profile URLs never contain commas or semicolons, so either works as a separator.
  return s
    .split(/[;,]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * Imports a user-downloaded LinkedIn data archive: first-degree connections become mutual,
 * archive-verified relationships; messages become interactions in their original threads.
 * This is the accepted fallback while authorized live LinkedIn access is unavailable.
 */
export class ImportService {
  constructor(
    private readonly db: Db,
    private readonly people: PeopleService,
    private readonly relationships: RelationshipService,
  ) {}

  private loadFiles(input: ArchiveInput): Record<string, string> {
    if (input.files && Object.keys(input.files).length) return input.files;
    if (!input.path) throw badRequest("provide either `path` (extracted archive folder) or `files`");
    const dir = path.resolve(input.path);
    if (!fs.existsSync(dir)) throw badRequest(`archive folder not found: ${dir}`);
    const out: Record<string, string> = {};
    const walk = (d: string, depth: number) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory() && depth < 2) walk(p, depth + 1);
        else if (/^(connections|messages)\.csv$/i.test(e.name)) out[e.name] = fs.readFileSync(p, "utf8");
      }
    };
    walk(dir, 0);
    return out;
  }

  linkedInArchive(input: ArchiveInput): ArchiveReport {
    const files = this.loadFiles(input);
    const report: ArchiveReport = {
      connections: { rows: 0, peopleCreated: 0, relationships: 0 },
      messages: { rows: 0, conversations: 0, interactionsCreated: 0, duplicates: 0, peopleCreated: 0 },
      selfProfileUrl: null,
      warnings: [],
    };
    const connectionsCsv = findFile(files, "Connections.csv");
    const messagesCsv = findFile(files, "messages.csv");
    if (!connectionsCsv && !messagesCsv) throw badRequest("no Connections.csv or messages.csv found in the archive");

    const messages = messagesCsv ? csvRecords(messagesCsv, "conversation id") : [];
    const selfUrl = normalizeProfileUrl(input.selfProfileUrl) ?? this.inferSelf(messages);
    report.selfProfileUrl = selfUrl;
    const selfId = this.people.selfId();
    if (selfUrl) {
      try {
        this.people.addProfile(selfId, { platform: "linkedin", url: selfUrl, source: "linkedin_archive" });
      } catch (err) {
        report.warnings.push(`Could not attach your profile URL: ${(err as Error).message}`);
      }
    } else if (messages.length) {
      report.warnings.push("Could not determine your own profile URL; pass selfProfileUrl so message directions are correct.");
    }

    this.db.tx(() => {
      if (connectionsCsv) {
        for (const r of csvRecords(connectionsCsv, "first name")) {
          report.connections.rows++;
          const name = `${r["first name"] ?? ""} ${r["last name"] ?? ""}`.trim();
          const url = r.url;
          if (!name && !url) continue;
          const { person, created } = this.people.upsertByProfile(
            { platform: "linkedin", url: url || null, displayName: name || null, email: r["email address"] || null, headline: r.position || null, source: "linkedin_archive" },
            { displayName: name || url || "LinkedIn connection", organization: r.company || null, title: r.position || null, status: "contact" },
          );
          if (created) report.connections.peopleCreated++;
          if (!url) report.warnings.push(`Connection "${name}" has no profile URL; it cannot be deduplicated on re-import.`);
          this.relationships.upsertRelationship({
            fromPersonId: selfId,
            toPersonId: person.id,
            type: "connection",
            direction: "mutual",
            platform: "linkedin",
            observedAt: parseLinkedInDate(r["connected on"] ?? ""),
            verificationSource: "archive_import",
            evidence: "LinkedIn data archive: Connections.csv",
          });
          report.connections.relationships++;
        }
      }

      const conversations = new Set<string>();
      for (const m of messages) {
        report.messages.rows++;
        const convId = m["conversation id"] || "unknown";
        conversations.add(convId);
        const occurredAt = parseLinkedInDate(m.date ?? "") ?? new Date(0).toISOString();
        const senderUrl = normalizeProfileUrl(m["sender profile url"]);
        const isSelfSender = Boolean(selfUrl && senderUrl === selfUrl);
        const resolve = (url: string | null, name: string) => {
          if (url && url === selfUrl) return selfId;
          const res = this.people.upsertByProfile(
            { platform: "linkedin", url, displayName: name || null, source: "linkedin_archive" },
            { displayName: name || url || "LinkedIn member" },
          );
          if (res.created) report.messages.peopleCreated++;
          return res.person.id;
        };
        const senderId = isSelfSender ? selfId : resolve(senderUrl, m.from ?? "");
        const recipientUrls = splitList(m["recipient profile urls"] ?? "").map((u) => normalizeProfileUrl(u));
        const recipientNames = (m.to ?? "").split(",").map((s) => s.trim());
        const participants: Array<{ personId: string; role: "sender" | "recipient" }> = [{ personId: senderId, role: "sender" }];
        recipientUrls.forEach((u, i) => participants.push({ personId: resolve(u, recipientNames[i] ?? ""), role: "recipient" }));
        if (!participants.some((p) => p.personId === selfId)) participants.push({ personId: selfId, role: "recipient" });

        const res = this.relationships.recordInteraction({
          platform: "linkedin",
          type: "message",
          direction: isSelfSender ? "outbound" : "inbound",
          occurredAt,
          subject: m.subject || m["conversation title"] || null,
          body: m.content || null,
          externalId: `${convId}:${occurredAt}:${sha256(`${senderUrl}|${m.content ?? ""}`).slice(0, 16)}`,
          threadId: `linkedin:${convId}`,
          sourceRef: "LinkedIn data archive: messages.csv",
          participants,
        });
        if (res.created) report.messages.interactionsCreated++;
        else report.messages.duplicates++;
      }
      report.messages.conversations = conversations.size;
    });
    return report;
  }

  /** The user's own profile is the one present in (nearly) every conversation. */
  private inferSelf(messages: Array<Record<string, string>>): string | null {
    const perConv = new Map<string, Set<string>>();
    for (const m of messages) {
      const conv = m["conversation id"] ?? "";
      const set = perConv.get(conv) ?? new Set<string>();
      const s = normalizeProfileUrl(m["sender profile url"]);
      if (s) set.add(s);
      for (const u of splitList(m["recipient profile urls"] ?? "")) {
        const n = normalizeProfileUrl(u);
        if (n) set.add(n);
      }
      perConv.set(conv, set);
    }
    const counts = new Map<string, number>();
    for (const set of perConv.values()) for (const u of set) counts.set(u, (counts.get(u) ?? 0) + 1);
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!best || perConv.size < 2 || best[1] < perConv.size * 0.8) return null;
    return best[0];
  }
}
