import { stem, tokenize } from "../lib/text.ts";

/**
 * Embedding provider interface. The product reference leaves the embedding model open, so the
 * backend ships a fully local, deterministic default and keeps the model id next to every stored
 * vector so a better model (e.g. a local sentence-transformer) can be swapped in and re-indexed.
 */
export interface Embedder {
  readonly model: string;
  readonly dims: number;
  embed(text: string): Float32Array;
}

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Feature-hashing embedder: stemmed unigrams + bigrams + character trigrams hashed into a fixed
 * vector with signed buckets and sublinear TF, then L2-normalized. Not as strong as a neural model,
 * but it captures word-form variation ("agentic"/"agents") and runs offline with no data leaving the Mac.
 */
export class HashingEmbedder implements Embedder {
  constructor(
    readonly dims = 512,
    readonly model = `resona-hash-v1-${dims}`,
  ) {}

  embed(text: string): Float32Array {
    const v = new Float32Array(this.dims);
    const tokens = tokenize(text).map(stem);
    const counts = new Map<string, number>();
    const add = (feature: string, weight: number) => counts.set(feature, (counts.get(feature) ?? 0) + weight);
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      add(`u:${t}`, 1);
      if (i + 1 < tokens.length) add(`b:${t}_${tokens[i + 1]}`, 0.7);
      if (t.length >= 5) {
        const padded = `^${t}$`;
        for (let j = 0; j + 3 <= padded.length; j++) add(`c:${padded.slice(j, j + 3)}`, 0.15);
      }
    }
    for (const [feature, count] of counts) {
      const h = fnv1a(feature);
      const idx = h % this.dims;
      const sign = (h >>> 31) & 1 ? -1 : 1;
      v[idx]! += sign * (1 + Math.log(count));
    }
    return normalize(v);
  }
}

export function normalize(v: Float32Array): Float32Array {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < v.length; i++) v[i]! /= norm;
  return v;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot; // inputs are normalized
}

export function centroid(vectors: Float32Array[]): Float32Array | null {
  if (vectors.length === 0) return null;
  const out = new Float32Array(vectors[0]!.length);
  for (const v of vectors) for (let i = 0; i < v.length; i++) out[i]! += v[i]!;
  return normalize(out);
}

export function toBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
}

export function fromBlob(blob: Uint8Array): Float32Array {
  const copy = new Uint8Array(blob); // ensure 4-byte alignment
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}
