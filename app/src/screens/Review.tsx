import { useEffect, useState, type ReactNode } from "react";
import { shortDate, useApi, useCtx } from "../api";

/**
 * Weekly review viewer. Reviews are made in the background once a week (the "weekly-review" job);
 * this only reads them, newest first, with earlier weeks one menu away.
 */
export function WeeklyReview({ onClose }: { onClose: () => void }) {
  const { status, go, openPerson } = useCtx();
  const list = useApi<any[]>("/reviews?limit=26");
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    if (!id && list.data?.length) setId(list.data[0].id);
  }, [list.data, id]);
  const review = useApi<any>(id ? `/reviews/${id}` : null).data;
  const r = review?.id === id ? review.payload : null;

  const job = status?.scheduler?.jobs?.find((j: any) => j.name === "weekly-review");
  const next = job?.lastStartedAt ? shortDate(job.nextDueAt) : null;
  const noProjects = (status?.counts?.projects ?? 0) === 0;
  const jump = (fn: () => void) => () => (onClose(), fn());

  return (
    <div className="sheet-modal" onClick={(e) => e.target === e.currentTarget && onClose()} role="dialog" aria-modal="true" aria-label="Weekly review">
      <div className="glass thick review-sheet">
        <div className="row review-head">
          <div className="grow">
            <h2 style={{ fontSize: 17 }}>Weekly review</h2>
            {review && <div className="muted">{shortDate(review.period_start)} – {shortDate(review.period_end)}</div>}
          </div>
          {(list.data?.length ?? 0) > 1 && (
            <select className="field review-pick" aria-label="Choose a week" value={id ?? ""} onChange={(e) => setId(e.target.value)}>
              {list.data!.map((w, i) => (
                <option key={w.id} value={w.id}>{i === 0 ? "This week" : `Week ending ${shortDate(w.period_end)}`}</option>
              ))}
            </select>
          )}
          <button className="panel-close" style={{ position: "static" }} onClick={onClose} aria-label="Close weekly review">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>

        <div className="review-body">
          {list.data && !list.data.length && (
            <div className="empty">
              {noProjects
                ? "Your first weekly review is made automatically after you add a project folder."
                : "Your first weekly review is being prepared in the background. It will appear here in about a minute."}
            </div>
          )}
          {list.data?.length && !r ? <div className="muted">Loading…</div> : null}
          {r && (
            <>
              <div className="grid cols-3">
                {([["Outreach sent", r.activity?.sent], ["Replies received", r.activity?.replies], ["New people", r.activity?.newPeople]] as Array<[string, number]>).map(([label, n]) => (
                  <div className="card metric" key={label}>
                    <span>{label}</span>
                    <b>{n ?? 0}</b>
                  </div>
                ))}
              </div>

              <Section title="Projects">
                {(r.projects ?? []).filter((p: any) => p.changed > 0).map((p: any) => (
                  <div className="item" key={p.id}>
                    <div className="grow"><b>{p.name}</b><div className="muted">{p.changed} file{p.changed === 1 ? "" : "s"} changed{p.contexts ? " · summary updated" : ""}</div></div>
                  </div>
                ))}
                {!(r.projects ?? []).some((p: any) => p.changed > 0) && <div className="muted">No project changes this week.</div>}
              </Section>

              {(r.openQuestions?.length ?? 0) > 0 && (
                <Section title="Questions for you">
                  {r.openQuestions.map((q: any, i: number) => (
                    <div className="item" key={i}>
                      <div className="grow"><b>{q.project}</b><div className="muted">{q.question}</div></div>
                      <button className="btn" onClick={jump(() => go("projects"))}>Answer</button>
                    </div>
                  ))}
                </Section>
              )}

              <Section title="Review queue">
                <div className="item">
                  <div className="grow">
                    <div className="muted">
                      {r.reviewQueue?.awaitingApproval ?? 0} draft{r.reviewQueue?.awaitingApproval === 1 ? "" : "s"} awaiting approval
                      {" · "}{r.reviewQueue?.staleDrafts ?? 0} flagged after project changes
                      {r.reviewQueue?.uncertain ? ` · ${r.reviewQueue.uncertain} send${r.reviewQueue.uncertain === 1 ? "" : "s"} to reconcile` : ""}
                    </div>
                  </div>
                  <button className="btn" onClick={jump(() => go("opps"))}>Open Opportunities</button>
                </div>
              </Section>

              {(r.newOpportunities?.length ?? 0) > 0 && (
                <Section title="Top new opportunities">
                  {r.newOpportunities.map((o: any) => (
                    <button className="item" key={o.id} style={{ textAlign: "left" }} onClick={jump(() => go("opps"))}>
                      <div className="grow">
                        <b>{o.display_name ?? "Unknown author"}</b>
                        <div className="muted">{o.project} · {String(o.scenario).replace(/_/g, " ")}</div>
                      </div>
                      <span className="score">{Math.round(Number(o.relevance) * 100)}%</span>
                    </button>
                  ))}
                </Section>
              )}

              {(r.recommendations?.reconnect?.length ?? 0) > 0 && (
                <Section title="Reconnect">
                  {r.recommendations.reconnect.map((x: any) => (
                    <button className="item" key={x.personId} style={{ textAlign: "left" }} onClick={jump(() => openPerson(x.personId, true))}>
                      <div className="grow"><b>{x.personName}</b><div className="muted">{x.reason}</div></div>
                    </button>
                  ))}
                </Section>
              )}

              {(r.recommendations?.followups?.length ?? 0) > 0 && (
                <Section title="Follow-ups">
                  {r.recommendations.followups.map((f: any) => (
                    <button className="item" key={f.followupId} style={{ textAlign: "left" }} onClick={jump(() => openPerson(f.personId, true))}>
                      <div className="grow"><b>{f.personName}</b><div className="muted">{f.reason}</div></div>
                      {f.overdue && <span className="badge warn">Overdue</span>}
                    </button>
                  ))}
                </Section>
              )}
            </>
          )}
        </div>

        <p className="muted review-foot">
          Made automatically every week in the background{next ? `; the next one is due ${next}` : ""}. Each review is also saved as a note in your Markdown vault.
        </p>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <div className="section-title">{title}</div>
      <div className="list">{children}</div>
    </>
  );
}
