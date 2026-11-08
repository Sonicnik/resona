import { useState } from "react";
import { api, shortDate, useApi, useCtx } from "../api";

const CREDS: Record<string, { title: string; why: string; url: string; placeholder: string }> = {
  anthropic: {
    title: "Claude",
    why: "Summaries, drafts and fit checks for folders where you allow AI. Without it, the app works offline with templates.",
    url: "https://platform.claude.com/settings/keys",
    placeholder: "sk-ant-…",
  },
  github: { title: "GitHub", why: "Optional. Raises the GitHub search rate limit for Find Conversations.", url: "https://github.com/settings/personal-access-tokens", placeholder: "github_pat_…" },
  x: { title: "X", why: "Optional. Enables X recent search. Needs an X developer app; platform costs apply.", url: "https://developer.x.com/en/portal/dashboard", placeholder: "Bearer token" },
};

/** Paste-once credential sheet. The value goes to the local backend, which stores it in the macOS Keychain. */
export function ConnectSheet({ name, onClose }: { name: string; onClose: () => void }) {
  const { act } = useCtx();
  const c = CREDS[name];
  const [value, setValue] = useState("");
  const save = async () => {
    const v = value;
    setValue(""); // never keep the secret in UI state longer than the request
    const r = await act(() => api("PUT", `/credentials/${name}`, { value: v }), `${c.title} connected. The key is stored in your macOS Keychain.`);
    if (r) onClose();
  };
  return (
    <div className="sheet-modal" onClick={(e) => e.target === e.currentTarget && onClose()} role="dialog" aria-modal="true" aria-label={`Connect ${c.title}`}>
      <div className="glass thick">
        <h2 style={{ fontSize: 17 }}>Connect {c.title}</h2>
        <p className="muted">{c.why}</p>
        <ol className="muted" style={{ paddingLeft: 18, display: "grid", gap: 4 }}>
          <li>Open the key page and sign in there with your own account.</li>
          <li>Create a personal key and copy it.</li>
          <li>Paste it below. It is stored in the macOS Keychain on this Mac, never in the project, database or Git.</li>
        </ol>
        <button className="btn" onClick={() => window.open(c.url, "_blank", "noopener")}>Open Key Page</button>
        <input className="field" type="password" autoComplete="off" spellCheck={false} placeholder={c.placeholder} value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && value.trim().length >= 8 && save()} aria-label={`${c.title} key`} />
        <div className="opp-actions">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={value.trim().length < 8} onClick={save}>Save to Keychain</button>
        </div>
      </div>
    </div>
  );
}

function Switch({ checked, label, onChange }: { checked: boolean; label: string; onChange: (v: boolean) => void }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} aria-label={label} onChange={(e) => onChange(e.target.checked)} />
      <span />
    </label>
  );
}

function Exclusions({ p }: { p: any }) {
  const { act } = useCtx();
  const [add, setAdd] = useState("");
  const save = (exclusions: string[]) => act(() => api("PATCH", `/projects/${p.id}`, { exclusions }), "Exclusions updated. Excluded files are removed from the index.");
  return (
    <div className="chips" style={{ marginTop: 6, alignItems: "center" }}>
      <span className="chip" title="Credentials, dependencies, build output, temp files and .gitignore are always excluded">Defaults + .gitignore</span>
      {p.exclusions.map((x: string) => (
        <button className="chip" key={x} title="Remove" onClick={() => save(p.exclusions.filter((e: string) => e !== x))}>{x} ×</button>
      ))}
      <input className="field" style={{ width: 150, height: 22, fontSize: 11.5 }} placeholder="Exclude, e.g. drafts/" value={add} onChange={(e) => setAdd(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && add.trim()) { save([...p.exclusions, add.trim()]); setAdd(""); } }} />
    </div>
  );
}

const SCHEDULES: Array<[string, string]> = [
  ["schedule.discovery.enabled", "Daily automatic discovery (sends project keywords to search APIs)"],
  ["schedule.weeklyReview.enabled", "Weekly review"],
  ["schedule.vaultSync.enabled", "Sync the Markdown vault every 10 minutes"],
  ["ai.disabled", "Offline mode: no model calls at all"],
];

export function Privacy({ onConnect }: { onConnect: (name: string) => void }) {
  const { act, status } = useCtx();
  const projects = useApi<any[]>("/projects");
  const history = useApi<any[]>("/processing-history?limit=50");
  const creds = useApi<any[]>("/credentials");
  const settings = useApi<Record<string, boolean>>("/settings");
  const names = new Map((projects.data ?? []).map((p) => [p.id, p.name]));
  return (
    <div className="sheet glass lit">
      <div className="section-title" style={{ marginTop: 0 }}>AI processing per folder</div>
      <div className="list">
        {(projects.data ?? []).map((p) => (
          <div className="item" key={p.id}>
            <div className="grow">
              <b>{p.name}</b>
              <div className="muted" title={p.folderPath} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.folderPath}</div>
              <Exclusions p={p} />
            </div>
            <span className="muted">Allow AI processing</span>
            <Switch checked={p.aiPermission === "allowed"} label={`Allow AI processing for ${p.name}`}
              onChange={(v) => act(() => api("PATCH", `/projects/${p.id}`, { aiPermission: v ? "allowed" : "denied" }), v ? `Selected excerpts from ${p.name} may now be sent to Claude.` : `Nothing from ${p.name} will be sent to a model.`)} />
          </div>
        ))}
        {projects.data && !projects.data.length && <div className="empty">No folders yet.</div>}
      </div>

      <div className="section-title">Accounts and keys</div>
      <div className="list">
        {(creds.data ?? []).map((c) => (
          <div className="item" key={c.name}>
            <div className="grow">
              <b>{CREDS[c.name].title}</b>
              <div className="muted">{c.connected ? `Connected · ${c.hint} · stored in your macOS Keychain` : CREDS[c.name].why}</div>
            </div>
            {c.connected ? (
              <button className="btn" onClick={() => act(() => api("DELETE", `/credentials/${c.name}`), `${CREDS[c.name].title} disconnected and removed from the Keychain.`)}>Disconnect</button>
            ) : (
              <button className={`btn ${c.name === "anthropic" ? "primary" : ""}`} onClick={() => onConnect(c.name)}>Connect</button>
            )}
          </div>
        ))}
      </div>

      <div className="section-title">Background work</div>
      <div className="list">
        {SCHEDULES.map(([key, label]) => (
          <div className="item" key={key}>
            <div className="grow">{label}</div>
            <Switch checked={Boolean(settings.data?.[key])} label={label} onChange={(v) => act(() => api("PATCH", "/settings", { [key]: v }))} />
          </div>
        ))}
      </div>

      <div className="section-title">What left this Mac</div>
      <div className="card" style={{ padding: 4, overflowX: "auto" }}>
        <table className="log">
          <thead>
            <tr><th>When</th><th>Folder</th><th>What was sent</th><th>To</th><th>Status</th></tr>
          </thead>
          <tbody>
            {(history.data ?? []).map((h) => (
              <tr key={h.id}>
                <td>{shortDate(h.created_at)} {new Date(h.created_at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}</td>
                <td>{names.get(h.project_id) ?? "—"}</td>
                <td title={h.input_refs.join("\n")}>{h.purpose.replace(/_/g, " ")}: {h.input_refs.slice(0, 2).join(", ")}{h.input_refs.length > 2 ? ` +${h.input_refs.length - 2}` : ""} ({h.input_chars} chars)</td>
                <td>{h.model ?? "Model provider"}</td>
                <td>{h.status}</td>
              </tr>
            ))}
            {history.data && !history.data.length && (
              <tr><td colSpan={5}>Nothing has been sent to a model provider yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="muted" style={{ marginTop: 14 }}>
        Database: {status?.storage?.database} · Vault: {status?.storage?.vault}
      </p>
    </div>
  );
}
