import type { SourcePostInput } from "../services/opportunities.ts";

export interface ConnectorStatus {
  id: string;
  name: string;
  available: boolean;
  capabilities: Array<"search" | "publish" | "read_connections" | "read_messages">;
  /** Why the connector cannot be used, or what it is limited to. */
  note: string;
}

/**
 * Read-only discovery source. Connectors only search authorized, documented APIs; they never
 * scrape, and none of them can send or publish (outward actions are recorded by the user).
 */
export interface DiscoveryConnector {
  readonly id: string;
  status(): ConnectorStatus;
  search(query: string, opts: { limit: number; sinceDays: number }): Promise<SourcePostInput[]>;
}

export class ConnectorUnavailableError extends Error {
  readonly code = "connector_unavailable";
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
