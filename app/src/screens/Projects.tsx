import { useState } from "react";
import { api, useApi, useCtx } from "../api";

/** Opens the native Finder dialog (via the backend) and adds the chosen folder. AI stays off until granted. */
export async function addProjectFolder(ctx: ReturnType<typeof useCtx>) {
  const chosen = await ctx.act(() => api("POST", "/system/choose", { kind: "folder", prompt: "Choose a project folder to add" }));
  if (!chosen?.path) return;
  await ctx.act(
    () => api("POST", "/projects", { folderPath: chosen.path, aiPermission: "denied" }),
    (r: any) => `Added ${r.project.name}. AI processing is off until you allow it in Privacy.`,
  );
}

function Question({ q, projectId }: { q: any; projectId: string }) {
  const { act } = useCtx();
  const [answer, setAnswer] = useState("");
  const [open, setOpen] = useState(false);
  const send = () =>
    act(async () => {
      await api("POST", `/questions/${q.id}/answer`, { answer });
      return api("POST", `/projects/${projectId}/summarize`, {});
    }, "Answer saved to the project record and the summary was updated.");
  return (
    <div className="q" style={{ flexWrap: "wrap" }}>
      <span className="grow">{q.question}</span>
      {!open ? (
        <>
          <button className="btn ghost" onClick={() => act(() => api("POST", `/questions/${q.id}/dismiss`), "Question dismissed.")}>Skip</button>
          <button className="btn" onClick={() => setOpen(true)}>Answer</button>
        </>
      ) : (
        <div className="row" style={{ width: "100%" }}>
          <input className="field" autoFocus value={answer} onChange={(e) => setAnswer(e.target.value)} onKeyDown={(e) => e.key === "Enter" && answer.trim() && send()} placeholder="Your answer becomes a stated fact" />
          <button className="btn primary" disabled={!answer.trim()} onClick={send}>Save</button>
        </div>
      )}
    </div>
  );
}

function ProjectCard({ p }: { p: any }) {
  const { act } = useCtx();
  const detail = useApi<any>(`/projects/${p.id}`).data;
  const [scanning, setScanning] = useState(false);
  const ctx = detail?.context;
  const rescan = async () => {
    setScanning(true);
    await act(() => api("POST", `/projects/${p.id}/scan`, {}), (r: any) => (r.summary?.status === "created" ? "Rescanned. The summary was updated." : "Rescanned. Nothing meaningful changed."));
    setScanning(false);
  };
  const status = scanning ? ["Scanning changes", ""] : p.status !== "active" ? [p.status === "paused" ? "Paused" : "Archived", "dim"] : p.needsSummary ? ["Changes pending", "warn"] : ["Up to date", "ok"];
  const result = ctx?.results?.[0];
  return (
    <article className="card lit">
      <div className="row">
        <h3 style={{ margin: 0 }}>{p.name}</h3>
        <span className={`badge ${status[1]}`} style={{ marginLeft: "auto" }}>{status[0]}</span>
      </div>
      {scanning && <div className="scan"><i /></div>}
      <p className="muted" style={{ margin: "10px 0" }}>{ctx?.summary || "Not summarized yet."}</p>
      <div className="list" style={{ gap: 4 }}>
        <div><b style={{ fontWeight: 600 }}>Your part:</b> <span style={{ color: "var(--t2)" }}>{ctx?.contribution || "Not established yet"}</span></div>
        {result && <div><b style={{ fontWeight: 600 }}>Result:</b> <span style={{ color: "var(--t2)" }}>{result.claim}</span>{result.confidence === "low" && <span className="badge warn" style={{ marginLeft: 6 }}>unverified</span>}</div>}
      </div>
      <div className="chips" style={{ margin: "12px 0" }}>
        {(result?.evidence ?? ctx?.shareableMaterial?.map((m: any) => m.ref) ?? []).slice(0, 4).map((e: string) => <span className="chip" key={e}>{e}</span>)}
        {detail && <span className="chip">{detail.files?.indexed ?? 0} files indexed</span>}
        {ctx && <span className="chip">v{ctx.version} · {ctx.method}</span>}
      </div>
      <div className="list">{(detail?.openQuestions ?? []).map((q: any) => <Question key={q.id} q={q} projectId={p.id} />)}</div>
      <div className="opp-actions" style={{ marginTop: 12 }}>
        <button className="btn ghost" onClick={() => act(() => api("PATCH", `/projects/${p.id}`, { status: p.status === "active" ? "paused" : "active" }), p.status === "active" ? "Project paused." : "Project resumed.")}>
          {p.status === "active" ? "Pause" : "Resume"}
        </button>
        <button className="btn" disabled={scanning} onClick={rescan}>Rescan</button>
      </div>
    </article>
  );
}

export function Projects() {
  const ctx = useCtx();
  const projects = useApi<any[]>("/projects");
  const [over, setOver] = useState(false);
  const add = () => void addProjectFolder(ctx);
  return (
    <div className="sheet glass lit">
      {projects.error && <div className="err">{projects.error}</div>}
      <div className="grid cols-2">
        {(projects.data ?? []).map((p) => <ProjectCard key={p.id} p={p} />)}
        <button
          className={`drop ${over ? "over" : ""}`}
          onClick={add}
          onDragEnter={(e) => (e.preventDefault(), setOver(true))}
          onDragOver={(e) => (e.preventDefault(), setOver(true))}
          onDragLeave={() => setOver(false)}
          // Browsers hide dropped folder paths, so a drop opens the native picker.
          onDrop={(e) => (e.preventDefault(), setOver(false), add())}
        >
          <div>
            <b>Add a Project Folder</b>
            <div className="muted">Opens a Finder dialog on this Mac</div>
          </div>
        </button>
      </div>
    </div>
  );
}
