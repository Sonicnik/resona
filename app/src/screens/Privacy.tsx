import { useEffect, useState } from "react";
import { api, shortDate, useApi, useCtx } from "../api";

const CREDS: Record<string, { title: string; why: string; url: string; placeholder: string }> = {
  anthropic: {
    title: "Claude",
    why: "Summaries, drafts and fit checks for folders where you allow AI. Without it, the app works offline with templates.",
    url: "https://platform.claude.com/settings/keys",
    placeholder: "sk-ant-…",
  },
  github: { title: "GitHub", why: "Optional. Raises the GitHub search rate limit when scanning for opportunities.", url: "https://github.com/settings/personal-access-tokens", placeholder: "github_pat_…" },
  x: { title: "X", why: "Optional. Enables X recent search. Needs an X developer app; platform costs apply.", url: "https://developer.x.com/en/portal/dashboard", placeholder: "Bearer token" },
};

/** Paste-once credential sheet. The value goes to the local backend, which stores it in the macOS Keychain. */
export function ConnectSheet({ name, onClose }: { name: string; onClose: () => void }) {
  const { bump, notify } = useCtx();
  const c = CREDS[name];
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("PUT", `/credentials/${name}`, { value });
      setValue(""); // drop the secret from UI state as soon as it is stored
      bump();
      notify(`${c.title} connected. The key is stored in your macOS Keychain.`);
      onClose();
    } catch (e) {
      setError((e as Error).message); // keep the field so a paste mistake can be fixed
    } finally {
      setBusy(false);
    }
  };
  const ready = value.trim().length >= 8 && !busy;
  return (
    <div className="sheet-modal" onClick={(e) => e.target === e.currentTarget && onClose()} role="dialog" aria-modal="true" aria-label={`Connect ${c.title}`}>
      <div className="glass thick">
        <h2 style={{ fontSize: 17 }}>Connect {c.title}</h2>
        <p className="muted">{c.why}</p>
        <ol className="muted" style={{ paddingLeft: 18, display: "grid", gap: 4 }}>
          <li>Open the key page and sign in there with your own account.</li>
          <li>Create {name === "anthropic" ? "an API key (it starts with sk-ant-api)" : "a personal token"} and copy it.</li>
          <li>Paste it below. It is stored in the macOS Keychain on this Mac, never in the project, database or Git.</li>
        </ol>
        {name === "anthropic" && (
          <p className="muted">A Claude Pro or Max subscription can't be used here: Anthropic only lets other apps use API keys from the Claude Console, which bills API usage separately.</p>
        )}
        <button className="btn" onClick={() => window.open(c.url, "_blank", "noopener")}>Open Key Page</button>
        <input className="field" type="password" autoComplete="off" spellCheck={false} placeholder={c.placeholder} value={value}
          onChange={(e) => (setValue(e.target.value), setError(null))} onKeyDown={(e) => e.key === "Enter" && ready && save()} aria-label={`${c.title} key`} aria-invalid={Boolean(error)} aria-describedby="connect-error" />
        {error && <div className="err" id="connect-error" role="alert">{error}</div>}
        <div className="opp-actions">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!ready} onClick={save}>{busy ? "Checking…" : "Save to Keychain"}</button>
        </div>
      </div>
    </div>
  );
}

const WELCOME_KEY = "resona.chatgptWelcomeShown";

/** "Continue with ChatGPT": OpenAI's sign-in that lets the app use the user's ChatGPT plan instead of an API key. */
function ChatGptAccount() {
  const { act, notify, bump } = useCtx();
  const cg = useApi<any>("/chatgpt");
  const d = cg.data;
  const models = useApi<any[]>(d?.connected ? "/chatgpt/models" : null);
  const [waiting, setWaiting] = useState(false);
  const [welcome, setWelcome] = useState(false);

  // While the user finishes in the browser, watch for the loopback callback to complete.
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(async () => {
      const st = await api("GET", "/chatgpt").catch(() => null);
      if (!st || st.signingIn) return;
      setWaiting(false);
      bump();
      if (!st.connected) return void (st.error && notify(st.error));
      let shown = false;
      try {
        shown = localStorage.getItem(WELCOME_KEY) === "1";
      } catch {
        /* storage blocked: show the welcome again, harmless */
      }
      if (shown) notify("Signed in with ChatGPT.");
      else setWelcome(true); // OpenAI's guidelines: a one-time notice after the first sign-in
    }, 1500);
    return () => clearInterval(t);
  }, [waiting]);

  const start = async () => {
    const tab = window.open("", "_blank"); // open now: browsers block tabs opened after an await
    try {
      const { url } = await api("POST", "/chatgpt/sign-in");
      if (tab) {
        tab.opener = null;
        tab.location.href = url;
      } else window.open(url, "_blank", "noopener");
      setWaiting(true);
    } catch (e) {
      tab?.close();
      notify((e as Error).message);
    }
  };
  const cancel = () => act(() => api("POST", "/chatgpt/cancel")).then(() => setWaiting(false));
  const signOut = () => act(() => api("POST", "/chatgpt/sign-out"), "Signed out of ChatGPT. The app no longer uses your plan.");
  const gotIt = () => {
    try {
      localStorage.setItem(WELCOME_KEY, "1");
    } catch {
      /* ignore */
    }
    setWelcome(false);
  };

  return (
    <>
      <div className="item">
        <div className="grow">
          <b>ChatGPT plan</b>
          <div className="muted">
            {d?.connected
              ? `Signed in as ${d.email ?? "your account"} · eligible usage counts toward your ChatGPT plan, separate from anything this app charges`
              : d?.signedIn
                ? "Signed in, but plan usage wasn't granted. Sign in again and allow it."
                : "Use your ChatGPT Plus or Pro plan instead of an API key. This app can't see your ChatGPT conversations."}
          </div>
          {d?.connected && models.data && (
            <select className="field" style={{ width: 220, height: 26, marginTop: 6 }} aria-label="ChatGPT model" value={d.model ?? models.data[0]?.slug ?? ""}
              onChange={(e) => act(() => api("PATCH", "/settings", { "ai.chatgptModel": e.target.value }), "Model updated.")}>
              {models.data.map((m) => <option key={m.slug} value={m.slug}>{m.displayName}</option>)}
            </select>
          )}
          {d?.error && !waiting && <div className="err" role="alert">{d.error}</div>}
        </div>
        {d?.connected ? (
          <>
            <a className="btn" href={d.usageUrl} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>Manage usage</a>
            <button className="btn" onClick={signOut}>Sign out</button>
          </>
        ) : waiting ? (
          <>
            <span className="muted">Finish signing in in the browser tab…</span>
            <button className="btn ghost" onClick={cancel}>Cancel</button>
          </>
        ) : (
          <button className="btn primary" onClick={start}>Continue with ChatGPT</button>
        )}
      </div>
      {welcome && (
        <div className="sheet-modal" role="dialog" aria-modal="true" aria-label="You're using your ChatGPT plan">
          <div className="glass thick">
            <h2 style={{ fontSize: 17 }}>You're using your ChatGPT plan</h2>
            <p className="muted">Eligible usage in this app uses your ChatGPT plan. Manage usage in your ChatGPT settings.</p>
            <div className="opp-actions">
              <button className="btn primary" autoFocus onClick={gotIt}>Got it</button>
            </div>
          </div>
        </div>
      )}
    </>
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

/** Mac app only: the login item lives in macOS, not in the backend's settings. */
function OpenAtLogin() {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => void window.resona?.getLoginItem().then(setOn), []);
  if (on === null) return null;
  const label = "Open Resona at login (starts in the menu bar)";
  return (
    <div className="item">
      <div className="grow">{label}</div>
      <Switch checked={on} label={label} onChange={(v) => void window.resona?.setLoginItem(v).then(() => setOn(v))} />
    </div>
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
  const settings = useApi<Record<string, any>>("/settings");
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
        <div className="item">
          <div className="grow">
            <b>Use AI from</b>
            <div className="muted">Which account the agent uses for summaries, drafts and fit checks.</div>
          </div>
          <div className="seg glass thin" role="group" aria-label="AI provider">
            {[["anthropic", "Claude API key"], ["chatgpt", "ChatGPT plan"]].map(([id, label]) => (
              <button key={id} aria-pressed={(settings.data?.["ai.provider"] ?? "anthropic") === id}
                onClick={() => act(() => api("PATCH", "/settings", { "ai.provider": id }), `The agent now uses ${label === "ChatGPT plan" ? "your ChatGPT plan" : "your Claude API key"}.`)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <ChatGptAccount />
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
        {window.resona && <OpenAtLogin />}
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
