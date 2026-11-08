import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError, useCtx } from "./api";

export const latestAction = (draft: any) =>
  [...(draft?.actions ?? [])].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).at(-1);

/** Approval belongs to one revision: any edit after approval needs a fresh review (the backend cancels the action). */
export function draftBadge(draft: any, dirty: boolean): [string, string] {
  const last = latestAction(draft);
  if (last?.state === "sent") return ["Sent", "ok"];
  if (dirty && last && ["approved", "awaiting_approval"].includes(last.state)) return ["Edited · needs review", "warn"];
  if (last?.state === "approved") return ["Approved · not sent", "ok"];
  if (last?.state === "awaiting_approval") return ["Awaiting approval", "warn"];
  if (last?.state === "uncertain") return ["Send uncertain · check platform", "warn"];
  if (last?.state === "failed") return ["Failed", "warn"];
  if (last?.state === "cancelled") return ["Edited · needs review", "warn"];
  if (draft.stale) return ["Project changed · review", "warn"];
  return ["New", ""];
}
console.assert(draftBadge({ actions: [{ state: "approved", created_at: "1" }] }, true)[0] === "Edited · needs review", "edit must clear approval");
console.assert(draftBadge({ actions: [] }, true)[0] === "New", "editing a new draft keeps it new");

export function DraftEditor(props: {
  draft: any;
  destination: string;
  openUrl?: string | null;
  limit?: number;
  rows?: number;
  label: string;
  /** Show an editable title above the text (posts). */
  editTitle?: boolean;
  onText?: (text: string) => void;
  left?: ReactNode;
  children?: ReactNode;
}) {
  const { draft } = props;
  const { act, bump, notify } = useCtx();
  const [text, setText] = useState<string>(draft.revision?.body ?? "");
  const latest = useRef(text); // the debounced save must read the newest text, not a stale render's
  const [title, setTitle] = useState<string>(draft.revision?.title ?? "");
  const latestTitle = useRef(title);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "empty" | "error">("idle");
  const dirty = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const saving = useRef<Promise<any> | null>(null);

  useEffect(() => {
    if (dirty.current) return;
    setText((latest.current = draft.revision?.body ?? ""));
    setTitle((latestTitle.current = draft.revision?.title ?? ""));
  }, [draft.revision?.body, draft.revision?.title]);
  useEffect(() => props.onText?.(text), [text]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const save = async (): Promise<any> => {
    clearTimeout(timer.current);
    if (!dirty.current) return saving.current ?? draft;
    if (!latest.current.trim()) {
      setSaveState("empty"); // the text can't be saved empty; keep it dirty until there is something to save
      throw new Error("Write something before saving or approving.");
    }
    dirty.current = false;
    setSaveState("saving");
    const payload = props.editTitle ? { body: latest.current, title: latestTitle.current.trim() || null } : { body: latest.current };
    saving.current = api("POST", `/drafts/${draft.id}/revisions`, payload).finally(() => (saving.current = null));
    try {
      const saved = await saving.current;
      setSaveState(dirty.current ? "idle" : "saved");
      bump();
      return saved;
    } catch (e) {
      dirty.current = true;
      setSaveState("error");
      throw e;
    }
  };
  const schedule = () => {
    dirty.current = true;
    setSaveState("idle");
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void save().catch((e) => notify(e.message)), 800);
  };
  const onEdit = (v: string) => {
    setText((latest.current = v));
    schedule();
  };
  const onEditTitle = (v: string) => {
    setTitle((latestTitle.current = v));
    schedule();
  };

  const last = latestAction(draft);
  const sent = last?.state === "sent";
  const approved = last?.state === "approved" && !dirty.current;
  const [label, tone] = draftBadge(draft, dirty.current);

  const approve = () =>
    act(async () => {
      const current = (await save()) ?? draft;
      let action = latestAction(current);
      if (action?.state !== "awaiting_approval") action = await api("POST", `/drafts/${draft.id}/actions`, { destination: props.destination });
      return api("POST", `/actions/${action.id}/approve`, { revision: current.currentRevision, acknowledgeStale: Boolean(current.stale) });
    }, "Approved this version. Nothing is sent until you send it yourself and press Mark Sent.");

  const copyOpen = async () => {
    try {
      await navigator.clipboard.writeText(latest.current);
    } catch {
      /* clipboard may be blocked; the text is still selectable */
    }
    if (props.openUrl) window.open(props.openUrl, "_blank", "noopener");
    notify(props.openUrl ? "Copied. Paste it on the page that just opened, then press Mark Sent." : "Copied to the clipboard.");
  };

  const markSent = () => act(() => api("POST", `/actions/${last.id}/mark-sent`, { url: props.openUrl ?? undefined }), "Recorded as sent. The person's history is updated.");
  const reconcile = (wasSent: boolean) => act(() => api("POST", `/actions/${last.id}/reconcile`, { wasSent }), wasSent ? "Recorded as sent." : "Recorded as not sent.");
  const retry = () => act(() => api("POST", `/actions/${last.id}/retry`), "Ready for a fresh approval.");

  return (
    <>
      {props.editTitle && (
        <input className="field title-field" aria-label={`${props.label} title`} placeholder="Title (optional, for your own reference)" value={title} readOnly={sent}
          onChange={(e) => onEditTitle(e.target.value)} onBlur={() => void save().catch(() => {})} />
      )}
      <textarea aria-label={props.label} rows={Math.min(24, Math.max(props.rows ?? 5, text.split("\n").length + 1))} value={text} readOnly={sent}
        onChange={(e) => onEdit(e.target.value)} onBlur={() => void save().catch(() => {})} />
      {props.children}
      <div className="opp-actions">
        <span className={`badge ${tone}`}>{label}</span>
        <span className={`muted save-state ${saveState === "empty" || saveState === "error" ? "over-limit" : ""}`} aria-live="polite" style={{ marginRight: "auto" }}>
          {sent ? "" : { idle: dirty.current ? "Unsaved changes" : "Edit freely: changes save automatically", saving: "Saving…", saved: "All changes saved", empty: "Text can't be empty", error: "Couldn't save. Keep typing to retry." }[saveState]}
        </span>
        {props.limit && <span className={`muted ${text.length > props.limit ? "over-limit" : ""}`}>{text.length} / {props.limit}</span>}
        {props.left}
        {!sent && <button className="btn" onClick={copyOpen}>{props.openUrl ? "Copy & Open" : "Copy"}</button>}
        {approved && <button className="btn primary" onClick={markSent}>Mark Sent</button>}
        {last?.state === "uncertain" && (
          <>
            <button className="btn" onClick={() => reconcile(false)}>Wasn't Sent</button>
            <button className="btn primary" onClick={() => reconcile(true)}>It Was Sent</button>
          </>
        )}
        {last?.state === "failed" && <button className="btn" onClick={retry}>Retry</button>}
        {!sent && !approved && !["uncertain", "failed"].includes(last?.state) && (
          <button className="btn primary" onClick={approve}>Approve</button>
        )}
      </div>
    </>
  );
}

export const isConflict = (e: unknown) => e instanceof ApiError && e.status === 409;
