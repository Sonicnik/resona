/**
 * Generic weighted-graph algorithms used by the people network. All functions are pure and
 * deterministic (sorted iteration, no randomness) so results are stable across runs.
 */

export interface WEdge {
  from: string;
  to: string;
  weight: number; // tie strength in (0, 1]
  directed: boolean;
}

export type Adjacency = Map<string, Map<string, number>>;

/** Undirected weighted adjacency (directed edges contribute to both ends, at half weight in reverse). */
export function buildAdjacency(nodes: string[], edges: WEdge[], opts: { exclude?: Set<string> } = {}): Adjacency {
  const adj: Adjacency = new Map();
  for (const n of nodes) if (!opts.exclude?.has(n)) adj.set(n, new Map());
  const add = (a: string, b: string, w: number) => {
    const row = adj.get(a);
    if (!row || !adj.has(b) || a === b) return;
    row.set(b, Math.max(row.get(b) ?? 0, w));
  };
  for (const e of edges) {
    add(e.from, e.to, e.weight);
    add(e.to, e.from, e.directed ? e.weight * 0.5 : e.weight);
  }
  return adj;
}

/** Weighted PageRank with uniform teleport and dangling-mass redistribution. */
export function pageRank(adj: Adjacency, damping = 0.85, iterations = 60, tol = 1e-9): Map<string, number> {
  const nodes = [...adj.keys()].sort();
  const n = nodes.length;
  const rank = new Map<string, number>(nodes.map((id) => [id, 1 / Math.max(n, 1)]));
  if (n === 0) return rank;
  const outWeight = new Map(nodes.map((id) => [id, [...adj.get(id)!.values()].reduce((a, b) => a + b, 0)]));
  for (let it = 0; it < iterations; it++) {
    const next = new Map<string, number>(nodes.map((id) => [id, (1 - damping) / n]));
    let dangling = 0;
    for (const id of nodes) {
      const r = rank.get(id)!;
      const total = outWeight.get(id)!;
      if (total === 0) {
        dangling += r;
        continue;
      }
      for (const [to, w] of adj.get(id)!) next.set(to, next.get(to)! + damping * r * (w / total));
    }
    for (const id of nodes) next.set(id, next.get(id)! + (damping * dangling) / n);
    let delta = 0;
    for (const id of nodes) delta += Math.abs(next.get(id)! - rank.get(id)!);
    for (const id of nodes) rank.set(id, next.get(id)!);
    if (delta < tol) break;
  }
  return rank;
}

/**
 * Weighted label propagation for community detection. Nodes adopt the label with the highest
 * summed edge weight among neighbours; ties break on the smallest label for determinism.
 * Isolated nodes keep their own singleton label (reported as `null` by callers).
 */
export function labelPropagation(adj: Adjacency, maxIterations = 30): Map<string, string> {
  const nodes = [...adj.keys()].sort();
  const label = new Map(nodes.map((n) => [n, n]));
  for (let it = 0; it < maxIterations; it++) {
    let changed = false;
    // Alternate the sweep direction to avoid oscillation on bipartite-like structures.
    const order = it % 2 === 0 ? nodes : [...nodes].reverse();
    for (const node of order) {
      const neighbours = adj.get(node)!;
      if (neighbours.size === 0) continue;
      const scores = new Map<string, number>();
      for (const [nb, w] of neighbours) {
        const l = label.get(nb)!;
        scores.set(l, (scores.get(l) ?? 0) + w);
      }
      let best = label.get(node)!;
      let bestScore = scores.get(best) ?? -1;
      for (const [l, s] of [...scores.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        if (s > bestScore + 1e-12) {
          best = l;
          bestScore = s;
        }
      }
      if (best !== label.get(node)) {
        label.set(node, best);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return label;
}

/** Brandes betweenness centrality on the weighted graph (distance = -ln(strength)). Normalized to 0..1. */
export function betweenness(adj: Adjacency): Map<string, number> {
  const nodes = [...adj.keys()].sort();
  const cb = new Map(nodes.map((n) => [n, 0]));
  for (const s of nodes) {
    const stack: string[] = [];
    const pred = new Map<string, string[]>(nodes.map((n) => [n, []]));
    const sigma = new Map(nodes.map((n) => [n, 0]));
    const dist = new Map(nodes.map((n) => [n, Infinity]));
    sigma.set(s, 1);
    dist.set(s, 0);
    const queue = new MinHeap<string>();
    queue.push(s, 0);
    const done = new Set<string>();
    while (queue.size) {
      const [v, d] = queue.pop()!;
      if (done.has(v) || d > dist.get(v)!) continue;
      done.add(v);
      stack.push(v);
      for (const [w, strength] of adj.get(v)!) {
        const nd = d + edgeCost(strength);
        if (nd < dist.get(w)! - 1e-12) {
          dist.set(w, nd);
          sigma.set(w, sigma.get(v)!);
          pred.set(w, [v]);
          queue.push(w, nd);
        } else if (Math.abs(nd - dist.get(w)!) <= 1e-12) {
          sigma.set(w, sigma.get(w)! + sigma.get(v)!);
          pred.get(w)!.push(v);
        }
      }
    }
    const delta = new Map(nodes.map((n) => [n, 0]));
    while (stack.length) {
      const w = stack.pop()!;
      for (const v of pred.get(w)!) {
        delta.set(v, delta.get(v)! + (sigma.get(v)! / sigma.get(w)!) * (1 + delta.get(w)!));
      }
      if (w !== s) cb.set(w, cb.get(w)! + delta.get(w)!);
    }
  }
  const n = nodes.length;
  const norm = n > 2 ? (n - 1) * (n - 2) : 1;
  for (const k of nodes) cb.set(k, cb.get(k)! / norm);
  return cb;
}

/** Strong ties are cheap to traverse: cost = -ln(strength), so the best path maximizes the product of strengths. */
export function edgeCost(strength: number): number {
  return -Math.log(Math.max(Math.min(strength, 1), 0.02));
}

export interface PathResult {
  nodes: string[];
  cost: number;
  /** Product of edge strengths along the path, 0..1: a rough "how warm is this route". */
  warmth: number;
}

/** Dijkstra shortest path; `blocked` nodes are not traversed (used for alternative paths). */
export function shortestPath(adj: Adjacency, source: string, target: string, blocked: Set<string> = new Set()): PathResult | null {
  if (!adj.has(source) || !adj.has(target)) return null;
  const dist = new Map<string, number>([[source, 0]]);
  const prev = new Map<string, string>();
  const heap = new MinHeap<string>();
  heap.push(source, 0);
  const done = new Set<string>();
  while (heap.size) {
    const [v, d] = heap.pop()!;
    if (done.has(v)) continue;
    done.add(v);
    if (v === target) break;
    for (const [w, strength] of adj.get(v)!) {
      if (blocked.has(w) && w !== target) continue;
      const nd = d + edgeCost(strength);
      if (nd < (dist.get(w) ?? Infinity)) {
        dist.set(w, nd);
        prev.set(w, v);
        heap.push(w, nd);
      }
    }
  }
  if (!dist.has(target)) return null;
  const path = [target];
  while (path[0] !== source) path.unshift(prev.get(path[0]!)!);
  const cost = dist.get(target)!;
  return { nodes: path, cost, warmth: Math.exp(-cost) };
}

/** Up to k loop-free alternatives: best path, then paths that avoid each intermediary of the best path in turn. */
export function alternativePaths(adj: Adjacency, source: string, target: string, k = 3, maxHops = 4): PathResult[] {
  const best = shortestPath(adj, source, target);
  if (!best) return [];
  const results: PathResult[] = [best];
  const seen = new Set([best.nodes.join(">")]);
  for (const mid of best.nodes.slice(1, -1)) {
    const alt = shortestPath(adj, source, target, new Set([mid]));
    if (alt && !seen.has(alt.nodes.join(">"))) {
      seen.add(alt.nodes.join(">"));
      results.push(alt);
    }
    if (results.length >= k) break;
  }
  return results.filter((p) => p.nodes.length - 1 <= maxHops).sort((a, b) => a.cost - b.cost);
}

/** Exponential recency decay with a configurable half-life. */
export function decay(ageDays: number, halfLifeDays: number): number {
  return Math.exp((-Math.LN2 * Math.max(ageDays, 0)) / halfLifeDays);
}

export class MinHeap<T> {
  private items: Array<[T, number]> = [];
  get size(): number {
    return this.items.length;
  }
  push(item: T, priority: number): void {
    const a = this.items;
    a.push([item, priority]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p]![1] <= a[i]![1]) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      i = p;
    }
  }
  pop(): [T, number] | undefined {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l]![1] < a[m]![1]) m = l;
        if (r < a.length && a[r]![1] < a[m]![1]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top;
  }
}
