import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, AppCtx, initials, useCtx, type Ctx, type MenuItem, type Screen } from "./api";
import { CLOSE_MIN, Graph, inGroup, type GraphHandle } from "./Graph";
import { Person } from "./Person";
import { Home } from "./screens/Home";
import { Opportunities } from "./screens/Opportunities";
import { Posts } from "./screens/Posts";
import { addProjectFolder, Projects } from "./screens/Projects";
import { ConnectSheet, Privacy } from "./screens/Privacy";

const SCREENS: Array<[Screen, string]> = [["home", "Home"], ["opps", "Opportunities"], ["posts", "Posts"], ["network", "Network"], ["projects", "Projects"], ["privacy", "Privacy"]];
const STATUS_TEXT: Record<string, string> = { running: "Agent running", paused: "Agent paused", catching: "Catching up", offline: "Backend offline" };
const HINT = (
  <>
    <span>Drag to orbit</span><span>Scroll to zoom</span><span>Hover to see names</span><span><kbd>R</kbd> reset</span><span><kbd>F</kbd> free flight</span>
  </>
);
const FLY_HINT = (
  <>
    <span><kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> move</span><span><kbd>Q</kbd> <kbd>E</kbd> down / up</span><span><kbd>⇧</kbd> boost</span><span><kbd>esc</kbd> exit</span>
  </>
);

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"><path d={d} /></svg>
);
const NAV_ICON: Record<Screen, string> = {
  home: "M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z",
  opps: "M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2z",
  posts: "M4 20h4L19 9l-4-4L4 16zM13 7l4 4",
  network: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM5 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM19 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM6 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM18 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM10 10L6.5 7.5M14 10l3.5-2.5M10 14l-3 3.5M14 14l2.6 2.6",
  projects: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  privacy: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
};

export default function App() {
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const [hist, setHist] = useState<{ list: Screen[]; i: number }>({ list: ["network"], i: 0 });
  const screen = hist.list[hist.i];
  const [personId, setPersonId] = useState<string | null>(null);
  const [status, setStatus] = useState<any>(null);
  const [closed, setClosed] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [freeFlight, setFreeFlight] = useState(false);
  const [netFilter, setNetFilter] = useState("all");
  const [oppFilter, setOppFilter] = useState("all");
  const [platform, setPlatform] = useState<"linkedin" | "x">("linkedin");
  const [postProject, setPostProject] = useState<string | null>(null);
  const [connect, setConnect] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ items: MenuItem[]; x: number; y: number; anchor?: string } | null>(null);
  const [toast, setToast] = useState<{ text: string; undo?: () => void; label?: string; n: number } | null>(null);
  const [palette, setPalette] = useState(false);
  const [graphData, setGraphData] = useState<any>();
  const [projects, setProjects] = useState<any[]>([]);
  const [clock, setClock] = useState("");
  const graph = useRef<GraphHandle | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  const notify = useCallback((text: string, undo?: () => void, label?: string) => {
    setToast({ text, undo, label, n: Date.now() });
    clearTimeout(toastTimer.current);
    // Leave a notification that asks for a decision up long enough to read and act on.
    toastTimer.current = window.setTimeout(() => setToast((t) => (t ? { ...t, n: 0 } : t)), label ? 10000 : 4500);
  }, []);

  const go = useCallback((s: Screen) => {
    setHist((h) => (h.list[h.i] === s ? h : { list: [...h.list.slice(0, h.i + 1), s], i: h.i + 1 }));
    setFreeFlight(false);
    if (s !== "network") setPersonId(null);
  }, []);
  const back = () => setHist((h) => ({ ...h, i: Math.max(0, h.i - 1) }));
  const fwd = () => setHist((h) => ({ ...h, i: Math.min(h.list.length - 1, h.i + 1) }));

  const graphDataRef = useRef<any>(undefined);
  graphDataRef.current = graphData;
  const openPerson = useCallback((id: string, fly?: boolean) => {
    go("network");
    // Opening someone outside the group on screen (e.g. from Search) switches back to everyone.
    setNetFilter((f) => {
      const n = graphDataRef.current?.nodes?.find((x: any) => x.id === id);
      return n && !inGroup(n, f) ? "all" : f;
    });
    setPersonId(id);
    if (fly) setTimeout(() => graph.current?.flyTo(id), 50);
  }, [go]);

  const act = useCallback<Ctx["act"]>(async (fn, done) => {
    try {
      const r = await fn();
      const msg = typeof done === "function" ? done(r) : done;
      if (msg) notify(msg);
      return r;
    } catch (e) {
      const folder = e instanceof ApiError && e.code === "ai_permission_denied" ? e.details : null;
      if (folder?.projectId) {
        // One click allows AI for that folder (the same switch as in Privacy) and retries what the user asked for.
        notify(
          (e as Error).message,
          () => void act(async () => {
            await api("PATCH", `/projects/${folder.projectId}`, { aiPermission: "allowed" });
            notify(`AI allowed for ${folder.projectName}. Retrying…`);
            return fn();
          }, done),
          `Allow AI for ${folder.projectName}`,
        );
      } else notify((e as Error).message);
      return undefined;
    } finally {
      bump();
    }
  }, [notify, bump]);

  const [scanStep, setScanStep] = useState<number | null>(null); // index into SCAN_STEPS while a scan runs
  const scanning = scanStep !== null;
  const scan = useCallback(async () => {
    if (scanning) return;
    setScanStep(0);
    try {
      await api("POST", "/jobs/rescan-folders/run");
      setScanStep(1);
      const r = await api("POST", "/discovery/run", {});
      const failed = r.queries.filter((q: any) => q.error).length;
      const skipped = r.skippedConnectors.map((c: any) => c.id).join(", ");
      notify(
        `Scan done: ${r.queries.length} searches, ${r.newPosts} new posts, ${r.opportunities} new opportunities.` +
          (failed ? ` ${failed} searches failed (offline or rate-limited).` : "") +
          (skipped ? ` Not searched: ${skipped}.` : ""),
      );
    } catch (e) {
      notify(`Scan failed: ${(e as Error).message}`);
    } finally {
      setScanStep(null);
      bump();
    }
  }, [scanning, notify, bump]);

  const openMenu = useCallback((items: MenuItem[], x: number, y: number, anchor?: string) => setMenu({ items, x, y, anchor }), []);

  // Agent status, counts and shared lists: polled, and refreshed after every change.
  useEffect(() => {
    let live = true;
    const load = () => {
      api("GET", "/status").then((s) => live && setStatus(s)).catch(() => live && setStatus((s: any) => ({ ...s, offline: true })));
      api("GET", "/network/graph").then((g) => live && setGraphData(g)).catch(() => {});
      api("GET", "/projects?kind=project").then((p) => live && setProjects(p)).catch(() => {});
    };
    load();
    const t = setInterval(() => api("GET", "/status").then((s) => live && setStatus(s)).catch(() => live && setStatus((s: any) => ({ ...s, offline: true }))), 10_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [version]);

  const agentState = status?.offline ? "offline" : status?.agent?.state === "catching_up" ? "catching" : status?.agent?.state ?? "running";
  useEffect(() => {
    document.body.dataset.screen = screen;
    document.body.dataset.status = agentState === "offline" ? "paused" : agentState;
  }, [screen, agentState]);

  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).replace(/,/g, ""));
    tick();
    const t = setInterval(tick, 20_000);
    const lit = (e: PointerEvent) => {
      const el = (e.target as HTMLElement).closest?.(".lit") as HTMLElement | null;
      if (!el) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty("--mx", e.clientX - r.left + "px");
      el.style.setProperty("--my", e.clientY - r.top + "px");
    };
    document.addEventListener("pointermove", lit);
    return () => (clearInterval(t), document.removeEventListener("pointermove", lit));
  }, []);

  const paused = status?.agent?.state === "paused";
  const togglePause = () => act(() => api("PATCH", "/settings", { "agent.paused": !paused }), paused ? "Agent resumed. Overdue work catches up now." : "Agent paused. Nothing runs in the background until you resume.");
  const hideWindow = (minimized: boolean) => {
    setClosed(true);
    notify(minimized ? "Minimized. Reopen it from the agent icon in the menu bar." : "The window is closed, but the agent keeps running in the menu bar.");
  };
  const importArchive = async () => {
    const chosen = await act(() => api("POST", "/system/choose", { kind: "folder", prompt: "Choose your unzipped LinkedIn data export folder" }));
    if (chosen?.path) await act(() => api("POST", "/imports/linkedin-archive", { path: chosen.path }), (r: any) => `Imported ${r.connections.rows} connections and ${r.messages.conversations} conversations (${r.messages.duplicates} already known).${r.warnings?.length ? ` ${r.warnings.length} warnings.` : ""}`);
  };
  const ctx: Ctx = { version, bump, notify, go, openPerson, openMenu, status, act, scan, scanning };

  const MENUS: Record<string, () => MenuItem[]> = {
    app: () => [
      { label: "About Networking Agent", run: () => notify(`Local-first networking agent. AI: ${status?.ai?.available ? status.ai.model : "offline"}.`) }, "-",
      { label: "Settings…", key: "⌘,", run: () => go("privacy") }, "-",
      { label: "Hide Networking Agent", key: "⌘H", run: () => hideWindow(true) },
      { label: "Quit Networking Agent", key: "⌘Q", run: () => notify("To quit, stop the backend (Ctrl+C in its terminal). Background work then pauses and catches up next time.") },
    ],
    file: () => [
      { label: "Add Project Folder…", key: "⌘O", run: () => (go("projects"), void addProjectFolder(ctx)) },
      { label: "Import LinkedIn Archive…", run: () => void importArchive() }, "-",
      { label: "Close Window", key: "⌘W", run: () => hideWindow(false) },
    ],
    edit: () => [["Undo", "⌘Z"], ["Redo", "⇧⌘Z"], "-", ["Cut", "⌘X"], ["Copy", "⌘C"], ["Paste", "⌘V"]].map((l) => (l === "-" ? "-" : { label: l[0], key: l[1], run: () => document.execCommand(l[0].toLowerCase()) })),
    view: () => [
      ...SCREENS.map(([id, n], i) => ({ label: n, key: "⌘" + (i + 1), check: screen === id, run: () => go(id) })), "-",
      { label: "Free Flight", key: "F", run: () => (go("network"), setFreeFlight(true)) },
      { label: zoomed ? "Exit Full Screen" : "Enter Full Screen", key: "⌃⌘F", run: () => setZoomed(!zoomed) },
    ],
    window: () => [{ label: "Minimize", key: "⌘M", run: () => hideWindow(true) }, { label: "Zoom", run: () => setZoomed(!zoomed) }, "-", { label: "Networking Agent", check: !closed, run: () => setClosed(false) }],
    help: () => [{ label: "Networking Agent Help", run: () => window.open("https://github.com/Sonicnik/CubeBuildathon#readme", "_blank", "noopener") }],
    agent: () => [
      { label: STATUS_TEXT[agentState], disabled: true }, "-",
      { label: paused ? "Resume Agent" : "Pause Agent", run: togglePause },
      { label: "Open Dashboard", run: () => setClosed(false) }, "-",
      { label: scanning ? "Scanning…" : "Scan for Opportunities Now", disabled: scanning, run: () => void scan() },
      { label: `Review ${status?.counts?.openOpportunities ?? 0} Opportunities`, run: () => (setClosed(false), go("opps")) },
    ],
  };

  const personMenu = (n: any, ev: MouseEvent) =>
    openMenu([
      { label: "Show in Inspector", run: () => openPerson(n.id, true) },
      { label: "Fly to " + String(n.label).split(" ")[0], run: () => graph.current?.flyTo(n.id) },
      { label: "Draft Follow-up", run: () => act(() => api("POST", `/people/${n.id}/drafts`, {}), () => (setOppFilter("followups"), `Follow-up for ${n.label} is ready in Opportunities.`)) }, "-",
      { label: "Copy Name", key: "⌘C", run: () => (navigator.clipboard?.writeText(n.label).catch(() => {}), notify("Name copied.")) },
    ], ev.clientX, ev.clientY);

  // Keyboard shortcuts, as in the design.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (e.metaKey && e.ctrlKey && k === "f") return e.preventDefault(), setZoomed((z) => !z);
      if (e.metaKey || e.ctrlKey) {
        if (k === "k" || k === "f") return e.preventDefault(), setPalette((p) => !p);
        if (/^[1-6]$/.test(k)) return e.preventDefault(), go(SCREENS[+k - 1][0]);
        if (k === "[") return e.preventDefault(), back();
        if (k === "]") return e.preventDefault(), fwd();
        if (k === ",") return e.preventDefault(), go("privacy");
        if (k === "o") return e.preventDefault(), go("projects"), void addProjectFolder(ctx);
        return;
      }
      if (e.key === "Escape") {
        if (menu) setMenu(null);
        else if (palette) setPalette(false);
        else if (connect) setConnect(null);
        else if (freeFlight) setFreeFlight(false);
        else setPersonId(null);
        return;
      }
      if ((e.target as HTMLElement).matches?.("input, textarea, select")) return;
      if (k === "f" && screen === "network") setFreeFlight((f) => !f);
      if (k === "r" && screen === "network") resetView();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });

  // Network groups: everyone, one "Close" group, then the industries present in your network.
  const groupFilters = useMemo(() => {
    const people = (graphData?.nodes ?? []).filter((n: any) => !n.isSelf);
    const industries = new Map<string, { name: string; n: number }>();
    let other = 0;
    for (const p of people) {
      if (!p.industry) other++;
      else industries.set(p.industry.id, { name: p.industry.name, n: (industries.get(p.industry.id)?.n ?? 0) + 1 });
    }
    return [
      ["all", "All", people.length, "Everyone in your network"],
      ["close", "Close", people.filter((n: any) => inGroup(n, "close")).length, `People you have a strong tie with (tie strength ≥ ${CLOSE_MIN})`],
      ...[...industries.entries()]
        .sort((a, b) => b[1].n - a[1].n || a[1].name.localeCompare(b[1].name))
        .map(([id, { name, n }]) => [`ind:${id}`, name, n, `People in ${name}, from their profile and posts (change it on a person)`]),
      ...(other ? [["ind:other", "Other", other, "People whose industry isn't clear yet"]] : []),
    ] as Array<[string, string, number, string]>;
  }, [graphData]);
  // If the group on screen empties (e.g. its last person was moved to another group), show everyone.
  useEffect(() => {
    if (graphData && !groupFilters.some(([id]) => id === netFilter)) setNetFilter("all");
  }, [graphData, groupFilters, netFilter]);
  const resetView = () => {
    setPersonId(null);
    setFreeFlight(false);
    setNetFilter("all");
    setMenu(null);
    graph.current?.reset();
  };
  const names = useMemo(() => new Map<string, string>((graphData?.nodes ?? []).map((n: any) => [n.id, n.isSelf ? "You" : n.label])), [graphData]);
  const projectSeg = (value: string, set: (v: string) => void, first: [string, string], extra: Array<[string, string]> = []) => (
    <>
      {[first, ...projects.map((p): [string, string] => [p.id, p.name]), ...extra].map(([id, n]) => (
        <button key={id} aria-pressed={value === id} onClick={() => set(id)}>{n}</button>
      ))}
    </>
  );
  const SUBTITLE: Record<Screen, string> = {
    home: status?.counts ? `${status.counts.projects} projects · ${status.counts.people} people · ${status.counts.awaitingApproval} awaiting approval` : "",
    opps: oppFilter === "followups" ? "People you already know, with a reason to write" : "Ranked by how useful your work is, not just topic overlap",
    posts: "Drafted from meaningful project changes",
    network: `${Math.max(0, (graphData?.nodes?.length ?? 1) - 1)} people · drag to orbit, click to inspect`,
    projects: "Each folder has its own AI permission",
    privacy: "Your database stays on this Mac",
  };

  return (
    <AppCtx.Provider value={ctx}>
      <h2 className="sr-only">Networking agent: a 3D people network with a glass interface.</h2>
      <div className="menubar" role="menubar" aria-label="Menu bar">
        {(["app", "file", "edit", "view", "window", "help"] as const).map((m) => (
          <button key={m} className={`mb-item ${m === "app" ? "mb-app" : ""} ${menu?.anchor === m ? "open" : ""}`}
            onClick={(e) => {
              if (menu?.anchor === m) return setMenu(null);
              const r = e.currentTarget.getBoundingClientRect();
              openMenu(MENUS[m](), r.left, r.bottom + 2, m);
            }}
            onPointerEnter={(e) => {
              if (menu?.anchor && menu.anchor !== m) {
                const r = e.currentTarget.getBoundingClientRect();
                openMenu(MENUS[m](), r.left, r.bottom + 2, m);
              }
            }}>
            {m === "app" ? "Networking Agent" : m[0].toUpperCase() + m.slice(1)}
          </button>
        ))}
        <div className="mb-spacer" />
        <button className={`mb-item ${menu?.anchor === "agent" ? "open" : ""}`} aria-label="Agent status menu" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); openMenu(MENUS.agent(), r.left, r.bottom + 2, "agent"); }}>
          <span className="mb-dot" />
        </button>
        <span className="mb-item" aria-hidden="true">{clock}</span>
      </div>

      <div className={`window ${zoomed ? "zoomed" : ""} ${closed ? "closed" : ""}`}>
        <div className="aurora" aria-hidden="true"><i /><i /><i /></div>
        <Graph data={graphData} filter={netFilter} selected={personId} freeFlight={freeFlight} onSelect={(id) => (id ? openPerson(id, true) : (setMenu(null), setPersonId(null)))} onMenu={personMenu} handle={graph} />

        <div className="app">
          <nav className="sidebar glass lit" aria-label="Sidebar">
            <div className="traffic">
              <button className="close" onClick={() => hideWindow(false)} aria-label="Close window">×</button>
              <button className="min" onClick={() => hideWindow(true)} aria-label="Minimize window">−</button>
              <button className="zoom" onClick={() => setZoomed(!zoomed)} aria-label="Zoom window">+</button>
            </div>
            {([["Agent", ["home", "opps", "posts"]], ["Relationships", ["network"]], ["Library", ["projects", "privacy"]]] as Array<[string, Screen[]]>).map(([head, items]) => (
              <div key={head}>
                <div className="sb-head">{head}</div>
                {items.map((id) => {
                  const count = { opps: status?.counts?.openOpportunities, network: status?.counts?.people, projects: status?.counts?.projects } as Partial<Record<Screen, number>>;
                  return (
                    <button key={id} className="nav-btn" aria-current={screen === id ? "page" : undefined} onClick={() => go(id)}>
                      <Icon d={NAV_ICON[id]} />
                      <span className="label">{SCREENS.find((s) => s[0] === id)![1]}</span>
                      {count[id] != null && <span className="count">{count[id]}</span>}
                    </button>
                  );
                })}
              </div>
            ))}
            <div className="spacer" />
            <button className="status" onClick={togglePause} title={paused ? "Resume the agent" : "Pause the agent"}>
              <span className="dot" />
              <span>{STATUS_TEXT[agentState]}{status?.offline ? "" : !status?.ai?.available ? " · AI offline" : status.ai.provider === "chatgpt" ? " · Using ChatGPT plan" : " · Claude"}</span>
            </button>
          </nav>

          <header className="toolbar" onDoubleClick={(e) => (e.target === e.currentTarget || (e.target as HTMLElement).closest(".tb-title, .tb-spacer")) && setZoomed(!zoomed)}>
            <div className="tb-group glass thin">
              <button className="tb-btn" onClick={back} aria-label="Back" aria-disabled={hist.i <= 0}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M15 5l-7 7 7 7" /></svg></button>
              <button className="tb-btn" onClick={fwd} aria-label="Forward" aria-disabled={hist.i >= hist.list.length - 1}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M9 5l7 7-7 7" /></svg></button>
            </div>
            <div className="tb-title"><h1>{SCREENS.find((s) => s[0] === screen)![1]}</h1><p>{SUBTITLE[screen]}</p></div>
            <div className="tb-spacer" />
            <div className="seg glass thin" data-for="network" role="group" aria-label="Filter by group">
              {groupFilters.slice(0, SHOWN_GROUPS).map(([id, name, count, title]) => (
                <button key={id} aria-pressed={netFilter === id} title={title} onClick={() => setNetFilter(id)}>
                  {name} <span className="seg-count">{count}</span>
                </button>
              ))}
            </div>
            {groupFilters.length > SHOWN_GROUPS && (
              // Smaller groups live in a menu outside the scrolling bar, so it's always reachable.
              <div className="seg glass thin seg-more-wrap" data-for="network">
                <select
                  className="seg-more"
                  aria-label="More groups"
                  data-active={groupFilters.slice(SHOWN_GROUPS).some(([id]) => id === netFilter) || undefined}
                  value={groupFilters.slice(SHOWN_GROUPS).some(([id]) => id === netFilter) ? netFilter : ""}
                  onChange={(e) => e.target.value && setNetFilter(e.target.value)}
                >
                  <option value="" disabled>More ({groupFilters.length - SHOWN_GROUPS})</option>
                  {groupFilters.slice(SHOWN_GROUPS).map(([id, name, count]) => (
                    <option key={id} value={id}>{name} ({count})</option>
                  ))}
                </select>
              </div>
            )}
            <button className="btn glass thin net-reset" data-for="network" onClick={resetView} title="Zoom out to see everyone and stop orbiting (R)">Reset view</button>
            <div className="seg glass thin" data-for="opps" role="group" aria-label="Filter opportunities">{projectSeg(oppFilter, setOppFilter, ["all", "All"], [["followups", "Follow-ups"]])}</div>
            <div className="seg glass thin" data-for="posts" role="group" aria-label="Platform">
              <button aria-pressed={platform === "linkedin"} onClick={() => setPlatform("linkedin")}>LinkedIn</button>
              <button aria-pressed={platform === "x"} onClick={() => setPlatform("x")}>X</button>
            </div>
            <button className="search glass thin" onClick={() => setPalette(true)} aria-label="Search">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg><span>Search</span><kbd>⌘K</kbd>
            </button>
            <div className="tb-group glass thin">
              <button className="tb-btn" onClick={() => (go("projects"), void addProjectFolder(ctx))} aria-label="Add project folder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M12 5v14M5 12h14" /></svg></button>
            </div>
          </header>

          <main>
            {status?.offline && screen !== "network" && <div className="empty" style={{ margin: 20 }}>The backend isn't reachable. Start it with <code>npm run demo</code> in <code>backend/</code>.</div>}
            <section className={`screen ${screen === "home" ? "on" : ""}`}>{screen === "home" && <Home onDraftPost={(id) => (setPostProject(id), go("posts"))} />}</section>
            <section className={`screen ${screen === "opps" ? "on" : ""}`}>{screen === "opps" && <Opportunities filter={oppFilter} />}</section>
            <section className={`screen ${screen === "posts" ? "on" : ""}`}>{screen === "posts" && <Posts platform={platform} projectHint={postProject} />}</section>
            <section className={`screen network-screen ${screen === "network" ? "on" : ""}`}>
              <div className="net-ui">
                <div className="legend glass thin">
                  <span><i style={{ background: "var(--dim)" }} />Proposed</span>
                  <span><i style={{ background: "var(--violet)" }} />Interacted</span>
                  <span><i style={{ background: "var(--cyan)", boxShadow: "0 0 8px var(--cyan)" }} />Connected</span>
                </div>
                <div className={`hint glass thin ${freeFlight ? "fly" : ""}`}>{freeFlight ? FLY_HINT : HINT}</div>
              </div>
            </section>
            <section className={`screen ${screen === "projects" ? "on" : ""}`}>{screen === "projects" && <Projects />}</section>
            <section className={`screen ${screen === "privacy" ? "on" : ""}`}>{screen === "privacy" && <Privacy onConnect={setConnect} />}</section>
          </main>
        </div>

        <Person id={screen === "network" ? personId : null} names={names} onClose={() => setPersonId(null)} onDraftedFollowup={() => setOppFilter("followups")} />
      </div>

      {scanStep !== null && <ScanOverlay step={scanStep} />}
      {palette && <Spotlight onClose={() => setPalette(false)} people={graphData?.nodes ?? []} />}
      {connect && <ConnectSheet name={connect} onClose={() => setConnect(null)} />}
      {menu && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 39 }} onPointerDown={() => setMenu(null)} />
          <div id="menu" className="glass thick" role="menu" style={{ left: Math.max(4, Math.min(menu.x, innerWidth - 230)), top: menu.y }}>
            {menu.items.map((it, i) =>
              it === "-" ? <div className="sep" role="separator" key={i} /> : (
                <button role="menuitem" key={i} disabled={it.disabled} onClick={() => (setMenu(null), it.run?.())}>
                  {it.check && <span className="check">✓</span>}{it.label}<span className="k">{it.key ?? ""}</span>
                </button>
              ),
            )}
          </div>
        </>
      )}
      <div id="toast" className={`glass thick ${toast?.n ? "show" : ""}`} role="status" aria-live="polite">
        <div className="app-icon" />
        <div className="tx">
          <b>Networking Agent</b>
          <span>{toast?.text}</span>
          {toast?.undo && <div><button className="btn" onClick={() => (toast.undo?.(), setToast(null))}>{toast.label ?? "Undo"}</button></div>}
        </div>
        <span className="when">now</span>
      </div>
    </AppCtx.Provider>
  );
}

/** All, Close and the three largest industries get buttons; smaller groups go in the "More" menu. */
const SHOWN_GROUPS = 5;

const SCAN_STEPS = ["Checking your project folders", "Searching sources and scoring matches"];
const ORBITS = [
  { inset: 6, dur: 7, color: "var(--cyan)" },
  { inset: 20, dur: 4.5, color: "#8f8f8f" },
  { inset: 34, dur: 3, color: "#ededed" },
];

/** Covers and dims the app while a scan runs; the backend calls can't be cancelled, so there is no close button. */
function ScanOverlay({ step }: { step: number }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSeconds((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="scan-overlay" role="alertdialog" aria-modal="true" aria-busy="true" aria-labelledby="scan-title" aria-describedby="scan-step">
      <div className="scan-card glass thick" tabIndex={-1} ref={(el) => el?.focus()}>
        <div className="radar" aria-hidden="true">
          <i className="ring" style={{ inset: 0 }} />
          <i className="ring" style={{ inset: 22 }} />
          <i className="ring" style={{ inset: 44 }} />
          <i className="sweep" />
          {ORBITS.map((o, i) => (
            <i key={i} className="orbit" style={{ inset: o.inset, animationDuration: `${o.dur}s`, animationDelay: `-${(o.dur * (i + 1)) / 3}s`, ["--c" as string]: o.color }} />
          ))}
          <i className="core" />
        </div>
        <h2 id="scan-title" className="scan-title">Scanning in progress</h2>
        <p className="scan-sub">Please wait. Your agent is looking for new conversations.</p>
        <ol className="scan-steps" id="scan-step" aria-live="polite">
          {SCAN_STEPS.map((label, i) => (
            <li key={label} className={i < step ? "done" : i === step ? "active" : "todo"} aria-current={i === step ? "step" : undefined}>
              <span className="dot" aria-hidden="true">{i < step ? "✓" : ""}</span>
              {label}
            </li>
          ))}
        </ol>
        <div className="scan-bar" aria-hidden="true"><i /></div>
        <span className="scan-time">{String(Math.floor(seconds / 60)).padStart(2, "0")}:{String(seconds % 60).padStart(2, "0")}</span>
      </div>
    </div>
  );
}

/** ⌘K: screens, people, and content hits from the backend's hybrid search. */
function Spotlight({ onClose, people }: { onClose: () => void; people: any[] }) {
  const { go, openPerson } = useCtx();
  const [q, setQ] = useState("");
  const [ix, setIx] = useState(0);
  const [hits, setHits] = useState<any[]>([]);
  useEffect(() => {
    if (q.trim().length < 3) return setHits([]);
    const t = setTimeout(() => api("GET", `/search?q=${encodeURIComponent(q)}&limit=5`).then(setHits).catch(() => setHits([])), 200);
    return () => clearTimeout(t);
  }, [q]);
  const ql = q.toLowerCase().trim();
  const SOURCE: Record<string, [string, Screen]> = { project_file: ["File", "projects"], project_context: ["Project", "projects"], source_post: ["Post", "opps"], interaction: ["Conversation", "network"] };
  const items = [
    ...SCREENS.map(([id, n], i) => ({ n, person: false, kind: "⌘" + (i + 1), run: () => go(id) })),
    ...people.filter((p) => !p.isSelf).map((p) => ({ n: p.label as string, person: true, kind: p.title ?? p.organization ?? "", run: () => openPerson(p.id, true) })),
  ]
    .filter((i) => i.n.toLowerCase().includes(ql))
    .slice(0, 8)
    .concat(hits.map((h) => ({ n: String(h.text).replace(/\s+/g, " ").slice(0, 70), kind: `${SOURCE[h.sourceType]?.[0] ?? h.sourceType} · ${h.ref.startsWith("source_post") ? "" : h.ref}`, run: () => go(SOURCE[h.sourceType]?.[1] ?? "home") })) as any[]);
  const sel = Math.min(ix, Math.max(0, items.length - 1));
  const run = (i: number) => (onClose(), items[i]?.run());
  return (
    <div id="palette" className="open" role="dialog" aria-modal="true" aria-label="Spotlight search" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="pal glass thick">
        <div className="pal-input">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
          <input autoFocus placeholder="Search people, screens and your work" autoComplete="off" aria-label="Search" value={q}
            onChange={(e) => (setQ(e.target.value), setIx(0))}
            onKeyDown={(e) => {
              if ((e.key === "ArrowDown" || e.key === "ArrowUp") && items.length) {
                e.preventDefault();
                setIx((sel + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
              }
              if (e.key === "Enter") run(sel);
            }} />
        </div>
        <ul role="listbox">
          {items.length ? items.map((it, i) => (
            <li key={i} role="option" aria-selected={i === sel} onClick={() => run(i)} onPointerEnter={() => setIx(i)}>
              {it.person && <span className="avatar">{initials(it.n)}</span>}{it.n}<span className="muted">{it.kind}</span>
            </li>
          )) : <li className="muted">No results</li>}
        </ul>
      </div>
    </div>
  );
}
