import type { Db } from "../db/database.ts";
import type { PeopleService } from "../services/people.ts";
import type { ProjectService } from "../services/projects.ts";
import type { ContentIndex } from "../search/index.ts";
import { centroid, cosine } from "../search/embeddings.ts";
import { parseJson, daysBetween, clamp } from "../lib/util.ts";
import { stem, tokenize, jaccard } from "../lib/text.ts";
import {
  alternativePaths,
  betweenness,
  buildAdjacency,
  decay,
  labelPropagation,
  pageRank,
  type WEdge,
} from "./algorithms.ts";
import { INDUSTRIES, INDUSTRY_BY_ID, inferIndustry } from "./industries.ts";

/** Interaction weights for tie strength. Replies received and meetings say more than one-way messages. */
const INTERACTION_WEIGHT: Record<string, { outbound: number; inbound: number; mutual: number; none: number }> = {
  meeting: { outbound: 3, inbound: 3, mutual: 3, none: 2 },
  message: { outbound: 0.8, inbound: 1.6, mutual: 1.6, none: 0.5 },
  email: { outbound: 0.8, inbound: 1.6, mutual: 1.6, none: 0.5 },
  reply: { outbound: 0.6, inbound: 1.2, mutual: 1.2, none: 0.4 },
  comment: { outbound: 0.4, inbound: 0.9, mutual: 0.9, none: 0.3 },
  post_engagement: { outbound: 0.2, inbound: 0.4, mutual: 0.4, none: 0.1 },
  note: { outbound: 0.1, inbound: 0.1, mutual: 0.1, none: 0.1 },
};

const RELATIONSHIP_BASE: Record<string, number> = {
  mentor: 2,
  colleague: 1.5,
  classmate: 1.2,
  connection: 0.8,
  introduced: 0.6,
  follows: 0.25,
  other: 0.4,
};

const VERIFICATION_FACTOR: Record<string, number> = {
  user_confirmed: 1,
  platform_api: 1,
  archive_import: 1,
  observed: 0.7,
};

const HALF_LIFE_DAYS = 180;

/** Converts accumulated evidence into a bounded strength in [0, 1). */
export function strengthFromScore(raw: number): number {
  return 1 - Math.exp(-raw / 3);
}

export type EdgeKind = "relationship" | "interaction" | "proposed";

export interface NetworkEdge {
  id: string;
  kind: EdgeKind;
  from: string;
  to: string;
  directed: boolean;
  /** Only relationship and interaction edges assert that people know each other. */
  establishesRelationship: boolean;
  strength: number;
  label: string;
  explanation: string;
  evidence: Array<Record<string, unknown>>;
}

export interface NetworkNode {
  id: string;
  label: string;
  isSelf: boolean;
  status: string;
  organization: string | null;
  title: string | null;
  interests: string[];
  platforms: string[];
  tieStrength: number;
  lastInteractionAt: string | null;
  interactionCount: number;
  pageRank: number;
  bridgeScore: number;
  community: string | null;
  openOpportunities: number;
  pendingDrafts: number;
  openFollowups: number;
  projectIds: string[];
  /** Network group. `source` is "user" when chosen on the person, else "inferred" from their profile and posts. */
  industry: { id: string; name: string; source: "user" | "inferred" } | null;
}

export interface InterestLink {
  a: string;
  b: string;
  sharedInterests: string[];
  similarity: number;
  establishesRelationship: false;
  explanation: string;
}

export interface GraphOptions {
  projectId?: string;
  includeProposed?: boolean;
  includeArchived?: boolean;
  includeInterestLinks?: boolean;
  minStrength?: number;
}

interface PairAgg {
  a: string;
  b: string;
  raw: number;
  count: number;
  inbound: number;
  outbound: number;
  last: string;
  firstAt: string;
  interactions: string[];
}

/**
 * People-only professional network. Nodes are people (the user at the centre). Edges are:
 *  - relationship: observed or user-confirmed relationships with their verification source;
 *  - interaction: derived from actual 1:1 interactions (group threads never create edges);
 *  - proposed: open outreach opportunities (dashed in the UI; not a relationship).
 * Shared interests are returned separately as `interestLinks` and never as relationships.
 */
export class NetworkService {
  constructor(
    private readonly db: Db,
    private readonly people: PeopleService,
    private readonly projects: ProjectService,
    private readonly index: ContentIndex,
  ) {}

  private interactionPairs(now: Date): Map<string, PairAgg> {
    const rows = this.db.all<{
      interaction_id: string;
      type: string;
      direction: string;
      occurred_at: string;
      is_group: number;
      persons: string;
    }>(
      `SELECT i.id AS interaction_id, i.type, i.direction, i.occurred_at, i.is_group,
              json_group_array(DISTINCT pr.id) AS persons
       FROM interactions i
       JOIN interaction_participants ip ON ip.interaction_id = i.id
       JOIN people pr ON pr.id = COALESCE((SELECT m.merged_into FROM people m WHERE m.id = ip.person_id), ip.person_id)
       GROUP BY i.id`,
    );
    const pairs = new Map<string, PairAgg>();
    for (const r of rows) {
      const persons = parseJson<string[]>(r.persons, []).sort();
      if (r.is_group || persons.length !== 2) continue;
      const [a, b] = persons as [string, string];
      const key = `${a}|${b}`;
      const w = INTERACTION_WEIGHT[r.type]?.[r.direction as "inbound"] ?? 0.3;
      const contribution = w * decay(daysBetween(r.occurred_at, now), HALF_LIFE_DAYS);
      const agg = pairs.get(key) ?? { a, b, raw: 0, count: 0, inbound: 0, outbound: 0, last: r.occurred_at, firstAt: r.occurred_at, interactions: [] };
      agg.raw += contribution;
      agg.count++;
      if (r.direction === "inbound") agg.inbound++;
      if (r.direction === "outbound") agg.outbound++;
      if (r.direction === "mutual") {
        agg.inbound++;
        agg.outbound++;
      }
      if (r.occurred_at > agg.last) agg.last = r.occurred_at;
      if (r.occurred_at < agg.firstAt) agg.firstAt = r.occurred_at;
      if (agg.interactions.length < 20) agg.interactions.push(r.interaction_id);
      pairs.set(key, agg);
    }
    for (const agg of pairs.values()) {
      // Reciprocity: a conversation in both directions is a stronger signal than many one-way messages.
      if (agg.inbound > 0 && agg.outbound > 0) agg.raw *= 1.5;
    }
    return pairs;
  }

  graph(opts: GraphOptions = {}) {
    const now = new Date();
    const selfId = this.people.selfId();
    const peopleRows = this.db.all<Record<string, unknown>>(
      `SELECT p.*, (SELECT json_group_array(DISTINCT platform) FROM person_profiles pp WHERE pp.person_id = p.id) AS platforms
       FROM people p WHERE p.merged_into IS NULL ${opts.includeArchived ? "" : "AND p.status != 'archived'"}`,
    );
    const nodeIds = new Set(peopleRows.map((p) => String(p.id)));
    const edges: NetworkEdge[] = [];

    // Relationship edges (+ base strength contributions per pair).
    const relRows = this.db.all<Record<string, unknown>>("SELECT * FROM relationships");
    const pairRaw = new Map<string, number>();
    for (const r of relRows) {
      const from = String(r.from_person_id);
      const to = String(r.to_person_id);
      if (!nodeIds.has(from) || !nodeIds.has(to)) continue;
      const raw = (RELATIONSHIP_BASE[String(r.type)] ?? 0.4) * (VERIFICATION_FACTOR[String(r.verification_source)] ?? 0.7);
      const key = [from, to].sort().join("|");
      pairRaw.set(key, (pairRaw.get(key) ?? 0) + raw);
      edges.push({
        id: String(r.id),
        kind: "relationship",
        from,
        to,
        directed: r.direction === "directed",
        establishesRelationship: true,
        strength: Number(strengthFromScore(raw).toFixed(3)),
        label: `${r.type}${r.platform ? ` (${r.platform})` : ""}`,
        explanation: `${r.direction === "directed" ? "Directed" : "Mutual"} ${r.type} relationship, ${r.verification_source}${
          r.observed_at ? `, observed ${String(r.observed_at).slice(0, 10)}` : ""
        }.`,
        evidence: [{ type: "relationship", id: r.id, verification: r.verification_source, evidence: r.evidence }],
      });
    }

    // Interaction edges.
    const pairs = this.interactionPairs(now);
    for (const agg of pairs.values()) {
      if (!nodeIds.has(agg.a) || !nodeIds.has(agg.b)) continue;
      const key = `${agg.a}|${agg.b}`;
      pairRaw.set(key, (pairRaw.get(key) ?? 0) + agg.raw);
      const reciprocal = agg.inbound > 0 && agg.outbound > 0;
      edges.push({
        id: `int:${key}`,
        kind: "interaction",
        from: agg.a,
        to: agg.b,
        directed: false,
        establishesRelationship: true,
        strength: Number(strengthFromScore(agg.raw).toFixed(3)),
        label: `${agg.count} interaction${agg.count === 1 ? "" : "s"}`,
        explanation: `${agg.count} direct interactions (${agg.outbound} outbound, ${agg.inbound} inbound${
          reciprocal ? ", reciprocal" : ""
        }), last on ${agg.last.slice(0, 10)}.`,
        evidence: agg.interactions.map((id) => ({ type: "interaction", id })),
      });
    }

    // Proposed outreach edges (not relationships).
    const oppRows = this.db.all<Record<string, unknown>>(
      `SELECT o.id, o.person_id, o.relevance, o.scenario, o.match_reason, o.project_id, pr.name AS project_name
       FROM opportunities o JOIN projects pr ON pr.id = o.project_id
       WHERE o.state IN ('new','shortlisted') AND o.person_id IS NOT NULL`,
    );
    if (opts.includeProposed ?? true) {
      const bestByPerson = new Map<string, Record<string, unknown>>();
      for (const o of oppRows) {
        const pid = String(o.person_id);
        if (!bestByPerson.has(pid) || Number(o.relevance) > Number(bestByPerson.get(pid)!.relevance)) bestByPerson.set(pid, o);
      }
      for (const [pid, o] of bestByPerson) {
        if (!nodeIds.has(pid)) continue;
        edges.push({
          id: `opp:${o.id}`,
          kind: "proposed",
          from: selfId,
          to: pid,
          directed: true,
          establishesRelationship: false,
          strength: Number(Number(o.relevance).toFixed(3)),
          label: `proposed: ${String(o.scenario).replace(/_/g, " ")}`,
          explanation: `Suggested outreach for ${o.project_name}: ${o.match_reason}`,
          evidence: [{ type: "opportunity", id: o.id, projectId: o.project_id }],
        });
      }
    }

    // Tie strength per pair combines relationship + interaction evidence.
    const pairStrength = new Map([...pairRaw.entries()].map(([k, raw]) => [k, strengthFromScore(raw)]));
    const minStrength = opts.minStrength ?? 0;
    const weighted: WEdge[] = [...pairStrength.entries()]
      .filter(([, s]) => s >= minStrength)
      .map(([k, s]) => {
        const [a, b] = k.split("|") as [string, string];
        const directedOnly = relRows.some(
          (r) => [r.from_person_id, r.to_person_id].sort().join("|") === k && r.direction === "directed",
        ) && !pairs.has(k);
        return { from: a, to: b, weight: s, directed: directedOnly };
      });

    const ids = [...nodeIds];
    const fullAdj = buildAdjacency(ids, weighted);
    const pr = pageRank(fullAdj);
    // Communities and bridges are computed on the network *without* the user: in an ego network the
    // centre connects to everyone and would otherwise swallow all structure.
    const egoless = buildAdjacency(ids, weighted, { exclude: new Set([selfId]) });
    const labels = labelPropagation(egoless);
    const bridge = egoless.size <= 1500 ? betweenness(egoless) : new Map<string, number>();
    const communitySize = new Map<string, number>();
    for (const l of labels.values()) communitySize.set(l, (communitySize.get(l) ?? 0) + 1);

    const counts = (sql: string) =>
      new Map(this.db.all<{ person_id: string; n: number }>(sql).map((r) => [r.person_id, Number(r.n)]));
    const openOpps = counts("SELECT person_id, COUNT(*) AS n FROM opportunities WHERE state IN ('new','shortlisted') AND person_id IS NOT NULL GROUP BY person_id");
    const pendingDrafts = counts(
      `SELECT d.person_id, COUNT(*) AS n FROM drafts d WHERE d.status = 'active' AND d.person_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM draft_actions a WHERE a.draft_id = d.id AND a.state = 'sent') GROUP BY d.person_id`,
    );
    const openFollowups = counts("SELECT person_id, COUNT(*) AS n FROM followups WHERE state = 'open' GROUP BY person_id");
    const personProjects = new Map<string, Set<string>>();
    for (const r of this.db.all<{ person_id: string; project_id: string }>(
      `SELECT person_id, project_id FROM opportunities WHERE person_id IS NOT NULL
       UNION SELECT person_id, project_id FROM drafts WHERE person_id IS NOT NULL AND project_id IS NOT NULL
       UNION SELECT person_id, project_id FROM followups WHERE project_id IS NOT NULL`,
    )) {
      const set = personProjects.get(r.person_id) ?? new Set();
      set.add(r.project_id);
      personProjects.set(r.person_id, set);
    }

    // Signals for industry groups: profile headlines and the text of each person's posts.
    const headlines = new Map<string, string[]>();
    for (const r of this.db.all<{ person_id: string; headline: string }>("SELECT person_id, headline FROM person_profiles WHERE headline IS NOT NULL")) {
      headlines.set(r.person_id, [...(headlines.get(r.person_id) ?? []), r.headline]);
    }
    const postsBy = new Map<string, string[]>();
    for (const r of this.db.all<{ author_person_id: string; text: string }>(
      "SELECT author_person_id, substr(COALESCE(title, '') || ' ' || text, 1, 2000) AS text FROM source_posts WHERE author_person_id IS NOT NULL ORDER BY retrieved_at DESC LIMIT 2000",
    )) {
      const list = postsBy.get(r.author_person_id) ?? [];
      if (list.length < 10) postsBy.set(r.author_person_id, [...list, r.text]);
    }
    const industryOf = (p: Record<string, unknown>): NetworkNode["industry"] => {
      const chosen = typeof p.industry === "string" ? INDUSTRY_BY_ID.get(p.industry) : undefined;
      if (chosen) return { id: chosen.id, name: chosen.name, source: "user" };
      if (p.is_self === 1) return null;
      const id = inferIndustry({
        profile: [String(p.title ?? ""), String(p.organization ?? ""), ...(headlines.get(String(p.id)) ?? [])],
        about: [String(p.bio ?? ""), ...parseJson<string[]>(p.interests, [])],
        posts: postsBy.get(String(p.id)) ?? [],
      });
      const found = id ? INDUSTRY_BY_ID.get(id) : undefined;
      return found ? { id: found.id, name: found.name, source: "inferred" } : null;
    };

    let nodes: NetworkNode[] = peopleRows.map((p) => {
      const id = String(p.id);
      const pairKey = [id, selfId].sort().join("|");
      const agg = pairs.get(pairKey);
      const label = labels.get(id);
      return {
        id,
        label: String(p.display_name),
        isSelf: p.is_self === 1,
        status: String(p.status),
        organization: (p.organization as string) ?? null,
        title: (p.title as string) ?? null,
        interests: parseJson<string[]>(p.interests, []),
        platforms: parseJson<Array<string | null>>(p.platforms, []).filter((x): x is string => Boolean(x)),
        tieStrength: id === selfId ? 1 : Number((pairStrength.get(pairKey) ?? 0).toFixed(3)),
        lastInteractionAt: agg?.last ?? null,
        interactionCount: agg?.count ?? 0,
        pageRank: Number((pr.get(id) ?? 0).toFixed(5)),
        bridgeScore: Number((bridge.get(id) ?? 0).toFixed(5)),
        community: label && (communitySize.get(label) ?? 0) > 1 ? `c_${label}` : null,
        openOpportunities: openOpps.get(id) ?? 0,
        pendingDrafts: pendingDrafts.get(id) ?? 0,
        openFollowups: openFollowups.get(id) ?? 0,
        projectIds: [...(personProjects.get(id) ?? [])],
        industry: industryOf(p),
      };
    });

    // Filter by project/topic without adding project nodes to the people-only graph.
    if (opts.projectId) {
      const profile = this.projects.profile(opts.projectId);
      const kw = new Set((profile?.keywords ?? []).flatMap((k) => tokenize(k).map(stem)));
      nodes = nodes.filter(
        (n) =>
          n.isSelf ||
          n.projectIds.includes(opts.projectId!) ||
          (kw.size > 0 && jaccard(new Set(n.interests.flatMap((i) => tokenize(i).map(stem))), kw) > 0),
      );
    }
    const kept = new Set(nodes.map((n) => n.id));
    const keptEdges = edges.filter((e) => kept.has(e.from) && kept.has(e.to) && (e.kind === "proposed" || e.strength >= minStrength));

    const communities = new Map<string, string[]>();
    for (const n of nodes) {
      if (!n.community) continue;
      communities.set(n.community, [...(communities.get(n.community) ?? []), n.id]);
    }

    // Combined tie strength per pair (relationship + interaction evidence): the weights used for paths.
    const ties = weighted
      .filter((w) => kept.has(w.from) && kept.has(w.to))
      .map((w) => ({ a: w.from, b: w.to, strength: Number(w.weight.toFixed(3)), directedOnly: w.directed }));

    return {
      selfId,
      generatedAt: now.toISOString(),
      nodes,
      edges: keptEdges,
      ties,
      communities: [...communities.entries()].map(([id, members]) => ({ id, size: members.length, members })),
      industries: INDUSTRIES.map((i) => ({ id: i.id, name: i.name })),
      interestLinks: opts.includeInterestLinks ? this.interestLinks(nodes.filter((n) => !n.isSelf)) : [],
      legend: {
        ties: "Combined strength per pair of people (0-1) from relationships and interactions; used for paths.",
        relationship: "Observed or user-confirmed relationship (solid). Direction shown when it matters.",
        interaction: "Derived from actual 1:1 interactions; strength decays with a 180-day half-life.",
        proposed: "Suggested outreach, not a relationship (dashed).",
        interestLinks: "People who share interests. This never implies they know each other.",
      },
    };
  }

  /** Pairs of people with overlapping interests (top 3 per person), flagged as non-relationships. */
  private interestLinks(nodes: NetworkNode[]): InterestLink[] {
    const sets = nodes.map((n) => ({ id: n.id, raw: n.interests, stems: new Set(n.interests.map((i) => stem(i.toLowerCase()))) }));
    const out: InterestLink[] = [];
    for (const a of sets) {
      const scored: InterestLink[] = [];
      for (const b of sets) {
        if (a.id >= b.id || a.stems.size === 0 || b.stems.size === 0) continue;
        const sim = jaccard(a.stems, b.stems);
        if (sim <= 0) continue;
        const shared = a.raw.filter((i) => b.stems.has(stem(i.toLowerCase())));
        scored.push({
          a: a.id,
          b: b.id,
          sharedInterests: shared,
          similarity: Number(sim.toFixed(3)),
          establishesRelationship: false,
          explanation: `Both list: ${shared.join(", ")}. Shared interests do not mean they know each other.`,
        });
      }
      out.push(...scored.sort((x, y) => y.similarity - x.similarity).slice(0, 3));
    }
    return out;
  }

  /** Everything the UI shows when a person is selected (product reference §10). */
  personDetail(personId: string) {
    const person = this.people.resolve(personId);
    const selfId = this.people.selfId();
    const id = person.id;
    const graph = this.graph({ includeArchived: true });
    const node = graph.nodes.find((n) => n.id === id);
    const discovered = this.db.all<Record<string, unknown>>(
      "SELECT id, platform, url, title, text, published_at, retrieved_at, connector, query FROM source_posts WHERE author_person_id = ? ORDER BY retrieved_at DESC LIMIT 20",
      [id],
    );
    const opportunities = this.db.all<Record<string, unknown>>(
      `SELECT o.id, o.state, o.relevance, o.scenario, o.match_reason, o.project_id, o.evidence, pr.name AS project_name
       FROM opportunities o JOIN projects pr ON pr.id = o.project_id WHERE o.person_id = ? ORDER BY o.relevance DESC`,
      [id],
    );
    const projects = new Map<string, { projectId: string; name: string; via: string[]; evidence: unknown[] }>();
    for (const o of opportunities) {
      const pid = String(o.project_id);
      const entry = projects.get(pid) ?? { projectId: pid, name: String(o.project_name), via: [], evidence: [] };
      entry.via.push(`opportunity ${o.id} (${o.state})`);
      entry.evidence.push(...parseJson<unknown[]>(o.evidence, []).slice(0, 2));
      projects.set(pid, entry);
    }
    const interactions = this.db.all<Record<string, unknown>>(
      `SELECT i.id, i.platform, i.type, i.direction, i.occurred_at, i.subject, substr(i.body, 1, 500) AS body, i.is_group, i.source_ref, ip.role
       FROM interactions i JOIN interaction_participants ip ON ip.interaction_id = i.id
       WHERE ip.person_id = ? ORDER BY i.occurred_at DESC LIMIT 100`,
      [id],
    );
    const drafts = this.db.all<Record<string, unknown>>(
      `SELECT d.id, d.kind, d.platform, d.channel, d.stale, d.current_revision, d.updated_at,
              (SELECT state FROM draft_actions a WHERE a.draft_id = d.id ORDER BY a.created_at DESC LIMIT 1) AS action_state
       FROM drafts d WHERE d.person_id = ? AND d.status = 'active' ORDER BY d.updated_at DESC`,
      [id],
    );
    const followups = this.db.all("SELECT * FROM followups WHERE person_id = ? ORDER BY COALESCE(due_at, '9999')", [id]);
    const relationships = graph.edges.filter((e) => e.kind === "relationship" && (e.from === id || e.to === id));
    const mentions = this.db.all(
      "SELECT from_entity_type, from_entity_id, target FROM vault_links WHERE resolved_type = 'person' AND resolved_id = ?",
      [id],
    );

    return {
      person: {
        id,
        displayName: person.display_name,
        bio: person.bio,
        organization: person.organization,
        title: person.title,
        location: person.location,
        notes: person.notes,
        status: person.status,
        isSelf: person.is_self === 1,
        interests: parseJson<string[]>(person.interests, []),
      },
      profiles: this.people.profiles(id),
      metrics: node ?? null,
      connectionStatus: this.connectionStatus(id, selfId),
      discoveredVia: discovered,
      projects: [...projects.values()],
      sharedInterests: this.sharedInterests(id),
      interactions,
      opportunities: opportunities.map((o) => ({ ...o, evidence: parseJson(o.evidence, []) })),
      drafts,
      followups,
      relationships,
      vaultMentions: mentions,
      /** Choices for the person's industry group (see `metrics.industry` for the current one). */
      industries: INDUSTRIES.map((i) => ({ id: i.id, name: i.name })),
    };
  }

  /** Observed platform status. Approved, sent, replied and connected are reported separately. */
  private connectionStatus(personId: string, selfId: string) {
    const rel = this.db.all<Record<string, unknown>>(
      `SELECT type, platform, direction, verification_source, observed_at, from_person_id FROM relationships
       WHERE (from_person_id = ? AND to_person_id = ?) OR (from_person_id = ? AND to_person_id = ?)`,
      [personId, selfId, selfId, personId],
    );
    const counts = this.db.get<{ outbound: number; inbound: number }>(
      `SELECT SUM(i.direction = 'outbound') AS outbound, SUM(i.direction IN ('inbound','mutual')) AS inbound
       FROM interactions i JOIN interaction_participants ip ON ip.interaction_id = i.id WHERE ip.person_id = ? AND i.is_group = 0`,
      [personId],
    );
    const actions = this.db.all<{ state: string; n: number }>(
      `SELECT a.state, COUNT(*) AS n FROM draft_actions a JOIN drafts d ON d.id = a.draft_id WHERE d.person_id = ? GROUP BY a.state`,
      [personId],
    );
    const actionCount = (s: string) => Number(actions.find((a) => a.state === s)?.n ?? 0);
    return {
      approvedDrafts: actionCount("approved"),
      sentByYou: Number(counts?.outbound ?? 0),
      repliesReceived: Number(counts?.inbound ?? 0),
      platformConnections: rel
        .filter((r) => r.type === "connection")
        .map((r) => ({ platform: r.platform, since: r.observed_at, source: r.verification_source })),
      follows: rel
        .filter((r) => r.type === "follows")
        .map((r) => ({ platform: r.platform, direction: r.from_person_id === selfId ? "you follow them" : "they follow you" })),
    };
  }

  /** Interests shared with the user, and how each was established. */
  private sharedInterests(personId: string) {
    const person = this.people.get(personId);
    const stated = parseJson<string[]>(person.interests, []);
    const projectKeywords = this.projects
      .list({ kind: "project" })
      .map((p) => ({ project: p, profile: this.projects.profile(p.id) }))
      .filter((x) => x.profile);
    const postIds = this.db.all<{ id: string }>("SELECT id FROM source_posts WHERE author_person_id = ?", [personId]).map((r) => r.id);
    const postText = this.db
      .all<{ text: string }>(`SELECT text FROM source_posts WHERE author_person_id = ? LIMIT 50`, [personId])
      .map((r) => r.text)
      .join("\n");
    const personStems = new Set([...tokenize(postText), ...stated.flatMap((s) => tokenize(s))].map(stem));
    const personVec = centroid(this.index.sourceVectors("source_post", postIds));
    return projectKeywords
      .map(({ project, profile }) => {
        const shared = profile!.keywords.filter((k) => {
          const ks = tokenize(k).map(stem);
          return ks.length > 0 && ks.every((s) => personStems.has(s));
        });
        const semantic = personVec && profile!.vector ? cosine(personVec, profile!.vector) : 0;
        return {
          projectId: project.id,
          projectName: project.name,
          sharedKeywords: shared,
          semanticSimilarity: Number(semantic.toFixed(3)),
          establishedBy: [
            postIds.length ? `${postIds.length} of their posts` : null,
            stated.length ? "interests recorded on their profile" : null,
            "your project summary keywords",
          ].filter(Boolean),
        };
      })
      .filter((s) => s.sharedKeywords.length > 0 || s.semanticSimilarity > 0.25)
      .sort((a, b) => b.sharedKeywords.length - a.sharedKeywords.length || b.semanticSimilarity - a.semanticSimilarity);
  }

  /**
   * Warm-introduction paths from the user to a person through verified relationships and
   * reciprocal interactions only (proposed outreach and shared interests are not traversable).
   */
  paths(targetId: string, opts: { k?: number; maxHops?: number } = {}) {
    const target = this.people.resolve(targetId);
    const graph = this.graph({ includeProposed: false, includeArchived: false });
    return this.pathsInGraph(graph, target.id, opts.k ?? 3, opts.maxHops ?? 4);
  }

  private pathsInGraph(graph: ReturnType<NetworkService["graph"]>, targetId: string, k: number, maxHops: number) {
    const nodeIds = graph.nodes.map((n) => n.id);
    // Only evidence that people know each other is traversable: ties come from relationship and
    // interaction edges, never from proposed outreach or shared interests.
    const adj = buildAdjacency(
      nodeIds,
      graph.ties.map((t) => ({ from: t.a, to: t.b, weight: t.strength, directed: t.directedOnly })),
    );
    const found = alternativePaths(adj, graph.selfId, targetId, k, maxHops);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    return found.map((p) => ({
      warmth: Number(p.warmth.toFixed(4)),
      hops: p.nodes.length - 1,
      people: p.nodes.map((id) => ({ id, name: byId.get(id)?.label ?? id })),
      steps: p.nodes.slice(1).map((to, i) => {
        const from = p.nodes[i]!;
        const supporting = graph.edges.filter(
          (e) => e.establishesRelationship && ((e.from === from && e.to === to) || (e.from === to && e.to === from)),
        );
        return {
          from,
          to,
          strength: Number((adj.get(from)?.get(to) ?? 0).toFixed(3)),
          because: supporting.map((e) => e.explanation),
        };
      }),
    }));
  }

  /**
   * "Find my network": ranked suggestions of who to engage, reconnect with, follow up with, or ask
   * for an introduction. Every suggestion carries the records that justify it.
   */
  recommendations(opts: { limit?: number; dormantDays?: number } = {}) {
    const limit = opts.limit ?? 10;
    const dormantDays = opts.dormantDays ?? 60;
    const now = new Date();
    const graph = this.graph({ includeProposed: true });
    const selfId = graph.selfId;
    const nodes = graph.nodes.filter((n) => !n.isSelf);

    // 1) Engage: best open opportunity per person, weighted slightly by existing tie (warm > cold).
    const engage = this.db
      .all<Record<string, unknown>>(
        `SELECT o.id, o.person_id, o.relevance, o.scenario, o.match_reason, o.suggested_action, o.project_id, pr.name AS project_name,
                p.display_name, sp.url
         FROM opportunities o JOIN projects pr ON pr.id = o.project_id JOIN people p ON p.id = o.person_id
         JOIN source_posts sp ON sp.id = o.source_post_id
         WHERE o.state IN ('new','shortlisted') ORDER BY o.relevance DESC LIMIT 200`,
      )
      .reduce((acc, o) => {
        const pid = String(o.person_id);
        if (!acc.has(pid)) acc.set(pid, o);
        return acc;
      }, new Map<string, Record<string, unknown>>());
    const engageList = [...engage.values()]
      .map((o) => {
        const tie = nodes.find((n) => n.id === o.person_id)?.tieStrength ?? 0;
        return {
          type: "engage" as const,
          personId: String(o.person_id),
          personName: String(o.display_name),
          score: Number((Number(o.relevance) * (1 + 0.3 * tie)).toFixed(4)),
          reason: String(o.match_reason),
          action: String(o.suggested_action),
          opportunityId: String(o.id),
          projectId: String(o.project_id),
          sourceUrl: o.url,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    // 2) Reconnect: meaningful but dormant ties whose past conversations overlap with a project that changed since.
    const contexts = this.projects
      .list({ kind: "project" })
      .map((p) => ({ p, ctx: this.projects.latestContext(p.id), profile: this.projects.profile(p.id) }))
      .filter((x) => x.ctx && x.profile);
    const reconnect = nodes
      .filter((n) => n.tieStrength >= 0.2 && n.lastInteractionAt && daysBetween(n.lastInteractionAt, now) >= dormantDays)
      .map((n) => {
        const convo = this.db
          .all<{ body: string | null; subject: string | null }>(
            `SELECT i.body, i.subject FROM interactions i JOIN interaction_participants ip ON ip.interaction_id = i.id
             WHERE ip.person_id = ? AND i.is_group = 0 ORDER BY i.occurred_at DESC LIMIT 30`,
            [n.id],
          )
          .map((r) => `${r.subject ?? ""} ${r.body ?? ""}`)
          .join("\n");
        const convoStems = new Set([...tokenize(convo), ...n.interests.flatMap((i) => tokenize(i))].map(stem));
        let best: { project: string; projectId: string; shared: string[]; updatedAt: string } | null = null;
        for (const { p, ctx, profile } of contexts) {
          if (String(ctx!.created_at) <= n.lastInteractionAt!) continue; // nothing new since you last talked
          const shared = profile!.keywords.filter((k) => tokenize(k).map(stem).every((s) => convoStems.has(s)));
          if (shared.length > (best?.shared.length ?? 0)) best = { project: p.name, projectId: p.id, shared, updatedAt: String(ctx!.created_at) };
        }
        if (!best) return null;
        const dormancy = clamp(daysBetween(n.lastInteractionAt!, now) / 365, 0.2, 1);
        return {
          type: "reconnect" as const,
          personId: n.id,
          personName: n.label,
          score: Number((n.tieStrength * (0.5 + 0.5 * Math.min(best.shared.length / 3, 1)) * dormancy).toFixed(4)),
          reason: `You last talked on ${n.lastInteractionAt!.slice(0, 10)} about ${best.shared.slice(0, 3).join(", ")}; ${best.project} has been updated since (${best.updatedAt.slice(0, 10)}).`,
          action: "personal_message",
          projectId: best.projectId,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    // 3) Follow-ups due within a week.
    const soon = new Date(now.getTime() + 7 * 86_400_000).toISOString();
    const followups = this.db
      .all<Record<string, unknown>>(
        `SELECT f.id, f.person_id, f.reason, f.due_at, p.display_name FROM followups f JOIN people p ON p.id = f.person_id
         WHERE f.state = 'open' AND (f.due_at IS NULL OR f.due_at <= ?) ORDER BY COALESCE(f.due_at, '9999') LIMIT ?`,
        [soon, limit],
      )
      .map((f) => ({
        type: "follow_up" as const,
        personId: String(f.person_id),
        personName: String(f.display_name),
        followupId: String(f.id),
        dueAt: f.due_at,
        overdue: Boolean(f.due_at && String(f.due_at) < now.toISOString()),
        reason: String(f.reason),
      }));

    // 4) Introductions: prospects you have an opportunity with, reachable through someone you know.
    const introductions = engageList
      .filter((e) => (nodes.find((n) => n.id === e.personId)?.tieStrength ?? 0) < 0.15)
      .map((e) => {
        const best = this.pathsInGraph(graph, e.personId, 1, 3)[0];
        if (!best || best.hops < 2) return null;
        const via = best.people[1]!;
        return {
          type: "introduction" as const,
          personId: e.personId,
          personName: e.personName,
          viaPersonId: via.id,
          viaPersonName: via.name,
          warmth: best.warmth,
          reason: `${via.name} is connected to ${e.personName}: ${best.steps[1]?.because.join(" ") ?? ""}`,
          opportunityId: e.opportunityId,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .slice(0, limit);

    // 5) Bridges: people who connect otherwise separate groups in your network.
    const bridges = nodes
      .filter((n) => n.bridgeScore > 0)
      .sort((a, b) => b.bridgeScore - a.bridgeScore)
      .slice(0, limit)
      .map((n) => ({
        type: "bridge" as const,
        personId: n.id,
        personName: n.label,
        bridgeScore: n.bridgeScore,
        reason: "Connects people in your network who are not otherwise connected (based on recorded relationships and interactions).",
      }));

    return { generatedAt: now.toISOString(), selfId, engage: engageList, reconnect, followups, introductions, bridges };
  }

  stats() {
    const g = this.graph({ includeProposed: true });
    const byStatus: Record<string, number> = {};
    for (const n of g.nodes) byStatus[n.status] = (byStatus[n.status] ?? 0) + 1;
    const byKind: Record<string, number> = {};
    for (const e of g.edges) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    return {
      people: g.nodes.length,
      byStatus,
      edges: byKind,
      communities: g.communities.length,
      averageTieStrength: Number(
        (g.nodes.filter((n) => !n.isSelf).reduce((a, n) => a + n.tieStrength, 0) / Math.max(g.nodes.length - 1, 1)).toFixed(3),
      ),
    };
  }
}
