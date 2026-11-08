import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { z } from "zod";
import { loadConfig, type Config } from "../src/config.ts";
import { createServices, type Services } from "../src/container.ts";
import { Db } from "../src/db/database.ts";
import { AiService, type ModelCall, type StructuredRequest } from "../src/ai/client.ts";
import { MemoryStore } from "../src/system/mac.ts";

export function tmpDir(prefix = "resona-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

/** AiService whose provider call is replaced by a function; permission checks and history stay real. */
export class StubAi extends AiService {
  calls: Array<StructuredRequest<z.ZodType>> = [];
  constructor(
    db: Db,
    config: Config,
    private readonly respond: (req: StructuredRequest<z.ZodType>) => unknown,
  ) {
    super(db, config);
  }
  override isAvailable(): boolean {
    return true;
  }
  protected override async callModel<S extends z.ZodType>(req: StructuredRequest<S>): Promise<ModelCall> {
    this.calls.push(req as unknown as StructuredRequest<z.ZodType>);
    return { output: this.respond(req as unknown as StructuredRequest<z.ZodType>), model: "stub-model", inputTokens: 10, outputTokens: 5 };
  }
}

export function makeServices(opts: { ai?: (db: Db, config: Config) => AiService } = {}): Services & { dir: string } {
  const dir = tmpDir();
  const config = loadConfig({ RESONA_DATA_DIR: path.join(dir, "data"), RESONA_WATCH: "0", RESONA_SCHEDULER: "0" } as NodeJS.ProcessEnv);
  const db = new Db(config.dbPath);
  const ai = opts.ai ? opts.ai(db, config) : new OfflineAi(db, config);
  // Tests never touch the real Keychain or open Finder dialogs.
  const services = createServices(config, { db, ai, log: () => {}, secrets: new MemoryStore(), chooser: async () => null });
  return Object.assign(services, { dir });
}

/** Never has credentials, regardless of the test runner's environment. */
export class OfflineAi extends AiService {
  override isAvailable(): boolean {
    return false;
  }
}

export const SAMPLE_PROJECT: Record<string, string> = {
  "README.md": `# rag-eval

A lightweight evaluation harness for retrieval-augmented generation (RAG) pipelines. It measures retrieval recall and answer faithfulness on your own documents.

Teams building RAG chatbots often evaluate manually in spreadsheets, which is slow and inconsistent.

## Features

- Synthetic question generation from document chunks
- Retrieval recall@k and MRR metrics

## Results

- Recall@5 improved from 0.61 to 0.78 after switching to hybrid search

## Limitations

- English only
- No support for multimodal documents or images
`,
  "src/metrics.py": "def recall_at_k(retrieved, relevant, k):\n    return len(set(retrieved[:k]) & set(relevant)) / len(relevant)\n",
  "docs/notes.md": "Hybrid search (BM25 plus vector search) gives better retrieval recall for RAG evaluation.\n",
};

export const MATCHING_POST =
  "We're building a RAG chatbot and evaluating retrieval recall manually in spreadsheets is tedious. Is there a tool for this? Any recommendations?";
