import type { Db } from "../db/database.ts";
import { badRequest, newId, notFound, nowIso } from "../lib/util.ts";
import type { PeopleService } from "./people.ts";

export type RelationshipType = "connection" | "follows" | "colleague" | "classmate" | "mentor" | "introduced" | "other";
export type Verification = "platform_api" | "archive_import" | "user_confirmed" | "observed";

export interface RelationshipInput {
  fromPersonId: string;
  toPersonId: string;
  type: RelationshipType;
  direction?: "directed" | "mutual";
  platform?: string | null;
  observedAt?: string | null;
  verificationSource: Verification;
  evidence?: string | null;
}

export interface InteractionInput {
  platform: string;
  type: "message" | "reply" | "comment" | "meeting" | "email" | "post_engagement" | "note";
  direction: "outbound" | "inbound" | "mutual" | "none";
  occurredAt: string;
  subject?: string | null;
  body?: string | null;
  externalId?: string | null;
  threadId?: string | null;
  sourceRef?: string | null;
  actionId?: string | null;
  participants: Array<{ personId: string; role: "sender" | "recipient" | "attendee" | "mentioned" | "member" }>;
}

const MUTUAL_BY_DEFAULT: RelationshipType[] = ["connection", "colleague", "classmate"];

/**
 * Relationships are evidence-backed assertions that two people know each other (or that one follows
 * the other). Shared interests or co-membership in a group never create a relationship.
 */
export class RelationshipService {
  constructor(
    private readonly db: Db,
    private readonly people: PeopleService,
  ) {}

  upsertRelationship(input: RelationshipInput): string {
    if (input.fromPersonId === input.toPersonId) throw badRequest("a relationship needs two different people");
    const from = this.people.resolve(input.fromPersonId).id;
    const to = this.people.resolve(input.toPersonId).id;
    const direction = input.direction ?? (MUTUAL_BY_DEFAULT.includes(input.type) ? "mutual" : "directed");
    // Mutual relationships are stored once with a canonical endpoint order.
    const [a, b] = direction === "mutual" && from > to ? [to, from] : [from, to];
    const platform = input.platform ?? "";
    const existing = this.db.get<{ id: string }>(
      "SELECT id FROM relationships WHERE from_person_id = ? AND to_person_id = ? AND type = ? AND platform = ?",
      [a, b, input.type, platform],
    );
    if (existing) {
      this.db.run(
        "UPDATE relationships SET observed_at = COALESCE(?, observed_at), evidence = COALESCE(?, evidence), verification_source = ? WHERE id = ?",
        [input.observedAt, input.evidence, input.verificationSource, existing.id],
      );
      return existing.id;
    }
    const id = newId("rel");
    this.db.run(
      `INSERT INTO relationships (id, from_person_id, to_person_id, type, direction, platform, observed_at, verification_source, evidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, a, b, input.type, direction, platform, input.observedAt, input.verificationSource, input.evidence, nowIso()],
    );
    // An accepted connection or a user-confirmed relationship with the user makes the person a contact.
    const selfId = this.people.selfId();
    if (a === selfId || b === selfId) {
      const other = a === selfId ? b : a;
      if (input.type !== "follows" || direction === "mutual") {
        this.db.run("UPDATE people SET status = 'contact', updated_at = ? WHERE id = ? AND status = 'prospect'", [nowIso(), other]);
      }
    }
    return id;
  }

  listRelationships(personId?: string) {
    if (personId) {
      return this.db.all(
        "SELECT * FROM relationships WHERE from_person_id = ? OR to_person_id = ? ORDER BY observed_at DESC",
        [personId, personId],
      );
    }
    return this.db.all("SELECT * FROM relationships ORDER BY created_at DESC LIMIT 1000");
  }

  deleteRelationship(id: string): void {
    const res = this.db.run("DELETE FROM relationships WHERE id = ?", [id]);
    if (res.changes === 0) throw notFound("relationship");
  }

  recordInteraction(input: InteractionInput): { id: string; created: boolean } {
    if (input.participants.length === 0) throw badRequest("an interaction needs at least one participant");
    return this.db.tx(() => {
      if (input.externalId) {
        const existing = this.db.get<{ id: string }>(
          "SELECT id FROM interactions WHERE platform = ? AND external_id = ?",
          [input.platform, input.externalId],
        );
        if (existing) return { id: existing.id, created: false };
      }
      const id = newId("int");
      const participants = input.participants.map((p) => ({ ...p, personId: this.people.resolve(p.personId).id }));
      const distinct = new Set(participants.map((p) => p.personId));
      const isGroup = distinct.size > 2 ? 1 : 0;
      this.db.run(
        `INSERT INTO interactions (id, platform, type, direction, occurred_at, subject, body, external_id, thread_id, source_ref, action_id, is_group, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id, input.platform, input.type, input.direction, input.occurredAt, input.subject, input.body, input.externalId,
          input.threadId, input.sourceRef, input.actionId, isGroup, nowIso(),
        ],
      );
      for (const p of participants) {
        this.db.run("INSERT OR IGNORE INTO interaction_participants (interaction_id, person_id, role) VALUES (?, ?, ?)", [
          id,
          p.personId,
          p.role,
        ]);
      }
      // A reply received from a prospect promotes them to contact; a mere outbound message does not.
      if (input.direction === "inbound" || input.direction === "mutual") {
        const selfId = this.people.selfId();
        for (const pid of distinct) {
          if (pid === selfId || isGroup) continue;
          this.db.run("UPDATE people SET status = 'contact', updated_at = ? WHERE id = ? AND status = 'prospect'", [nowIso(), pid]);
        }
      }
      return { id, created: true };
    });
  }

  interactionsFor(personId: string, limit = 100) {
    return this.db.all(
      `SELECT i.*, ip.role FROM interactions i JOIN interaction_participants ip ON ip.interaction_id = i.id
       WHERE ip.person_id = ? ORDER BY i.occurred_at DESC LIMIT ?`,
      [personId, limit],
    );
  }

  listInteractions(opts: { since?: string; limit?: number } = {}) {
    return this.db.all(
      "SELECT * FROM interactions WHERE (? IS NULL OR occurred_at >= ?) ORDER BY occurred_at DESC LIMIT ?",
      [opts.since ?? null, opts.since ?? null, opts.limit ?? 200],
    );
  }

  participants(interactionId: string) {
    return this.db.all<{ person_id: string; role: string; display_name: string }>(
      `SELECT ip.person_id, ip.role, p.display_name FROM interaction_participants ip JOIN people p ON p.id = ip.person_id
       WHERE ip.interaction_id = ?`,
      [interactionId],
    );
  }

  deleteInteraction(id: string): void {
    const res = this.db.run("DELETE FROM interactions WHERE id = ?", [id]);
    if (res.changes === 0) throw notFound("interaction");
  }

  // ---- follow-ups ----

  createFollowup(input: {
    personId: string;
    reason: string;
    dueAt?: string | null;
    interactionId?: string | null;
    projectId?: string | null;
    origin?: "user" | "suggested";
  }): string {
    const person = this.people.resolve(input.personId);
    const id = newId("fu");
    const now = nowIso();
    this.db.run(
      `INSERT INTO followups (id, person_id, interaction_id, project_id, reason, due_at, state, origin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
      [id, person.id, input.interactionId, input.projectId, input.reason, input.dueAt, input.origin ?? "user", now, now],
    );
    return id;
  }

  updateFollowup(id: string, patch: { state?: string; dueAt?: string | null; reason?: string }): void {
    const res = this.db.run(
      `UPDATE followups SET state = COALESCE(?, state), due_at = CASE WHEN ? THEN ? ELSE due_at END,
         reason = COALESCE(?, reason), updated_at = ? WHERE id = ?`,
      [patch.state, patch.dueAt !== undefined ? 1 : 0, patch.dueAt ?? null, patch.reason, nowIso(), id],
    );
    if (res.changes === 0) throw notFound("follow-up");
  }

  listFollowups(opts: { state?: string; personId?: string; dueBefore?: string } = {}) {
    return this.db.all(
      `SELECT f.*, p.display_name FROM followups f JOIN people p ON p.id = f.person_id
       WHERE (? IS NULL OR f.state = ?) AND (? IS NULL OR f.person_id = ?) AND (? IS NULL OR (f.due_at IS NOT NULL AND f.due_at <= ?))
       ORDER BY COALESCE(f.due_at, '9999') ASC`,
      [opts.state ?? null, opts.state ?? null, opts.personId ?? null, opts.personId ?? null, opts.dueBefore ?? null, opts.dueBefore ?? null],
    );
  }
}
