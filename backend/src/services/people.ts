import type { Db } from "../db/database.ts";
import { conflict, newId, notFound, nowIso, parseJson, badRequest } from "../lib/util.ts";

export interface ProfileInput {
  platform: string;
  externalId?: string | null;
  handle?: string | null;
  url?: string | null;
  displayName?: string | null;
  headline?: string | null;
  email?: string | null;
  source?: string;
}

export interface PersonInput {
  displayName: string;
  bio?: string | null;
  organization?: string | null;
  title?: string | null;
  location?: string | null;
  notes?: string | null;
  interests?: string[];
  status?: "prospect" | "contact" | "archived";
}

export interface PersonRow {
  id: string;
  display_name: string;
  bio: string | null;
  organization: string | null;
  title: string | null;
  location: string | null;
  notes: string | null;
  interests: string;
  is_self: number;
  status: string;
  merged_into: string | null;
  created_at: string;
  updated_at: string;
}

/** Canonical form for profile URLs so the same profile is recognized across imports. */
export function normalizeProfileUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.trim());
    const host = u.hostname.toLowerCase().replace(/^(www\.|m\.|[a-z]{2}\.)(?=linkedin\.com$)/, "").replace(/^www\./, "");
    const pathname = decodeURIComponent(u.pathname).replace(/\/+$/, "").toLowerCase();
    return `https://${host}${pathname}`;
  } catch {
    return url.trim().toLowerCase().replace(/\/+$/, "");
  }
}

export function personToJson(row: PersonRow) {
  return {
    id: row.id,
    displayName: row.display_name,
    bio: row.bio,
    organization: row.organization,
    title: row.title,
    location: row.location,
    notes: row.notes,
    interests: parseJson<string[]>(row.interests, []),
    isSelf: row.is_self === 1,
    status: row.status,
    mergedInto: row.merged_into,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * People and identities. One person can have many platform profiles. Profiles are deduplicated by
 * stable platform IDs or canonical profile URLs only; people are never merged by name alone.
 */
export class PeopleService {
  constructor(private readonly db: Db) {}

  ensureSelf(displayName = "Me"): PersonRow {
    const existing = this.db.get<PersonRow>("SELECT * FROM people WHERE is_self = 1");
    if (existing) return existing;
    const id = newId("per");
    const now = nowIso();
    this.db.run(
      "INSERT INTO people (id, display_name, is_self, status, created_at, updated_at) VALUES (?, ?, 1, 'self', ?, ?)",
      [id, displayName, now, now],
    );
    return this.db.get<PersonRow>("SELECT * FROM people WHERE id = ?", [id])!;
  }

  selfId(): string {
    return this.ensureSelf().id;
  }

  get(id: string): PersonRow {
    const row = this.db.get<PersonRow>("SELECT * FROM people WHERE id = ?", [id]);
    if (!row) throw notFound("person");
    return row;
  }

  /** Follows merge pointers so stale references resolve to the surviving record. */
  resolve(id: string): PersonRow {
    let row = this.get(id);
    for (let i = 0; i < 10 && row.merged_into; i++) row = this.get(row.merged_into);
    return row;
  }

  list(opts: { q?: string; status?: string; limit?: number; offset?: number } = {}): PersonRow[] {
    const where = ["merged_into IS NULL"];
    const params: unknown[] = [];
    if (opts.status) {
      where.push("status = ?");
      params.push(opts.status);
    }
    if (opts.q) {
      where.push(
        "(display_name LIKE ? OR organization LIKE ? OR bio LIKE ? OR id IN (SELECT person_id FROM person_profiles WHERE handle LIKE ? OR url LIKE ?))",
      );
      const like = `%${opts.q}%`;
      params.push(like, like, like, like, like);
    }
    params.push(opts.limit ?? 200, opts.offset ?? 0);
    return this.db.all<PersonRow>(
      `SELECT * FROM people WHERE ${where.join(" AND ")} ORDER BY is_self DESC, updated_at DESC LIMIT ? OFFSET ?`,
      params,
    );
  }

  create(input: PersonInput): PersonRow {
    if (!input.displayName.trim()) throw badRequest("displayName is required");
    const id = newId("per");
    const now = nowIso();
    this.db.run(
      `INSERT INTO people (id, display_name, bio, organization, title, location, notes, interests, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, input.displayName.trim(), input.bio, input.organization, input.title, input.location, input.notes,
        input.interests ?? [], input.status ?? "prospect", now, now,
      ],
    );
    return this.get(id);
  }

  update(id: string, patch: Partial<PersonInput>): PersonRow {
    const row = this.get(id);
    const fields: Record<string, unknown> = {
      display_name: patch.displayName,
      bio: patch.bio,
      organization: patch.organization,
      title: patch.title,
      location: patch.location,
      notes: patch.notes,
      interests: patch.interests,
      status: row.is_self ? undefined : patch.status,
    };
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [col, val] of Object.entries(fields)) {
      if (val === undefined) continue;
      sets.push(`${col} = ?`);
      params.push(val);
    }
    if (sets.length === 0) return row;
    sets.push("updated_at = ?");
    params.push(nowIso(), id);
    this.db.run(`UPDATE people SET ${sets.join(", ")} WHERE id = ?`, params);
    return this.get(id);
  }

  profiles(personId: string) {
    return this.db.all<Record<string, unknown>>(
      "SELECT * FROM person_profiles WHERE person_id = ? ORDER BY platform",
      [personId],
    );
  }

  findProfile(p: Pick<ProfileInput, "platform" | "externalId" | "url">): { id: string; person_id: string } | undefined {
    if (p.externalId) {
      const byId = this.db.get<{ id: string; person_id: string }>(
        "SELECT id, person_id FROM person_profiles WHERE platform = ? AND external_id = ?",
        [p.platform, p.externalId],
      );
      if (byId) return byId;
    }
    const url = normalizeProfileUrl(p.url);
    if (url) {
      return this.db.get<{ id: string; person_id: string }>(
        "SELECT id, person_id FROM person_profiles WHERE platform = ? AND url = ?",
        [p.platform, url],
      );
    }
    return undefined;
  }

  /**
   * Finds the person behind a platform identity or creates a new prospect. Returns whether the
   * person was newly created. Without an external id or URL a new person is always created.
   */
  upsertByProfile(profile: ProfileInput, person?: Partial<PersonInput>): { person: PersonRow; profileId: string; created: boolean } {
    return this.db.tx(() => {
      const found = this.findProfile(profile);
      const now = nowIso();
      if (found) {
        this.db.run(
          `UPDATE person_profiles SET handle = COALESCE(?, handle), display_name = COALESCE(?, display_name),
             headline = COALESCE(?, headline), email = COALESCE(?, email), external_id = COALESCE(external_id, ?), updated_at = ?
           WHERE id = ?`,
          [profile.handle, profile.displayName, profile.headline, profile.email, profile.externalId, now, found.id],
        );
        const resolved = this.resolve(found.person_id);
        return { person: resolved, profileId: found.id, created: false };
      }
      const created = this.create({
        displayName: person?.displayName ?? profile.displayName ?? profile.handle ?? "Unknown",
        ...person,
      });
      const profileId = this.addProfile(created.id, profile);
      return { person: created, profileId, created: true };
    });
  }

  addProfile(personId: string, p: ProfileInput): string {
    this.get(personId);
    const existing = this.findProfile(p);
    if (existing) {
      if (existing.person_id !== personId) {
        throw conflict("This profile already belongs to another person; merge the two people instead.", {
          personId: existing.person_id,
        });
      }
      return existing.id;
    }
    const id = newId("prof");
    const now = nowIso();
    this.db.run(
      `INSERT INTO person_profiles (id, person_id, platform, external_id, handle, url, display_name, headline, email, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, personId, p.platform, p.externalId, p.handle, normalizeProfileUrl(p.url), p.displayName, p.headline, p.email,
        p.source ?? "manual", now, now,
      ],
    );
    return id;
  }

  removeProfile(profileId: string): void {
    this.db.run("DELETE FROM person_profiles WHERE id = ?", [profileId]);
  }

  /**
   * Explicit, user-initiated identity merge. Moves every reference from `mergeId` onto `keepId`
   * and leaves a pointer on the merged record so nothing dangles.
   */
  merge(keepId: string, mergeId: string): PersonRow {
    if (keepId === mergeId) throw badRequest("cannot merge a person into themselves");
    const keep = this.resolve(keepId);
    const drop = this.resolve(mergeId);
    if (drop.is_self) throw badRequest("merge other people into the self record, not the reverse");
    return this.db.tx(() => {
      const now = nowIso();
      this.db.run("UPDATE person_profiles SET person_id = ? WHERE person_id = ?", [keep.id, drop.id]);
      for (const col of ["from_person_id", "to_person_id"]) {
        this.db.run(`UPDATE OR IGNORE relationships SET ${col} = ? WHERE ${col} = ?`, [keep.id, drop.id]);
        this.db.run(`DELETE FROM relationships WHERE ${col} = ?`, [drop.id]);
      }
      this.db.run("DELETE FROM relationships WHERE from_person_id = to_person_id");
      this.db.run("UPDATE OR IGNORE interaction_participants SET person_id = ? WHERE person_id = ?", [keep.id, drop.id]);
      this.db.run("DELETE FROM interaction_participants WHERE person_id = ?", [drop.id]);
      this.db.run("UPDATE opportunities SET person_id = ? WHERE person_id = ?", [keep.id, drop.id]);
      this.db.run("UPDATE drafts SET person_id = ? WHERE person_id = ?", [keep.id, drop.id]);
      this.db.run("UPDATE followups SET person_id = ? WHERE person_id = ?", [keep.id, drop.id]);
      this.db.run("UPDATE source_posts SET author_person_id = ? WHERE author_person_id = ?", [keep.id, drop.id]);
      const interests = [...new Set([...parseJson<string[]>(keep.interests, []), ...parseJson<string[]>(drop.interests, [])])];
      const notes = [keep.notes, drop.notes].filter(Boolean).join("\n\n") || null;
      const status = keep.is_self ? "self" : keep.status === "contact" || drop.status === "contact" ? "contact" : keep.status;
      this.db.run(
        `UPDATE people SET interests = ?, notes = ?, status = ?, bio = COALESCE(bio, ?), organization = COALESCE(organization, ?),
           title = COALESCE(title, ?), location = COALESCE(location, ?), updated_at = ? WHERE id = ?`,
        [interests, notes, status, drop.bio, drop.organization, drop.title, drop.location, now, keep.id],
      );
      this.db.run("UPDATE people SET merged_into = ?, status = 'archived', updated_at = ? WHERE id = ?", [keep.id, now, drop.id]);
      return this.get(keep.id);
    });
  }

  /** Candidate duplicates for manual review: same email or same normalized name + organization. */
  duplicateCandidates(): Array<{ a: string; b: string; reason: string }> {
    const byEmail = this.db.all<{ a: string; b: string; email: string }>(
      `SELECT p1.person_id AS a, p2.person_id AS b, p1.email AS email FROM person_profiles p1
       JOIN person_profiles p2 ON p1.email = p2.email AND p1.person_id < p2.person_id
       JOIN people x ON x.id = p1.person_id AND x.merged_into IS NULL
       JOIN people y ON y.id = p2.person_id AND y.merged_into IS NULL
       WHERE p1.email IS NOT NULL AND p1.email != ''`,
    );
    const byName = this.db.all<{ a: string; b: string }>(
      `SELECT x.id AS a, y.id AS b FROM people x JOIN people y
         ON lower(trim(x.display_name)) = lower(trim(y.display_name)) AND x.id < y.id
         AND COALESCE(lower(x.organization), '') = COALESCE(lower(y.organization), '')
       WHERE x.merged_into IS NULL AND y.merged_into IS NULL AND x.is_self = 0 AND y.is_self = 0`,
    );
    return [
      ...byEmail.map((r) => ({ a: r.a, b: r.b, reason: `same email (${r.email})` })),
      ...byName.map((r) => ({ a: r.a, b: r.b, reason: "same name and organization (verify before merging)" })),
    ];
  }

  delete(id: string): void {
    const row = this.get(id);
    if (row.is_self) throw badRequest("the self record cannot be deleted");
    this.db.run("DELETE FROM people WHERE id = ?", [id]);
  }
}
