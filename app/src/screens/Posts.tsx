import { useEffect, useState } from "react";
import { api, ApiError, useApi, useCtx } from "../api";
import { DraftEditor } from "../DraftEditor";

const COMPOSE: Record<string, string> = { linkedin: "https://www.linkedin.com/feed/?shareActive=true", x: "https://x.com/compose/post" };

export function Posts({ platform, projectHint }: { platform: "linkedin" | "x"; projectHint?: string | null }) {
  const { act, bump, notify } = useCtx();
  const projects = useApi<any[]>("/projects?kind=project");
  const drafts = useApi<any[]>("/drafts?kind=post");
  const me = useApi<any>("/me");
  const [projectId, setProjectId] = useState<string>("");
  const [selected, setSelected] = useState<string | null>(null);
  const [declined, setDeclined] = useState<{ projectId: string; reason: string } | null>(null);
  const [preview, setPreview] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (projectHint) setProjectId(projectHint);
  }, [projectHint]);
  const pid = projectId || projects.data?.[0]?.id || "";
  const list = (drafts.data ?? []).filter((d) => d.platform === platform && d.status === "active");
  const draft = list.find((d) => d.id === selected) ?? list[0];

  const create = async (force = false) => {
    setBusy(true);
    try {
      const d = await api("POST", `/projects/${pid}/post-drafts`, { platform, force });
      setDeclined(null);
      setSelected(d.id);
      bump();
      notify(d.revision.author === "ai" ? "Post drafted from your latest project context." : "Template post drafted. Fill in the [placeholders].");
    } catch (e) {
      if (e instanceof ApiError && e.details?.worthPosting === false) setDeclined({ projectId: pid, reason: e.message });
      else notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const notWorth = () =>
    act(() => api("DELETE", `/drafts/${draft.id}`), () => {
      setSelected(null);
      return "Draft archived. Not every change needs a post.";
    });

  const projectName = (id: string) => projects.data?.find((p) => p.id === id)?.name ?? "project";
  return (
    <div className="sheet glass lit">
      <div className="toolbar-row">
        <select className="field" style={{ width: 200 }} value={pid} onChange={(e) => setProjectId(e.target.value)} aria-label="Project">
          {(projects.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <button className="btn primary" disabled={!pid || busy} onClick={() => create()}>{busy ? "Drafting…" : "Draft Post"}</button>
        {list.length > 1 &&
          list.map((d) => (
            <button key={d.id} className="chip" aria-pressed={d.id === draft?.id} style={d.id === draft?.id ? { borderColor: "var(--accent-hi)" } : undefined} onClick={() => setSelected(d.id)}>
              {d.revision?.title || projectName(d.projectId)}
            </button>
          ))}
      </div>
      {declined && declined.projectId === pid && (
        <div className="q" style={{ marginBottom: 14 }}>
          <span className="grow">Not worth posting yet: {declined.reason}</span>
          <button className="btn" onClick={() => create(true)}>Draft Anyway</button>
        </div>
      )}
      {!draft ? (
        <div className="empty">No {platform === "x" ? "X" : "LinkedIn"} post drafts. Pick a project and press Draft Post.</div>
      ) : (
        <div className="grid cols-2">
          <div className="card">
            <div className="row" style={{ marginBottom: 10 }}>
              <h3 style={{ margin: 0 }}>{draft.revision?.title || "Post draft"}</h3>
              <span className="badge" style={{ marginLeft: "auto" }}>From {projectName(draft.projectId)}</span>
            </div>
            <DraftEditor
              key={draft.id}
              draft={draft}
              rows={10}
              label="Post draft"
              destination={`${platform} feed`}
              openUrl={COMPOSE[platform]}
              limit={platform === "x" ? 280 : 3000}
              onText={setPreview}
              left={<button className="btn ghost" onClick={notWorth}>Not Worth Posting</button>}
            >
              <div className="chips" style={{ marginTop: 10 }}>
                {(draft.revision?.sourceRefs ?? []).map((r: string) => <span className="chip" key={r}>{r}</span>)}
                {(draft.meta?.cautions ?? []).map((c: string) => <span className="badge warn" key={c}>{c}</span>)}
              </div>
            </DraftEditor>
          </div>
          <div>
            <div className="section-title" style={{ marginTop: 0 }}>Preview</div>
            <div className={`preview ${platform === "x" ? "x" : ""}`}>
              <div className="pv-head">
                <div className="pv-av" />
                <div>
                  <div className="pv-name">{me.data?.displayName ?? "You"}</div>
                  <div className="pv-meta">{platform === "x" ? "@you · now" : `${me.data?.title ?? ""} · now`}</div>
                </div>
              </div>
              <p>{preview}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
