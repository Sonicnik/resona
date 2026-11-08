import { useEffect, useRef } from "react";
import * as THREE from "three";
import ForceGraph3D from "3d-force-graph";
import SpriteText from "three-spritetext";

export type NodeStatus = "you" | "connected" | "interacted" | "prospect";
const COLOR: Record<NodeStatus, string> = { you: "#ffffff", connected: "#5ee7f5", interacted: "#b4a2ff", prospect: "#8a86a3" };
const RADIUS: Record<NodeStatus, number> = { you: 3.2, connected: 2.2, interacted: 1.8, prospect: 1.3 };
const HALO: Record<NodeStatus, number> = { you: 0.9, connected: 0.75, interacted: 0.6, prospect: 0.35 };
const LINK_COLOR: Record<string, string> = { proposed: "#3d3858", interaction: "#7262c4", confirmed: "#2fb4cc" };
const LINK_KIND: Record<string, string> = { relationship: "confirmed", interaction: "interaction", proposed: "proposed" };
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Colour a person by the strongest *recorded* tie to you; shared interests never count as a tie. */
export function nodeStatus(node: any, edges: any[]): NodeStatus {
  if (node.isSelf) return "you";
  const mine = edges.filter((e) => e.from === node.id || e.to === node.id);
  if (mine.some((e) => e.kind === "relationship")) return "connected";
  if (mine.some((e) => e.kind === "interaction") || node.interactionCount > 0) return "interacted";
  return "prospect";
}
console.assert(nodeStatus({ id: "a", interactionCount: 0 }, [{ kind: "proposed", from: "me", to: "a" }]) === "prospect", "proposed edge is not a relationship");

/** Connection levels by tie strength (0–1, from the backend); people with no tie at all get no level. */
export const LEVELS = [
  { level: 5, name: "Inner circle", min: 0.65 },
  { level: 4, name: "Close", min: 0.45 },
  { level: 3, name: "Familiar", min: 0.3 },
  { level: 2, name: "Acquainted", min: 0.2 },
  { level: 1, name: "Light", min: 0 },
];
export function levelOf(tie: number | undefined): number {
  if (!tie || tie <= 0) return 0;
  return LEVELS.find((l) => tie >= l.min)!.level;
}
console.assert(levelOf(0) === 0 && levelOf(0.121) === 1 && levelOf(0.234) === 2 && levelOf(0.419) === 3 && levelOf(0.477) === 4 && levelOf(0.68) === 5, "level thresholds");

const endId = (e: any) => (typeof e === "object" ? e.id : e);

function canvasTexture(draw: (g: CanvasRenderingContext2D) => void) {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  draw(c.getContext("2d")!);
  return new THREE.CanvasTexture(c);
}
// Tight glow, like a star, not a big blob.
const glowTexture = () =>
  canvasTexture((g) => {
    const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    grd.addColorStop(0, "rgba(255,255,255,1)");
    grd.addColorStop(0.08, "rgba(255,255,255,.7)");
    grd.addColorStop(0.3, "rgba(255,255,255,.12)");
    grd.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grd;
    g.fillRect(0, 0, 256, 256);
  });
// Game-style target lock: four arc segments plus a faint inner ring.
const reticleTexture = () =>
  canvasTexture((g) => {
    g.strokeStyle = "rgba(200,245,255,.95)";
    g.lineWidth = 5;
    for (let i = 0; i < 4; i++) {
      g.beginPath();
      g.arc(128, 128, 104, (i * Math.PI) / 2 + 0.25, ((i + 1) * Math.PI) / 2 - 0.25);
      g.stroke();
    }
    g.strokeStyle = "rgba(200,245,255,.35)";
    g.lineWidth = 2;
    g.beginPath();
    g.arc(128, 128, 84, 0, Math.PI * 2);
    g.stroke();
  });

export interface GraphHandle {
  flyTo(id: string): void;
  /** Zoom out to show everyone and stop orbiting. */
  reset(): void;
}

export function Graph(props: {
  data: any | undefined;
  filter: string;
  selected: string | null;
  freeFlight: boolean;
  onSelect: (id: string | null) => void;
  onMenu: (node: any, ev: MouseEvent) => void;
  handle: React.MutableRefObject<GraphHandle | null>;
}) {
  const el = useRef<HTMLDivElement>(null);
  const graph = useRef<any>(null);
  // Mutable view state read by the render loop and accessor callbacks.
  const st = useRef({
    filter: props.filter,
    selected: props.selected,
    hovered: null as string | null,
    focus: null as Set<string> | null,
    freeFlight: props.freeFlight,
    rotateOff: false, // set by Reset: the map stays still from then on
    mouse: null as { x: number; y: number } | null,
    nodes: [] as any[],
    links: [] as any[],
  });
  const cb = useRef(props);
  cb.current = props;

  // "all" | "connected" | "1".."5": a level shows exactly that level; unconnected people appear only under "all".
  const visible = (n: any) => {
    if (!n || n.isSelf || st.current.filter === "all") return true;
    const lv = levelOf(n.tieStrength);
    return st.current.filter === "connected" ? lv > 0 : lv === Number(st.current.filter);
  };
  const rotating = () => !st.current.freeFlight && !st.current.rotateOff && !reduceMotion;
  const applyDim = () => {
    const s = st.current;
    const focusId = s.hovered ?? s.selected;
    s.focus = focusId ? new Set([focusId, ...s.links.flatMap((l) => (endId(l.source) === focusId ? [endId(l.target)] : endId(l.target) === focusId ? [endId(l.source)] : []))]) : null;
    for (const n of s.nodes) {
      if (!n.__core) continue;
      n.__dim = (visible(n) ? 1 : 0.08) * (!s.focus || s.focus.has(n.id) ? 1 : 0.15);
      n.__core.material.opacity = n.__dim;
      n.__halo.material.opacity = n.__haloBase * n.__dim;
    }
    if (graph.current) graph.current.linkColor(graph.current.linkColor()).linkVisibility(graph.current.linkVisibility());
  };
  const flyTo = (id: string) => {
    const n = st.current.nodes.find((x) => x.id === id);
    if (!graph.current || !n || n.x == null) return;
    const h = Math.hypot(n.x, n.y, n.z) || 1;
    const r = 1 + 110 / h;
    graph.current.cameraPosition({ x: n.x * r, y: n.y * r, z: n.z * r }, n, reduceMotion ? 0 : 1600);
  };
  const reset = () => {
    const g = graph.current;
    if (!g) return;
    st.current.rotateOff = true;
    st.current.hovered = null;
    g.controls().autoRotate = false;
    // Find the closest camera distance where 95% of people project inside 90% of the view, measured with the
    // real perspective (people nearer the camera look bigger). The library's zoomToFit measures meshes, not positions.
    const pts = st.current.nodes.filter((n) => n.x != null).map((n) => new THREE.Vector3(n.x, n.y, n.z));
    const probe = g.camera().clone();
    const dir = new THREE.Vector3(0, 0.15, 0.99).normalize();
    const fits = (d: number) => {
      probe.position.copy(dir).multiplyScalar(d);
      probe.lookAt(0, 0, 0);
      probe.updateMatrixWorld();
      const reach = pts.map((p) => {
        const v = p.clone().project(probe);
        return v.z > 1 ? Infinity : Math.max(Math.abs(v.x), Math.abs(v.y));
      }).sort((a, b) => a - b);
      return (reach[Math.floor(reach.length * 0.95)] ?? 0) <= 0.9;
    };
    let lo = 20, hi = 4000;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) hi = mid;
      else lo = mid;
    }
    const pos = dir.multiplyScalar(hi);
    g.cameraPosition({ x: pos.x, y: pos.y, z: pos.z }, { x: 0, y: 0, z: 0 }, reduceMotion ? 0 : 900);
  };
  props.handle.current = { flyTo, reset };

  // Mount once.
  useEffect(() => {
    const div = el.current!;
    const glow = glowTexture();
    const g: any = new (ForceGraph3D as any)(div, { controlType: "orbit" });
    graph.current = g;
    g.width(div.clientWidth)
      .height(div.clientHeight)
      .backgroundColor("rgba(0,0,0,0)")
      .warmupTicks(120) // lay the map out before the first frame instead of animating the explosion
      .showNavInfo(false)
      .nodeLabel(() => "") // names are sprites that appear near the cursor; no extra tooltip
      .nodeThreeObject((n: any) => {
        const status: NodeStatus = n.__status;
        const r = (n.__r = RADIUS[status]);
        const group = new THREE.Group();
        const core = (n.__core = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 16), new THREE.MeshBasicMaterial({ color: COLOR[status], transparent: true })));
        group.add(core);
        n.__haloBase = HALO[status];
        const halo = (n.__halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: COLOR[status], blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: n.__haloBase })));
        halo.scale.setScalar(r * 9);
        group.add(halo);
        const label = (n.__label = new SpriteText(n.isSelf ? "You" : n.label, n.isSelf ? 2.8 : 2.1, "rgba(235,235,255,.85)"));
        label.fontFace = "-apple-system, BlinkMacSystemFont, sans-serif";
        label.fontWeight = "500";
        label.position.y = -(r + 3.2);
        label.material.depthWrite = false;
        label.material.transparent = true;
        group.add(label);
        return group;
      })
      .linkColor((l: any) => {
        const f = st.current.focus;
        return f && !(f.has(endId(l.source)) && f.has(endId(l.target))) ? "#1c1830" : LINK_COLOR[l.kind];
      })
      .linkWidth(0)
      .linkOpacity(0.7)
      .linkVisibility((l: any) => visible(l.__a) && visible(l.__b))
      .linkDirectionalParticles((l: any) => (l.kind === "confirmed" ? 2 : 0))
      .linkDirectionalParticleWidth(0.7)
      .linkDirectionalParticleSpeed(0.004)
      .linkDirectionalParticleColor(() => "#d8fbff")
      .onNodeHover((n: any) => {
        div.style.cursor = n && !n.isSelf ? "pointer" : "";
        st.current.hovered = n?.id ?? null;
        applyDim();
      })
      .onNodeClick((n: any) => (n.isSelf ? flyTo(n.id) : cb.current.onSelect(n.id)))
      .onNodeRightClick((n: any, ev: MouseEvent) => !n.isSelf && cb.current.onMenu(n, ev))
      .onBackgroundClick(() => cb.current.onSelect(null));
    const noMenu = (e: Event) => e.preventDefault();
    div.addEventListener("contextmenu", noMenu);
    const ro = new ResizeObserver(() => g.width(div.clientWidth).height(div.clientHeight));
    ro.observe(div);

    // Stronger relationships sit closer to you.
    g.d3Force("link").distance((l: any) => ({ confirmed: 45, interaction: 75, proposed: 110 })[l.kind as "confirmed"] ?? 90);
    g.d3Force("charge").strength(-110);
    // Gentle pull toward the centre so people with no links don't drift off into the fog.
    let simNodes: any[] = [];
    const gravity = Object.assign(
      (alpha: number) => {
        for (const n of simNodes) {
          if (n.fx != null) continue;
          // People with no links have nothing holding them, so they get a stronger pull than linked people.
          const k = (n.__isolated ? 0.15 : 0.02) * alpha;
          n.vx -= n.x * k;
          n.vy -= n.y * k;
          n.vz -= n.z * k;
        }
      },
      { initialize: (nodes: any[]) => (simNodes = nodes) },
    );
    g.d3Force("gravity", gravity);
    g.scene().fog = new THREE.FogExp2(0x0b0819, 0.0022);
    g.cameraPosition({ x: 0, y: 30, z: 230 });

    // Faint star dust for depth.
    const dust = new Float32Array(1800 * 3);
    for (let i = 0; i < dust.length; i += 3) {
      const r = 260 + Math.random() * 700, t = Math.random() * Math.PI * 2, u = Math.acos(2 * Math.random() - 1);
      dust[i] = r * Math.sin(u) * Math.cos(t);
      dust[i + 1] = r * Math.sin(u) * Math.sin(t);
      dust[i + 2] = r * Math.cos(u);
    }
    const dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute("position", new THREE.BufferAttribute(dust, 3));
    g.scene().add(new THREE.Points(dustGeo, new THREE.PointsMaterial({ color: 0x9d93d6, size: 1.3, transparent: true, opacity: 0.55, depthWrite: false, fog: false })));
    const reticle = new THREE.Sprite(new THREE.SpriteMaterial({ map: reticleTexture(), transparent: true, depthWrite: false, depthTest: false }));
    reticle.visible = false;
    g.scene().add(reticle);

    const controls = g.controls();
    controls.autoRotate = rotating();
    controls.autoRotateSpeed = 0.5;
    controls.enableDamping = true;
    let idle: number | undefined;
    controls.addEventListener("start", () => (clearTimeout(idle), (controls.autoRotate = false)));
    controls.addEventListener("end", () => {
      clearTimeout(idle);
      idle = window.setTimeout(() => (controls.autoRotate = rotating()), 6000);
    });

    // Free flight: WASD moves camera and orbit target together.
    // Names show only near the cursor, so track it over the map.
    const onMove = (e: PointerEvent) => {
      const r = div.getBoundingClientRect();
      st.current.mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onLeave = () => (st.current.mouse = null);
    div.addEventListener("pointermove", onMove);
    div.addEventListener("pointerleave", onLeave);
    const keys = new Set<string>();
    const down = (e: KeyboardEvent) => {
      if (!st.current.freeFlight || (e.target as HTMLElement).matches?.("input, textarea") || e.metaKey || e.ctrlKey) return;
      keys.add(e.key.toLowerCase());
    };
    const up = (e: KeyboardEvent) => keys.delete(e.key.toLowerCase());
    const blur = () => keys.clear();
    addEventListener("keydown", down);
    addEventListener("keyup", up);
    addEventListener("blur", blur);
    const fwd = new THREE.Vector3(), right = new THREE.Vector3(), step = new THREE.Vector3();
    let raf = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      const cam = g.camera();
      const s = st.current;
      // Thin the fog as the camera backs off, so a zoomed-out view isn't swallowed by it.
      g.scene().fog.density = Math.min(0.0022, 0.5 / Math.max(1, cam.position.distanceTo(g.controls().target)));
      // A name shows only for the selected dot, or when the cursor is near it (full within 70px, gone by 110px).
      for (const n of s.nodes) {
        if (!n.__label || n.x == null) continue;
        let show = n.id === s.selected ? 1 : 0;
        if (!show && s.mouse && visible(n)) {
          const p = g.graph2ScreenCoords(n.x, n.y, n.z);
          show = Math.min(1, Math.max(0, (110 - Math.hypot(p.x - s.mouse.x, p.y - s.mouse.y)) / 40));
        }
        n.__label.material.opacity = show;
        n.__label.visible = show > 0;
      }
      const sel = s.selected ? s.nodes.find((n) => n.id === s.selected) : null;
      reticle.visible = !!sel && sel.x != null;
      if (sel && reticle.visible) {
        reticle.position.set(sel.x, sel.y, sel.z);
        reticle.scale.setScalar(sel.__r * 6 * (reduceMotion ? 1 : 1 + 0.06 * Math.sin(t / 300)));
        if (!reduceMotion) reticle.material.rotation += 0.01;
      }
      if (!s.freeFlight || !keys.size) return;
      const speed = keys.has("shift") ? 5 : 1.8;
      fwd.subVectors(controls.target, cam.position).normalize();
      right.crossVectors(fwd, cam.up).normalize();
      step.set(0, 0, 0);
      if (keys.has("w") || keys.has("arrowup")) step.add(fwd);
      if (keys.has("s") || keys.has("arrowdown")) step.sub(fwd);
      if (keys.has("d") || keys.has("arrowright")) step.add(right);
      if (keys.has("a") || keys.has("arrowleft")) step.sub(right);
      if (keys.has("e")) step.add(cam.up);
      if (keys.has("q")) step.sub(cam.up);
      if (!step.lengthSq()) return;
      step.normalize().multiplyScalar(speed);
      cam.position.add(step);
      controls.target.add(step);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      removeEventListener("keydown", down);
      removeEventListener("keyup", up);
      removeEventListener("blur", blur);
      div.removeEventListener("contextmenu", noMenu);
      div.removeEventListener("pointermove", onMove);
      div.removeEventListener("pointerleave", onLeave);
      ro.disconnect();
      g._destructor?.();
      div.innerHTML = "";
      graph.current = null;
    };
  }, []);

  // New data: keep existing positions so a refresh doesn't re-explode the layout.
  useEffect(() => {
    const g = graph.current;
    if (!g || !props.data) return;
    const prev = new Map(st.current.nodes.map((n) => [n.id, n]));
    const nodes = props.data.nodes.map((n: any) => {
      const old = prev.get(n.id);
      const status = nodeStatus(n, props.data.edges);
      const keep = old && old.__status === status ? { x: old.x, y: old.y, z: old.z, vx: old.vx, vy: old.vy, vz: old.vz } : old ? { x: old.x, y: old.y, z: old.z } : {};
      return { ...n, ...keep, __status: status, ...(n.isSelf ? { fx: 0, fy: 0, fz: 0 } : {}) };
    });
    const byId = new Map(nodes.map((n: any) => [n.id, n]));
    const links = props.data.edges
      .filter((e: any) => byId.has(e.from) && byId.has(e.to))
      .map((e: any) => ({ id: e.id, source: e.from, target: e.to, kind: LINK_KIND[e.kind] ?? "proposed", explanation: e.explanation, __a: byId.get(e.from), __b: byId.get(e.to) }));
    const linked = new Set(links.flatMap((l: any) => [l.source, l.target]));
    for (const n of nodes) n.__isolated = !linked.has(n.id);
    st.current.nodes = nodes;
    st.current.links = links;
    g.graphData({ nodes, links });
    applyDim();
  }, [props.data]);

  useEffect(() => {
    Object.assign(st.current, { filter: props.filter, selected: props.selected, freeFlight: props.freeFlight });
    if (graph.current) graph.current.controls().autoRotate = rotating();
    applyDim();
  }, [props.filter, props.selected, props.freeFlight]);

  return <div id="scene" ref={el} role="img" aria-label="3D network of people. Use Spotlight search (Command K) to open a person." />;
}
