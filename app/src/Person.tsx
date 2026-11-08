import { useEffect, useState } from "react";
import { api, CHANNEL, initials, platformName, shortDate, useApi, useCtx } from "./api";
import { OpenPost } from "./screens/Opportunities";

const EVENT: Record<string, [string, string]> = {
  discovered: ["Discovered", "#5a5a5a"],
  draft: ["Draft waiting", "#d29922"],
  approved: ["Approved by you", "#a1a1a1"],
  sent: ["Sent", "#d4d4d4"],
  replied: ["Replied", "#3fb950"],
  connected: ["Connected", "#3b8eea"],
};

/** Approved, sent, replied and connected stay separate events, as the product requires. */
function timeline(d: any): Array<[string, string, string]> {
  const ev: Array<[string, string, string]> = [];
  for (const p of d.discoveredVia ?? []) ev.push(["discovered", `Found via their ${platformName(p.platform)} post`, p.published_at ?? p.retrieved_at]);
  // Sent drafts show up below as outbound interactions (mark-sent records one).
  for (const dr of d.drafts ?? []) {
    if (dr.action_state === "approved") ev.push(["approved", `You approved a ${CHANNEL[dr.channel]?.toLowerCase() ?? "message"}. Not sent yet.`, dr.updated_at]);
    else if (dr.action_state !== "sent") ev.push(["draft", "Draft waiting in Opportunities", dr.updated_at]);
  }
  for (const i of d.interactions ?? []) {
    const text = String(i.body ?? i.subject ?? i.type).slice(0, 120);
    if (i.direction === "outbound") ev.push(["sent", `${platformName(i.platform)} ${i.type}: ${text}`, i.occurred_at]);
    else if (i.direction === "inbound") ev.push(["replied", `${platformName(i.platform)} ${i.type}: ${text}`, i.occurred_at]);
  }
  for (const c of d.connectionStatus?.platformConnections ?? []) ev.push(["connected", `Connection ${c.platform ? "on " + platformName(c.platform) : "recorded"} (${c.source.replace(/_/g, " ")})`, c.since]);
  return ev.filter((e) => e[2]).sort((a, b) => a[2].localeCompare(b[2]));
}

export function Person({ id, names, onClose, onDraftedFollowup }: { id: string | null; names: Map<string, string>; onClose: () => void; onDraftedFollowup: () => void }) {
  const { act } = useCtx();
  const d = useApi<any>(id ? `/people/${id}` : null).data;
  const cur = d && d.person.id === id ? d : null;
  const paths = useApi<any[]>(cur && !cur.connectionStatus.platformConnections.length ? `/people/${id}/paths?k=1` : null).data;
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => setNote(null), [id]);

  const cs = cur?.connectionStatus;
  const badge = !cs ? null : cs.platformConnections.length ? ["Connected", "ok"] : cs.sentByYou || cs.repliesReceived ? ["In conversation", ""] : ["Not contacted", "dim"];
  const known = (cur?.relationships ?? [])
    .map((r: any) => ({ other: r.from === id ? r.to : r.from, why: r.evidence?.[0]?.evidence ?? r.explanation }))
    .filter((r: any) => names.has(r.other) && names.get(r.other) !== "You");
  const fu = cur?.followups?.find((f: any) => f.state === "open");
  const draftFollowup = () => act(() => api("POST", `/people/${id}/drafts`, { reason: fu?.reason }), () => (onDraftedFollowup(), "Follow-up draft ready in Opportunities → Follow-ups."));
  const saveNote = () => act(() => api("PATCH", `/people/${id}`, { notes: note }), () => (setNote(null), "Note saved. It also appears in their vault note."));
  const path = paths?.[0];

  return (
    <aside id="person" className={`glass thick lit ${id ? "open" : ""}`} aria-label="Person inspector" aria-hidden={!id}>
      <button className="panel-close" onClick={onClose} aria-label="Close inspector">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
      {cur && (
        <div>
          <div className="row" style={{ paddingRight: 30 }}>
            <div className="avatar lg">{initials(cur.person.displayName)}</div>
            <div>
              <h2 style={{ fontSize: 18 }}>{cur.person.displayName}</h2>
              <div className="muted">{[cur.person.title, cur.person.organization].filter(Boolean).join(" · ")}</div>
            </div>
          </div>
          <div className="chips" style={{ marginTop: 12 }}>
            {cur.profiles.map((p: any) => (
              <a className="chip" key={p.id} href={p.url ?? undefined} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>{platformName(p.platform)}</a>
            ))}
            {badge && <span className={`badge ${badge[1]}`}>{badge[0]}</span>}
          </div>

          {!cur.person.isSelf && (
            <label className="industry-pick">
              <span>Group</span>
              <select
                className="field"
                aria-label="Industry group"
                value={cur.metrics?.industry?.source === "user" ? cur.metrics.industry.id : ""}
                onChange={(e) =>
                  act(() => api("PATCH", `/people/${id}`, { industry: e.target.value || null }), e.target.value ? "Group updated. The network filter uses it now." : "Group set back to automatic.")
                }
              >
                <option value="">
                  {cur.metrics?.industry?.source === "inferred" ? `Automatic: ${cur.metrics.industry.name}` : "Automatic"}
                </option>
                {(cur.industries ?? []).map((i: any) => (
                  <option key={i.id} value={i.id}>{i.name}</option>
                ))}
              </select>
            </label>
          )}

          <div className="panel-section">
            <h3>How you found them</h3>
            <p style={{ color: "var(--t2)" }}>
              {cur.discoveredVia[0] ? `“${String(cur.discoveredVia[0].text).slice(0, 180)}”` : cur.profiles[0]?.source === "linkedin_archive" ? "Imported from your LinkedIn archive." : "Added by you."}
            </p>
            {cur.discoveredVia[0] && <div style={{ marginTop: 8 }}><OpenPost url={cur.discoveredVia[0].url} platform={cur.discoveredVia[0].platform} /></div>}
          </div>

          {cur.sharedInterests.length > 0 && (
            <div className="panel-section">
              <h3>Shared interests</h3>
              <div className="list">
                {cur.sharedInterests.map((s: any) => (
                  <div className="item" style={{ padding: "8px 10px" }} key={s.projectId}>
                    <div className="grow">
                      <b style={{ fontWeight: 500 }}>{s.sharedKeywords.slice(0, 4).join(", ") || s.projectName}</b>
                      <div className="muted">Evidence: {s.establishedBy.join(" · ")} · {s.projectName}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {cur.projects.length > 0 && (
            <div className="panel-section">
              <h3>Projects</h3>
              <div className="chips">{cur.projects.map((p: any) => <span className="chip" key={p.projectId} title={p.evidence?.map((e: any) => e.ref).join(", ")}>{p.name}</span>)}</div>
            </div>
          )}

          {known.length > 0 && (
            <div className="panel-section">
              <h3>Known connections</h3>
              <div className="list">{known.map((k: any) => <div className="muted" key={k.other}>{names.get(k.other)}: {k.why}</div>)}</div>
            </div>
          )}

          {path && path.people?.length > 2 && (
            <div className="panel-section">
              <h3>Warm introduction</h3>
              <div className="muted">
                {path.people.map((p: any) => (typeof p === "string" ? names.get(p) ?? p : p.label ?? p.name)).join(" → ")} · warmth {Math.round(path.warmth * 100)}%
              </div>
            </div>
          )}

          <div className="panel-section">
            <h3>History</h3>
            <div className="timeline">
              {timeline(cur).map(([k, text, date], i) => (
                <div className="tl" key={i} style={{ ["--c" as string]: EVENT[k][1] }}>
                  <b>{EVENT[k][0]}</b> <span className="muted">· {shortDate(date)}</span>
                  <div className="muted">{text}</div>
                </div>
              ))}
            </div>
          </div>

          {fu && (
            <div className="panel-section">
              <h3>Next follow-up</h3>
              <div className="followup">{fu.reason}{fu.due_at ? ` · due ${shortDate(fu.due_at)}` : ""}</div>
            </div>
          )}

          {(note !== null || cur.person.notes) && (
            <div className="panel-section">
              <h3>Notes</h3>
              {note === null ? <p style={{ color: "var(--t2)", whiteSpace: "pre-wrap" }}>{cur.person.notes}</p> : <textarea autoFocus value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />}
            </div>
          )}

          <div className="opp-actions" style={{ marginTop: 20 }}>
            {note === null ? <button className="btn" onClick={() => setNote(cur.person.notes ?? "")}>{cur.person.notes ? "Edit Note" : "Add Note"}</button> : <button className="btn" onClick={saveNote}>Save Note</button>}
            <button className="btn primary" onClick={draftFollowup}>Draft Follow-up</button>
          </div>
        </div>
      )}
    </aside>
  );
}
