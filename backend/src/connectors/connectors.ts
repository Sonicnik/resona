import { decodeEntities } from "../matching/situation.ts";
import type { SourcePostInput } from "../services/opportunities.ts";
import { ConnectorUnavailableError, type ConnectorStatus, type DiscoveryConnector, type FetchLike } from "./types.ts";

const UA = "Resona/0.1 (local-first networking assistant)";

/** GitHub issues and pull requests via the official search API. Works unauthenticated at low rate limits. */
export class GitHubConnector implements DiscoveryConnector {
  readonly id = "github";
  constructor(
    // Read on every use so a token saved in-app applies without a restart.
    private readonly getToken: () => string | undefined,
    private readonly fetchFn: FetchLike = fetch as unknown as FetchLike,
  ) {}
  private get token() {
    return this.getToken();
  }

  status(): ConnectorStatus {
    return {
      id: this.id,
      name: "GitHub issues & discussions",
      available: true,
      capabilities: ["search"],
      note: this.token ? "Authenticated search (higher rate limit)." : "Unauthenticated search (10 requests/minute). Set GITHUB_TOKEN for more.",
    };
  }

  async search(query: string, opts: { limit: number; sinceDays: number }): Promise<SourcePostInput[]> {
    const since = new Date(Date.now() - opts.sinceDays * 86_400_000).toISOString().slice(0, 10);
    const q = `${query} is:open updated:>=${since}`;
    const url = `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&sort=updated&per_page=${Math.min(opts.limit, 50)}`;
    const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": UA };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const res = await this.fetchFn(url, { headers });
    if (!res.ok) throw new Error(`GitHub search failed (${res.status})`);
    const body = (await res.json()) as {
      items?: Array<{
        id: number;
        html_url: string;
        title: string;
        body: string | null;
        created_at: string;
        comments: number;
        reactions?: { total_count?: number };
        user?: { id: number; login: string; html_url: string };
      }>;
    };
    return (body.items ?? []).map((it) => ({
      platform: "github",
      externalId: String(it.id),
      url: it.html_url,
      title: it.title,
      text: `${it.title}\n\n${(it.body ?? "").slice(0, 8000)}`,
      publishedAt: it.created_at,
      connector: this.id,
      query,
      engagement: { comments: it.comments, reactions: it.reactions?.total_count ?? 0 },
      author: it.user
        ? { platform: "github", externalId: String(it.user.id), handle: it.user.login, url: it.user.html_url, displayName: it.user.login }
        : undefined,
    }));
  }
}

/** Hacker News stories and comments via the Algolia HN Search API (the official Firebase API has no search). */
export class HackerNewsConnector implements DiscoveryConnector {
  readonly id = "hackernews";
  constructor(private readonly fetchFn: FetchLike = fetch as unknown as FetchLike) {}

  status(): ConnectorStatus {
    return { id: this.id, name: "Hacker News", available: true, capabilities: ["search"], note: "Public stories and comments." };
  }

  async search(query: string, opts: { limit: number; sinceDays: number }): Promise<SourcePostInput[]> {
    const since = Math.floor((Date.now() - opts.sinceDays * 86_400_000) / 1000);
    const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(query)}&tags=(story,comment)&numericFilters=created_at_i>${since}&hitsPerPage=${Math.min(opts.limit, 50)}`;
    const res = await this.fetchFn(url, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`Hacker News search failed (${res.status})`);
    const body = (await res.json()) as {
      hits?: Array<{ objectID: string; title?: string | null; story_title?: string | null; story_text?: string | null; comment_text?: string | null; author: string; created_at: string; points?: number | null; num_comments?: number | null }>;
    };
    return (body.hits ?? [])
      .map((h) => {
        const raw = h.comment_text ?? h.story_text ?? "";
        const text = decodeEntities(raw.replace(/<p>/gi, "\n\n").replace(/<[^>]+>/g, " ")).replace(/[ \t]+/g, " ").trim();
        return {
          platform: "hackernews",
          externalId: h.objectID,
          url: `https://news.ycombinator.com/item?id=${h.objectID}`,
          // A comment links to itself; its title names the thread it replies to.
          title: h.comment_text ? (h.story_title ? `Re: ${h.story_title}` : null) : (h.title ?? null),
          text: [h.title, text].filter(Boolean).join("\n\n"),
          publishedAt: h.created_at,
          connector: this.id,
          query,
          engagement: { points: h.points ?? 0, comments: h.num_comments ?? 0 },
          author: { platform: "hackernews", externalId: h.author, handle: h.author, url: `https://news.ycombinator.com/user?id=${h.author}`, displayName: h.author },
        } satisfies SourcePostInput;
      })
      .filter((p) => p.text.length > 20);
  }
}

/** X recent search (official v2 API, requires a developer bearer token). Read-only. */
export class XConnector implements DiscoveryConnector {
  readonly id = "x";
  constructor(
    private readonly getBearer: () => string | undefined,
    private readonly fetchFn: FetchLike = fetch as unknown as FetchLike,
  ) {}
  private get bearer() {
    return this.getBearer();
  }

  status(): ConnectorStatus {
    return {
      id: this.id,
      name: "X (recent search)",
      available: Boolean(this.bearer),
      capabilities: ["search"],
      note: this.bearer
        ? "Official recent-search API; subject to your plan's limits and X automation rules. No posting."
        : "Set X_BEARER_TOKEN from an X developer app to enable. Platform costs and limits apply.",
    };
  }

  async search(query: string, opts: { limit: number; sinceDays: number }): Promise<SourcePostInput[]> {
    if (!this.bearer) throw new ConnectorUnavailableError("X connector needs X_BEARER_TOKEN");
    const params = new URLSearchParams({
      query: `${query} -is:retweet lang:en`,
      max_results: String(Math.max(10, Math.min(opts.limit, 100))),
      "tweet.fields": "created_at,public_metrics,author_id",
      expansions: "author_id",
      "user.fields": "name,username,description",
    });
    const res = await this.fetchFn(`https://api.x.com/2/tweets/search/recent?${params}`, {
      headers: { Authorization: `Bearer ${this.bearer}`, "User-Agent": UA },
    });
    if (!res.ok) throw new Error(`X search failed (${res.status})`);
    const body = (await res.json()) as {
      data?: Array<{ id: string; text: string; created_at?: string; author_id?: string; public_metrics?: Record<string, number> }>;
      includes?: { users?: Array<{ id: string; name: string; username: string; description?: string }> };
    };
    const users = new Map((body.includes?.users ?? []).map((u) => [u.id, u]));
    return (body.data ?? []).map((t) => {
      const u = t.author_id ? users.get(t.author_id) : undefined;
      return {
        platform: "x",
        externalId: t.id,
        url: u ? `https://x.com/${u.username}/status/${t.id}` : null,
        text: t.text,
        publishedAt: t.created_at ?? null,
        connector: this.id,
        query,
        engagement: t.public_metrics ?? {},
        author: u ? { platform: "x", externalId: u.id, handle: u.username, url: `https://x.com/${u.username}`, displayName: u.name, headline: u.description } : undefined,
      };
    });
  }
}

/**
 * LinkedIn: present so the priority is visible, but disabled. Ordinary self-service permissions do not
 * provide public-post search, connections or inbox; restricted APIs require partner approval.
 * Archive import (POST /api/imports/linkedin-archive) is the accepted fallback. No scraping.
 */
export class LinkedInConnector implements DiscoveryConnector {
  readonly id = "linkedin";
  status(): ConnectorStatus {
    return {
      id: this.id,
      name: "LinkedIn",
      available: false,
      capabilities: [],
      note:
        "Authorized LinkedIn discovery access is not established (no public-post search API for self-service apps). Use the LinkedIn data archive import, and add LinkedIn posts manually via POST /api/source-posts.",
    };
  }
  async search(): Promise<SourcePostInput[]> {
    throw new ConnectorUnavailableError(this.status().note);
  }
}

export class ConnectorRegistry {
  private readonly connectors = new Map<string, DiscoveryConnector>();

  register(c: DiscoveryConnector): void {
    this.connectors.set(c.id, c);
  }

  get(id: string): DiscoveryConnector | undefined {
    return this.connectors.get(id);
  }

  list(): ConnectorStatus[] {
    return [...this.connectors.values()].map((c) => c.status());
  }

  available(): DiscoveryConnector[] {
    return [...this.connectors.values()].filter((c) => c.status().available);
  }
}
