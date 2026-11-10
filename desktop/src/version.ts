/** True when `candidate` (a release tag such as "v0.2.0") is a higher x.y.z than `current`. Suffixes like "-beta" are ignored. */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split("-")[0].split(".").map(Number);
  const a = parse(candidate);
  const b = parse(current);
  if (a.length !== 3 || a.some(Number.isNaN)) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > (b[i] ?? 0);
  return false;
}
