import type { Db } from "../db/database.ts";
import type { ConnectorRegistry } from "../connectors/connectors.ts";
import type { OpportunityService } from "./opportunities.ts";
import type { ProjectService } from "./projects.ts";
import { nowIso, uniq } from "../lib/util.ts";

export interface DiscoveryReport {
  startedAt: string;
  finishedAt: string;
  queries: Array<{ projectId: string; connector: string; query: string; results: number; error?: string }>;
  postsStored: number;
  newPosts: number;
  opportunities: number;
  skippedConnectors: Array<{ id: string; reason: string }>;
}

/** Builds search queries from a project context: explicit phrases first, then keyword pairs. */
export function queriesForContext(keywords: string[], phrases: string[], max = 4): string[] {
  const pairs: string[] = [];
  const top = keywords.slice(0, 5);
  for (let i = 0; i < top.length; i++) for (let j = i + 1; j < top.length; j++) pairs.push(`${top[i]} ${top[j]}`);
  return uniq([...phrases.filter((p) => p.split(/\s+/).length <= 6), ...pairs]).slice(0, max);
}

/**
 * Step 2 of the workflow. Generates queries from project context, searches authorized sources,
 * stores posts with authors, and scores them against projects. Coverage depends on the sources
 * the user has authorized, not on the model.
 */
export class DiscoveryService {
  constructor(
    private readonly db: Db,
    private readonly connectors: ConnectorRegistry,
    private readonly projects: ProjectService,
    private readonly opportunities: OpportunityService,
  ) {}

  async run(opts: { projectIds?: string[]; connectorIds?: string[]; queriesPerProject?: number; limitPerQuery?: number; sinceDays?: number } = {}): Promise<DiscoveryReport> {
    const report: DiscoveryReport = {
      startedAt: nowIso(),
      finishedAt: "",
      queries: [],
      postsStored: 0,
      newPosts: 0,
      opportunities: 0,
      skippedConnectors: [],
    };
    const projectIds = opts.projectIds ?? this.projects.list({ kind: "project" }).filter((p) => p.status === "active").map((p) => p.id);
    const wanted = opts.connectorIds ?? this.connectors.available().map((c) => c.status().id);
    const connectors = wanted
      .map((id) => this.connectors.get(id))
      .filter((c): c is NonNullable<typeof c> => {
        return Boolean(c);
      })
      .filter((c) => {
        const s = c.status();
        if (!s.available) report.skippedConnectors.push({ id: s.id, reason: s.note });
        return s.available;
      });

    const touched = new Set<string>();
    for (const projectId of projectIds) {
      const profile = this.projects.profile(projectId);
      if (!profile) continue;
      const queries = queriesForContext(profile.keywords, profile.phrases, opts.queriesPerProject ?? 3);
      for (const connector of connectors) {
        for (const query of queries) {
          try {
            const posts = await connector.search(query, { limit: opts.limitPerQuery ?? 15, sinceDays: opts.sinceDays ?? 30 });
            for (const p of posts) {
              const res = this.opportunities.ingestPost(p);
              touched.add(res.postId);
              report.postsStored++;
              if (res.created) report.newPosts++;
            }
            report.queries.push({ projectId, connector: connector.id, query, results: posts.length });
          } catch (err) {
            report.queries.push({ projectId, connector: connector.id, query, results: 0, error: err instanceof Error ? err.message : String(err) });
          }
        }
      }
    }
    for (const postId of touched) report.opportunities += this.opportunities.matchPost(postId).length;
    report.finishedAt = nowIso();
    this.db.setSetting("discovery.lastReport", report);
    return report;
  }
}
