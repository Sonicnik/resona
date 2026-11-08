import type { Config } from "./config.ts";
import { Db } from "./db/database.ts";
import { HashingEmbedder } from "./search/embeddings.ts";
import { ContentIndex } from "./search/index.ts";
import { AiService } from "./ai/client.ts";
import { ProjectSummarizer } from "./ai/summarize.ts";
import { PeopleService } from "./services/people.ts";
import { ProjectService } from "./services/projects.ts";
import { RelationshipService } from "./services/relationships.ts";
import { OpportunityService } from "./services/opportunities.ts";
import { DraftService } from "./services/drafts.ts";
import { ImportService } from "./services/imports.ts";
import { DiscoveryService } from "./services/discovery.ts";
import { ReviewService } from "./services/review.ts";
import { NetworkService } from "./network/network.ts";
import { VaultService } from "./vault/vault.ts";
import { ConnectorRegistry, GitHubConnector, HackerNewsConnector, LinkedInConnector, XConnector } from "./connectors/connectors.ts";
import { scanProject, type ScanResult } from "./ingestion/scanner.ts";
import { FolderWatcher } from "./ingestion/watcher.ts";
import { Scheduler } from "./scheduler/scheduler.ts";
import { KeychainStore, macChooser, type Chooser, type SecretStore } from "./system/mac.ts";
import { ChatGptAuth } from "./ai/chatgpt.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface Services {
  config: Config;
  db: Db;
  index: ContentIndex;
  ai: AiService;
  summarizer: ProjectSummarizer;
  people: PeopleService;
  projects: ProjectService;
  relationships: RelationshipService;
  opportunities: OpportunityService;
  drafts: DraftService;
  imports: ImportService;
  discovery: DiscoveryService;
  review: ReviewService;
  network: NetworkService;
  vault: VaultService;
  connectors: ConnectorRegistry;
  scheduler: Scheduler;
  secrets: SecretStore;
  chooser: Chooser;
  chatgpt: ChatGptAuth;
  watcher: FolderWatcher;
  pipeline: Pipeline;
  close(): void;
}

export interface PipelineResult {
  scan: ScanResult;
  summary?: Awaited<ReturnType<ProjectSummarizer["summarize"]>>;
  rematched?: number;
  error?: string;
}

/**
 * Ingestion pipeline for one folder: incremental scan → (re)summarize when content changed →
 * re-score stored conversations against the new context. Runs are serialized per project.
 */
export class Pipeline {
  private readonly inFlight = new Map<string, Promise<PipelineResult>>();

  constructor(private readonly s: Omit<Services, "pipeline" | "close">) {}

  processProject(projectId: string, trigger: string, opts: { forceSummary?: boolean } = {}): Promise<PipelineResult> {
    const existing = this.inFlight.get(projectId);
    if (existing) return existing;
    const p = this.run(projectId, trigger, opts).finally(() => this.inFlight.delete(projectId));
    this.inFlight.set(projectId, p);
    return p;
  }

  private async run(projectId: string, trigger: string, opts: { forceSummary?: boolean }): Promise<PipelineResult> {
    const project = this.s.projects.get(projectId);
    const scan = scanProject(this.s.db, this.s.index, projectId, trigger);
    if (scan.status === "error") return { scan, error: scan.error };
    const after = this.s.projects.get(projectId);
    const needsSummary =
      opts.forceSummary ||
      !after.last_summarized_at ||
      Boolean(after.last_change_at && after.last_change_at > after.last_summarized_at);
    if (project.status !== "active" || !needsSummary) return { scan };
    const summary = await this.s.summarizer.summarize(projectId, { force: opts.forceSummary });
    const rematched = summary.status === "created" && after.kind === "project" ? this.s.opportunities.rematchAll({ projectIds: [projectId] }) : 0;
    return { scan, summary, rematched };
  }
}

export function createServices(config: Config, opts: { db?: Db; ai?: AiService; log?: (m: string) => void; secrets?: SecretStore; chooser?: Chooser; chatgpt?: ChatGptAuth } = {}): Services {
  const log = opts.log ?? ((m: string) => console.log(`[resona] ${m}`));
  const db = opts.db ?? new Db(config.dbPath);
  const index = new ContentIndex(db, new HashingEmbedder(512, config.embeddingModel));
  const ai = opts.ai ?? new AiService(db, config);
  const people = new PeopleService(db);
  people.ensureSelf();
  const projects = new ProjectService(db, index);
  const relationships = new RelationshipService(db, people);
  const summarizer = new ProjectSummarizer(db, ai, index);
  const opportunities = new OpportunityService(db, index, projects, people, ai);
  const drafts = new DraftService(db, ai, projects, people, relationships, opportunities);
  const imports = new ImportService(db, people, relationships);
  const network = new NetworkService(db, people, projects, index);
  const review = new ReviewService(db, network, relationships, people);
  const vault = new VaultService(db, people, config.vaultDir);
  const connectors = new ConnectorRegistry();
  connectors.register(new LinkedInConnector());
  connectors.register(new GitHubConnector(() => process.env.GITHUB_TOKEN || config.connectors.githubToken));
  connectors.register(new HackerNewsConnector());
  connectors.register(new XConnector(() => process.env.X_BEARER_TOKEN || config.connectors.xBearerToken));
  const discovery = new DiscoveryService(db, connectors, projects, opportunities);
  const scheduler = new Scheduler(db, MINUTE, log);

  const secrets = opts.secrets ?? new KeychainStore();
  const chooser = opts.chooser ?? macChooser;
  const chatgpt = opts.chatgpt ?? new ChatGptAuth(db, secrets, { log });
  ai.chatgpt = chatgpt;
  const base = { config, db, index, ai, summarizer, people, projects, relationships, opportunities, drafts, imports, discovery, review, network, vault, connectors, scheduler, secrets, chooser, chatgpt };
  const watcher = new FolderWatcher((projectId) => {
    if (db.getSetting<boolean>("agent.paused", false)) return; // the next rescan after resuming catches up
    void pipeline.processProject(projectId, "watch").catch((err) => log(`watch processing failed: ${err}`));
  });
  const pipeline = new Pipeline({ ...base, watcher });

  const setting = (key: string, fallback: boolean) => () => db.getSetting<boolean>(key, fallback);
  const activeProjects = () => projects.list().filter((p) => p.status === "active");

  scheduler.register({
    name: "rescan-folders",
    intervalMs: 30 * MINUTE,
    run: async () => {
      const results = [];
      for (const p of activeProjects()) results.push(await pipeline.processProject(p.id, "scheduled"));
      return results.length;
    },
  });
  scheduler.register({
    // Catch-up for summaries that could not run earlier (no network, no credentials, permission granted later).
    name: "summarize-pending",
    intervalMs: 30 * MINUTE,
    run: async () => {
      let n = 0;
      for (const p of activeProjects()) {
        const needs = !p.last_summarized_at || (p.last_change_at && p.last_change_at > p.last_summarized_at);
        const upgrade = ai.canUseFor([p.id]) && projects.latestContext(p.id)?.method === "extractive";
        if (needs || upgrade) {
          await summarizer.summarize(p.id);
          n++;
        }
      }
      return n;
    },
  });
  scheduler.register({
    // Off by default: discovery sends project keywords to third-party search APIs.
    name: "discovery",
    intervalMs: DAY,
    enabled: setting("schedule.discovery.enabled", false),
    run: () => discovery.run(),
  });
  scheduler.register({ name: "suggest-followups", intervalMs: 6 * HOUR, run: () => review.suggestFollowups() });
  scheduler.register({
    // Runs in the background once a week. It waits until there is at least one project, so a fresh install
    // doesn't record an empty first review; the review's vault note is written right away.
    name: "weekly-review",
    intervalMs: 7 * DAY,
    enabled: () => setting("schedule.weeklyReview.enabled", true)() && projects.list().length > 0,
    run: () => {
      const r = review.generate();
      if (db.getSetting<boolean>("schedule.vaultSync.enabled", true)) vault.sync();
      return r.id;
    },
  });
  scheduler.register({ name: "vault-sync", intervalMs: 10 * MINUTE, enabled: setting("schedule.vaultSync.enabled", true), run: () => vault.sync() });

  if (config.watchEnabled) for (const p of activeProjects()) watcher.watch(p.id, p.folder_path);

  return {
    ...base,
    watcher,
    pipeline,
    close() {
      chatgpt.cancelSignIn();
      scheduler.stop();
      watcher.closeAll();
      db.close();
    },
  };
}
