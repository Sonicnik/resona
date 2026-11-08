import { initials, shortDate, useApi, useCtx } from "../api";

function ProjectChange({ p, onDraftPost }: { p: any; onDraftPost: (id: string) => void }) {
  const { go } = useCtx();
  const d = useApi<any>(`/projects/${p.id}`).data;
  const q = d?.openQuestions?.[0];
  const line = q ? q.question : p.needsSummary ? "Files changed since the last summary." : d?.context?.summary ?? "Scanning…";
  return (
    <div className="item">
      <div className="grow">
        <b>{p.name}</b>
        <div className="muted">{line}</div>
      </div>
      {q ? <button className="btn" onClick={() => go("projects")}>Answer</button> : <button className="btn" onClick={() => onDraftPost(p.id)}>Draft Post</button>}
    </div>
  );
}

export function Home({ onDraftPost, onOpenReview }: { onDraftPost: (projectId: string) => void; onOpenReview: () => void }) {
  const { status, go, openPerson, scan, scanning } = useCtx();
  const recs = useApi<any>("/network/recommendations?limit=6");
  const projects = useApi<any[]>("/projects?kind=project");
  const posts = useApi<any[]>("/drafts?kind=post");
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const followups = recs.data?.followups ?? [];
  const reconnect = recs.data?.reconnect ?? [];
  const metrics: Array<[string, number | undefined]> = [
    ["New opportunities", status?.counts?.openOpportunities],
    ["Follow-ups due", followups.length],
    ["Post drafts", posts.data?.filter((d) => d.status === "active").length],
    ["Questions for you", status?.counts?.openQuestions],
  ];
  return (
    <div className="sheet glass lit">
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", marginBottom: 18 }}>
        <div>
          <h2 className="greeting">{greeting}</h2>
          <p className="sub">Nothing is sent without your approval.</p>
        </div>
        <div className="row">
          <button className="btn" onClick={onOpenReview}>Weekly Review</button>
          <button className="btn" disabled={scanning} onClick={() => void scan()}>{scanning ? "Scanning…" : "Scan for Opportunities"}</button>
          <button className="btn primary" onClick={() => go("opps")}>Review Opportunities</button>
        </div>
      </div>
      <div className="grid cols-4">
        {metrics.map(([label, n]) => (
          <div className="card metric lit" key={label}>
            <span>{label}</span>
            <b>{n ?? "–"}</b>
          </div>
        ))}
      </div>
      <div className="grid cols-2" style={{ marginTop: 4 }}>
        <div>
          <div className="section-title">Follow-ups due</div>
          <div className="list">
            {followups.map((f: any) => (
              <button className="item" key={f.followupId} style={{ textAlign: "left" }} onClick={() => openPerson(f.personId, true)}>
                <div className="avatar">{initials(f.personName)}</div>
                <div className="grow">
                  <b>{f.personName}</b>
                  <div className="muted">{f.reason}</div>
                </div>
                <span className={`badge ${f.overdue ? "warn" : "dim"}`}>{shortDate(f.dueAt)}</span>
              </button>
            ))}
            {reconnect.slice(0, 3).map((r: any) => (
              <button className="item" key={`rc-${r.personId}`} style={{ textAlign: "left" }} onClick={() => openPerson(r.personId, true)}>
                <div className="avatar">{initials(r.personName)}</div>
                <div className="grow">
                  <b>{r.personName}</b>
                  <div className="muted">Reconnect: {r.reason}</div>
                </div>
              </button>
            ))}
            {recs.data && !followups.length && !reconnect.length && <div className="empty">No follow-ups due this week.</div>}
          </div>
        </div>
        <div>
          <div className="section-title">What changed in your projects</div>
          <div className="list">
            {(projects.data ?? []).map((p) => <ProjectChange key={p.id} p={p} onDraftPost={onDraftPost} />)}
            {projects.data && !projects.data.length && (
              <button className="drop" onClick={() => go("projects")}><div><b>Add your first project folder</b><div className="muted">The agent learns from your work</div></div></button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
