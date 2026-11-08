import { useState } from "react";
import { ago, api, CHANNEL, initials, platformName, shortDate, useApi, useCtx } from "../api";
import { DraftEditor } from "../DraftEditor";

/** Where to paste a reply: the post itself for public replies, otherwise the person's profile. */
const openUrlFor = (opp: any) => opp.post?.url ?? null;

function OppCard({ opp, draft }: { opp: any; draft?: any }) {
  const { act, openPerson, notify } = useCtx();
  const restore = () => act(() => api("PATCH", `/opportunities/${opp.id}`, { state: "new" }), "Opportunity restored.");
  const dismiss = () => act(() => api("PATCH", `/opportunities/${opp.id}`, { state: "dismissed" }), () => notify("Opportunity dismissed.", restore));
  const write = () => act(() => api("POST", `/opportunities/${opp.id}/drafts`, {}), (d: any) => (d.meta?.aiError ? `Template draft (AI unavailable: ${d.meta.aiError})` : "Draft ready. Edit it, then approve."));
  const assess = () =>
    act(
      () => api("POST", `/opportunities/${opp.id}/assess`),
      (r: any) => (r.fits ? `Claude confirmed the fit: ${r.reason}` : `Claude thinks the project doesn't fit, so it was dismissed: ${r.reason}`),
    );

  const left = (
    <>
      <button className="btn ghost" onClick={dismiss}>Dismiss</button>
      {opp.personId && <button className="btn" onClick={() => openPerson(opp.personId, true)}>View Person</button>}
    </>
  );
  return (
    <article className="card opp lit">
      <div className="row">
        <div className="avatar">{initials(opp.personName)}</div>
        <div>
          <b>{opp.personName ?? "Unknown author"}</b>
          <div className="muted">
            {platformName(opp.post?.platform)} · {opp.projectName} · {ago(opp.post?.publishedAt)}
          </div>
        </div>
        <span className="score">{Math.round(opp.relevance * 100)}%</span>
      </div>
      <div className="post">
        {opp.situation?.headline && <div className="sit-head">{opp.situation.headline}</div>}
        <div title={opp.situation?.source === "ai" ? "Summarized by AI" : "Key sentence from the post"}>{opp.situation?.gist ?? opp.post?.text}</div>
      </div>
      <div className="sit-links">
        {opp.post?.url && <a href={opp.post.url} target="_blank" rel="noreferrer">Open on {platformName(opp.post.platform) || "the web"} ↗</a>}
        <details>
          <summary>Full text</summary>
          <div className="full-text">{opp.post?.text}</div>
        </details>
      </div>
      <div className="why" title={opp.matchReason}>
        <strong>Why you:</strong> {opp.why ?? opp.matchReason}
      </div>
      <div className="chips">
        {(opp.evidence ?? []).slice(0, 2).map((e: any) => (
          <span className="chip" key={e.ref} title={e.excerpt}>{e.ref}</span>
        ))}
        <span className="chip">{CHANNEL[opp.suggestedChannel] ?? opp.suggestedChannel}</span>
        {(opp.flags ?? []).map((f: string) => (
          <span className="badge warn" key={f}>{f}</span>
        ))}
      </div>
      {draft ? (
        <DraftEditor draft={draft} label={`Draft for ${opp.personName}`} destination={opp.post?.url ?? opp.personName ?? "post"} openUrl={openUrlFor(opp)} left={left} />
      ) : (
        <div className="opp-actions">
          <span className="badge" style={{ marginRight: "auto" }}>New</span>
          {left}
          <button className="btn" onClick={assess}>Check Fit with AI</button>
          <button className="btn primary" onClick={write}>Draft Reply</button>
        </div>
      )}
    </article>
  );
}

function FollowupCard({ fu, draft }: { fu?: any; draft?: any }) {
  const { act, openPerson } = useCtx();
  const personId = draft?.personId ?? fu?.person_id;
  const person = useApi<any>(`/people/${personId}`).data;
  const name = person?.person.displayName ?? "…";
  // Paste a follow-up where the last conversation happened, else on their first profile.
  const platform = draft?.platform ?? person?.interactions[0]?.platform;
  const profileUrl = (person?.profiles.find((p: any) => p.platform === platform) ?? person?.profiles[0])?.url ?? null;
  const left = (
    <>
      {fu && <button className="btn ghost" onClick={() => act(() => api("PATCH", `/followups/${fu.id}`, { state: "done" }), "Follow-up marked done.")}>Done</button>}
      <button className="btn" onClick={() => openPerson(personId, true)}>View Person</button>
    </>
  );
  return (
    <article className="card opp lit">
      <div className="row">
        <div className="avatar">{initials(name)}</div>
        <div>
          <b>{name}</b>
          <div className="muted">{fu?.reason ?? draft?.meta?.followupReason ?? "Follow-up"}</div>
        </div>
        {fu?.due_at && <span className={`badge ${Date.parse(fu.due_at) < Date.now() ? "warn" : "dim"}`} style={{ marginLeft: "auto" }}>{shortDate(fu.due_at)}</span>}
      </div>
      {draft ? (
        <DraftEditor draft={draft} label={`Follow-up for ${name}`} destination={profileUrl ?? name} openUrl={profileUrl} left={left} />
      ) : (
        <div className="opp-actions">
          {left}
          <button className="btn primary" onClick={() => act(() => api("POST", `/people/${personId}/drafts`, { reason: fu?.reason }), "Follow-up draft ready.")}>Draft Follow-up</button>
        </div>
      )}
    </article>
  );
}

function AddPost({ onClose }: { onClose: () => void }) {
  const { act } = useCtx();
  const [f, setF] = useState({ platform: "linkedin", url: "", text: "", name: "", profile: "" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = async () => {
    const r = await act(
      () =>
        api("POST", "/source-posts", {
          platform: f.platform,
          url: f.url || undefined,
          text: f.text,
          author: f.name ? { displayName: f.name, url: f.profile || undefined } : undefined,
          match: true,
        }),
      (r: any) => (r.opportunities.length ? `Saved. ${r.opportunities.length} matching opportunit${r.opportunities.length === 1 ? "y" : "ies"} found.` : "Saved, but none of your projects is a strong match."),
    );
    if (r) onClose();
  };
  return (
    <div className="card form" style={{ marginBottom: 14 }}>
      <h3>Add a conversation you found</h3>
      <div className="row">
        <select className="field" style={{ width: 140 }} value={f.platform} onChange={set("platform")} aria-label="Platform">
          {["linkedin", "x", "github", "hackernews"].map((p) => <option key={p} value={p}>{platformName(p)}</option>)}
        </select>
        <input className="field" placeholder="Post URL" value={f.url} onChange={set("url")} />
      </div>
      <div className="row">
        <input className="field" placeholder="Author name" value={f.name} onChange={set("name")} />
        <input className="field" placeholder="Author profile URL" value={f.profile} onChange={set("profile")} />
      </div>
      <textarea placeholder="Paste the post text" value={f.text} onChange={set("text")} />
      <div className="opp-actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={f.text.trim().length < 10} onClick={submit}>Save and Match</button>
      </div>
    </div>
  );
}

export function Opportunities({ filter }: { filter: string }) {
  const { scan, scanning } = useCtx();
  const [adding, setAdding] = useState(false);
  const opps = useApi<any[]>("/opportunities?limit=100");
  const drafts = useApi<any[]>("/drafts?kind=outreach");
  const followups = useApi<any[]>("/followups?state=open");
  const byOpp = new Map((drafts.data ?? []).filter((d) => d.opportunityId).map((d) => [d.opportunityId, d]));

  if (filter === "followups") {
    const followDrafts = (drafts.data ?? []).filter((d) => !d.opportunityId && d.personId && d.status === "active");
    const draftedPeople = new Set(followDrafts.map((d) => d.personId));
    const pending = (followups.data ?? []).filter((f) => !draftedPeople.has(f.person_id));
    return (
      <div className="sheet glass lit">
        {!followDrafts.length && !pending.length && <div className="empty">No follow-ups due. Draft one from a person in the Network.</div>}
        <div className="grid cols-2">
          {followDrafts.map((d) => (
            <FollowupCard key={d.id} draft={d} fu={(followups.data ?? []).find((f) => f.person_id === d.personId)} />
          ))}
          {pending.map((f) => (
            <FollowupCard key={f.id} fu={f} />
          ))}
        </div>
      </div>
    );
  }

  const list = (opps.data ?? []).filter((o) => ["new", "shortlisted"].includes(o.state) && (filter === "all" || o.projectId === filter));
  return (
    <div className="sheet glass lit">
      <div className="toolbar-row">
        <button className="btn" onClick={() => setAdding(!adding)}>Add Post</button>
        <button className="btn primary" disabled={scanning} onClick={() => void scan()}>{scanning ? "Scanning…" : "Scan for Opportunities"}</button>
        <span className="muted">LinkedIn search isn't authorized yet; paste LinkedIn posts with Add Post.</span>
      </div>
      {adding && <AddPost onClose={() => setAdding(false)} />}
      {opps.error && <div className="err">{opps.error}</div>}
      {opps.data && !list.length && <div className="empty">No open opportunities. Add a post you found, or press Scan for Opportunities.</div>}
      <div className="grid cols-2">
        {list.map((o) => (
          <OppCard key={o.id} opp={o} draft={byOpp.get(o.id)} />
        ))}
      </div>
    </div>
  );
}
