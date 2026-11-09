/**
 * Introductions and delivery: review, approve one exact content for one channel, deliver, and see
 * what actually happened. The server decides every state from evidence; this screen only shows it.
 *
 * External sends go through FeltKit's integration capability `delivery.send` over AppPort
 * (`POST /appport`). FeltKit accepts only an explicit bearer credential there, never the browser's
 * session cookie, so the browser can send externally only when the app runs with bearer sessions
 * (VITE_FELTKIT_SESSION=bearer, see src/main.tsx). With the default cookie session the screen says
 * so instead of failing silently.
 */
import { useEffect, useState } from "react";
import { useFeltKit, useMutation, useQueryState } from "@feltdb/feltkit/react";
import { api } from "../feltkit/_generated/api";
import { Empty, fmt, INTRO_LABEL, StatusBadge, useAction, type Props } from "./ui";

type Channel = "in_app" | "external" | "manual";
const CHANNEL_LABEL: Record<Channel, string> = { in_app: "In the app (member)", external: "External provider", manual: "Send it myself" };
const NOT_SENT = ["NOT_CONFIGURED", "FORBIDDEN", "UNAUTHORIZED", "INVALID_INPUT", "INVALID_ARGUMENT"] as const;

type AppPortResult = { ok: true; output: unknown } | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } };

/** Call an AppPort capability as the signed-in person. Needs a bearer session (FeltKit refuses cookies on /appport). */
function useCapability() {
  const client = useFeltKit();
  const token = client.tokens.get();
  const call = async (capability: string, input: unknown, idempotencyKey?: string): Promise<AppPortResult> => {
    if (!token) return { ok: false, error: { code: "COOKIE_SESSION", message: "This browser session uses a cookie, which FeltKit does not accept for AppPort capabilities. Run the app with VITE_FELTKIT_SESSION=bearer, or call delivery.send from an AppPort client with a session token." } };
    const response = await fetch("/appport", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ protocol: "appport/1", type: "request", requestId: crypto.randomUUID(), capability: { name: capability, version: 1 }, input, ...(idempotencyKey ? { idempotencyKey } : {}) }),
    });
    return (await response.json()) as AppPortResult;
  };
  return { call, canCall: Boolean(token) };
}

export function IntrosView(props: Props & { initial?: string }) {
  const intros = useQueryState(api.introductions.outgoing);
  const expire = useMutation(api.introductions.expireDue);
  const [selected, setSelected] = useState<string | undefined>(props.initial);
  const list = intros.data ?? [];
  const current = selected ?? list[0]?.id;
  useEffect(() => {
    void expire({}).catch(() => undefined);
  }, [expire]);
  const followUps = list.filter((i) => i.followUpAt && i.followUpAt <= Date.now() + 86400000);
  return (
    <div className="stack gap">
      <h1>Introductions</h1>
      {followUps.length > 0 && <div className="notice info">Follow up due: {followUps.map((f) => f.personName).join(", ")}</div>}
      {list.length === 0 ? (
        <Empty title="No introductions yet">Draft one from a match on the Ask screen.</Empty>
      ) : (
        <div className="split">
          <ul className="list">
            {list.map((i) => (
              <li key={i.id}>
                <button className={`project ${current === i.id ? "active" : ""}`} onClick={() => setSelected(i.id)}>
                  <span className="project-name">{i.personName}</span>
                  <StatusBadge status={i.status} />
                </button>
              </li>
            ))}
          </ul>
          {current && <IntroDetail key={current} id={current} {...props} />}
        </div>
      )}
    </div>
  );
}

function IntroDetail({ id, onError, onInfo }: Props & { id: string }) {
  const q = useQueryState(api.introductions.get, { id });
  const edit = useMutation(api.introductions.edit);
  const approve = useMutation(api.introductions.approve);
  const markSent = useMutation(api.introductions.markSent);
  const withdraw = useMutation(api.introductions.withdraw);
  const complete = useMutation(api.introductions.complete);
  const setFollowUp = useMutation(api.introductions.setFollowUp);
  const revoke = useMutation(api.introductions.revokeConsent);
  const prepare = useMutation(api.deliveries.prepareExternal);
  const recordNotSent = useMutation(api.deliveries.recordNotSent);
  const { call, canCall } = useCapability();
  const { busy, run } = useAction(onError);
  const intro = q.data;
  const [draft, setDraft] = useState<{ sharedContext: string; message: string; fields: string[] } | null>(null);
  const [channel, setChannel] = useState<Channel | null>(null);
  const [note, setNote] = useState("");
  useEffect(() => {
    if (intro && intro.state === "draft") setDraft({ sharedContext: intro.sharedContext, message: intro.message, fields: intro.requesterFields });
  }, [intro?.__version]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!intro) return <p className="muted">Loading…</p>;
  const dirty = draft && (draft.sharedContext !== intro.sharedContext || draft.message !== intro.message || draft.fields.join() !== intro.requesterFields.join());
  const available = intro.channels.filter((c) => c.available);
  const chosen = intro.channels.find((c) => c.channel === (channel ?? available[0]?.channel)) ?? null;
  const latest = intro.deliveries.find((d) => d.determinedBy !== "refusal") ?? intro.deliveries[0] ?? null;
  // Re-approval is offered only when the approval in force can no longer deliver: it expired unused, or its delivery failed.
  // (An external approval with no delivery yet is waiting for "Send", not for another approval.)
  const canApproveAgain = intro.state === "approved" && (Boolean(intro.approval?.expired) || latest?.state === "failed");

  const doApprove = async () => {
    if (!chosen) return;
    // The hash shown is the hash of exactly what is on screen now; the server refuses it if anything changed.
    const r = await run(() => approve({ id, channel: chosen.channel, contentHash: chosen.hash }));
    if (!r) return;
    onInfo(
      r.alreadyApplied ? "Already approved: nothing new was created." :
      r.status === "queued" ? "Approved. Delivery is queued; the request appears in their app once it is delivered." :
      r.status === "manual_action_required" ? "Approved. Copy the text and send it yourself, then record that you did." :
      "Approved for the external provider. Nothing has been sent yet.",
    );
  };

  const sendExternally = async () => {
    const prepared = await run(() => prepare({ introductionId: id }));
    if (!prepared) return;
    if (!prepared.ok) return onInfo(`Not sent: ${prepared.reason}`);
    const result = await call(prepared.capability, prepared.input, prepared.idempotencyKey);
    if (result.ok) return onInfo("The provider confirmed it.");
    // Refusals before anything left are recorded here; anything else is recorded from FeltKit's call record.
    if ((NOT_SENT as readonly string[]).includes(result.error.code)) {
      await run(() => recordNotSent({ deliveryId: prepared.deliveryId, code: result.error.code as (typeof NOT_SENT)[number], message: result.error.message.slice(0, 480) }));
    }
    onError(new Error(result.error.code === "COOKIE_SESSION" ? result.error.message : `${result.error.code}: ${result.error.message}`));
  };

  return (
    <section className="card stack">
      <div className="row-between">
        <h2>{intro.personName}</h2>
        <StatusBadge status={intro.status} />
      </div>

      {intro.state === "draft" && draft ? (
        <>
          <label className="field">
            <span>What they will see about your request (minimum necessary)</span>
            <textarea rows={3} value={draft.sharedContext} onChange={(e) => setDraft({ ...draft, sharedContext: e.target.value })} />
          </label>
          <label className="field">
            <span>Message</span>
            <textarea rows={5} value={draft.message} onChange={(e) => setDraft({ ...draft, message: e.target.value })} />
          </label>
          {intro.path === "participant" && (
            <fieldset className="field">
              <span>If they accept, share with them:</span>
              {(["headline", "email"] as const).map((f) => (
                <label key={f} className="check">
                  <input type="checkbox" checked={draft.fields.includes(f)} onChange={(e) => setDraft({ ...draft, fields: e.target.checked ? [...draft.fields, f] : draft.fields.filter((x) => x !== f) })} /> your {f}
                </label>
              ))}
            </fieldset>
          )}
        </>
      ) : (
        <div className="preview">
          <div className="small-text muted">Shared context</div>
          <p>{intro.sharedContext}</p>
          <div className="small-text muted">Message</div>
          <p className="pre">{intro.message}</p>
        </div>
      )}

      {(intro.state === "draft" || canApproveAgain) && (
        <fieldset className="field">
          <span>Deliver through</span>
          {intro.channels.map((c) => (
            <label key={c.channel} className="check">
              <input type="radio" name={`channel-${id}`} disabled={!c.available} checked={chosen?.channel === c.channel} onChange={() => setChannel(c.channel)} />
              <span>
                {CHANNEL_LABEL[c.channel]}
                {!c.available && c.reason && <span className="muted"> — {c.reason}</span>}
                {c.channel === "external" && c.available && <span className="muted"> — needs the provider to be configured (see Delivery)</span>}
              </span>
            </label>
          ))}
        </fieldset>
      )}

      {(intro.state === "draft" || canApproveAgain) && (
        <div className="row-end">
          {intro.state === "draft" && <button className="danger-link" onClick={() => run(() => withdraw({ id }))}>Discard</button>}
          {dirty ? (
            <button className="secondary" disabled={busy} onClick={() => run(() => edit({ id, sharedContext: draft!.sharedContext, message: draft!.message, requesterFields: draft!.fields as Array<"email" | "headline"> }))}>
              Save changes, then review
            </button>
          ) : (
            <button className="primary" disabled={busy || !chosen?.available} onClick={doApprove} title={chosen ? `Approves content ${chosen.hash.slice(0, 12)}…` : undefined}>
              {canApproveAgain ? "Approve again" : chosen?.channel === "in_app" ? "Approve and send request" : "Approve this exact text"}
            </button>
          )}
        </div>
      )}

      {intro.approval && (
        <p className="small-text muted">
          Approved {fmt(intro.approval.approvedAt)} for {CHANNEL_LABEL[intro.approval.channel as Channel]} · content {intro.approval.contentHash.slice(0, 12)}… ·{" "}
          {intro.approval.consumedAt ? `used ${fmt(intro.approval.consumedAt)}` : intro.approval.expired ? <strong>expired</strong> : `valid until ${fmt(intro.approval.expiresAt)}`}
        </p>
      )}

      {intro.state === "approved" && intro.channel === "external" && !canApproveAgain && latest?.state !== "unknown" && (
        <div className="row-end">
          {!canCall && <span className="muted small-text">External sending needs a bearer session (see Delivery).</span>}
          <button className="primary" disabled={busy} onClick={sendExternally}>{latest?.state === "queued" ? "Send (same key, not resent if already received)" : "Send through provider"}</button>
        </div>
      )}

      {intro.state === "manual_ready" && (
        <div className="row-end">
          <button className="secondary" onClick={() => void navigator.clipboard?.writeText(intro.message).then(() => onInfo("Copied."))}>Copy text</button>
          <button className="primary" disabled={busy} onClick={() => run(() => markSent({ id }))}>I sent it</button>
        </div>
      )}

      {latest && <DeliveryNote d={latest} />}

      {Object.keys(intro.disclosed).length > 0 && (
        <div className="disclosed">
          <div className="small-text muted">Shared with you by consent</div>
          {Object.entries(intro.disclosed).map(([k, v]) => (
            <div key={k}>
              <strong>{k}:</strong> {v}
            </div>
          ))}
        </div>
      )}

      {["introduced", "manual_sent", "external_sent"].includes(intro.state) && (
        <div className="stack">
          <label className="field">
            <span>Follow up on</span>
            <input type="date" value={intro.followUpAt ? new Date(intro.followUpAt).toISOString().slice(0, 10) : ""} onChange={(e) => run(() => setFollowUp({ id, at: e.target.value ? new Date(e.target.value).getTime() : null }))} />
          </label>
          <label className="field">
            <span>What happened? (private to you)</span>
            <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <div className="row-end">
            <button className="primary" disabled={busy || !note.trim()} onClick={() => run(() => complete({ id, note })).then(() => setNote(""))}>Record outcome</button>
          </div>
        </div>
      )}
      {intro.outcomeNote && (
        <div className="preview">
          <div className="small-text muted">Outcome</div>
          <p className="pre">{intro.outcomeNote}</p>
        </div>
      )}

      <div className="row-end">
        {["approved", "consent_requested", "manual_ready"].includes(intro.state) && <button className="danger-link" onClick={() => run(() => withdraw({ id }))}>Withdraw</button>}
        {intro.myConsentActive && ["introduced", "completed", "consent_requested"].includes(intro.state) && (
          <button className="danger-link" onClick={() => run(() => revoke({ introductionId: id })).then((n) => n && onInfo("Your consent is withdrawn. They no longer see what you shared."))}>Withdraw my consent</button>
        )}
      </div>

      <details>
        <summary className="small-text muted">Delivery attempts ({intro.deliveries.length}) and history</summary>
        {intro.deliveries.length > 0 && (
          <table className="table">
            <thead>
              <tr><th>When</th><th>Channel</th><th>State</th><th>Provider</th><th>Decided by</th></tr>
            </thead>
            <tbody>
              {intro.deliveries.map((d) => (
                <tr key={d.id}>
                  <td>{fmt(d.createdAt)}</td>
                  <td>{d.channel.replace("_", "-")}</td>
                  <td><StatusBadge status={d.state} /></td>
                  <td>{[d.providerStatus && `HTTP ${d.providerStatus}`, d.providerCode].filter(Boolean).join(" · ") || "—"}</td>
                  <td>{d.determinedBy ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <ol className="timeline">
          <li>{fmt(intro.createdAt)} — drafted</li>
          {intro.events.map((e) => (
            <li key={e.id}>
              {fmt(e.at)} — {INTRO_LABEL[e.to] ?? e.to} <span className="muted">by {e.actorId}</span>
            </li>
          ))}
        </ol>
        <p className="small-text muted">Introduction key {intro.idempotencyKey}</p>
      </details>
    </section>
  );
}

/** Why a delivery did or did not happen, in one line. */
function DeliveryNote({ d }: { d: { state: string; channel: string; reason: string | null; contentMismatch: boolean; determinedBy: string | null } }) {
  const text =
    d.reason ??
    (d.state === "queued" ? (d.channel === "in_app" ? "Waiting for the dispatcher. The recipient sees nothing until it runs." : "Prepared, not confirmed by the provider yet.") :
    d.state === "sent" ? (d.channel === "in_app" ? "Delivered: the request is in their Requests, and they were notified." : d.determinedBy === "person" ? "You recorded that you sent it." : "The provider confirmed it.") : null);
  if (!text) return null;
  const tone = d.state === "failed" || d.contentMismatch ? "error" : d.state === "unknown" || d.state === "manual_action_required" ? "warn" : "info";
  return <div className={`delivery-note ${tone}`}>{text}</div>;
}

// ---------------------------------------------------------------------------------------------
// Readiness

export function ReadinessView({ onError }: Props) {
  const readiness = useQueryState(api.deliveries.readiness);
  const { call, canCall } = useCapability();
  const [probe, setProbe] = useState<{ state: "checking" | "ok" | "not_configured" | "unreachable" | "unchecked"; detail: string } | null>(null);
  const check = async () => {
    setProbe({ state: "checking", detail: "" });
    try {
      const r = await call("delivery.health", {});
      if (r.ok) setProbe({ state: "ok", detail: "FeltKit reached the provider's health check." });
      else if (r.error.code === "NOT_CONFIGURED") setProbe({ state: "not_configured", detail: r.error.message });
      else if (r.error.code === "COOKIE_SESSION") setProbe({ state: "unchecked", detail: r.error.message });
      else setProbe({ state: "unreachable", detail: `${r.error.code}: ${r.error.message}` });
    } catch (e) {
      onError(e);
      setProbe(null);
    }
  };
  useEffect(() => {
    void check();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const r = readiness.data;
  if (!r) return <p className="muted">Loading…</p>;
  const label = { checking: "Checking…", ok: "Configured and reachable", not_configured: "Not configured", unreachable: "Configured, not reachable", unchecked: "Not checkable from this session" } as const;
  return (
    <div className="stack gap">
      <div>
        <h1>Delivery</h1>
        <p className="muted">How approved introductions can leave the app. Nothing is sent without your approval of the exact text; nothing is called delivered without evidence.</p>
      </div>
      <section className="card stack">
        <div className="row-between"><h2>In the app</h2><span className="badge s-sent">Available</span></div>
        <p className="small-text muted">{r.inApp.detail} Delivered by a background job after you approve; the request becomes visible to them in the same transaction that marks it sent.</p>
      </section>
      <section className="card stack">
        <div className="row-between">
          <h2>External provider</h2>
          {probe && <span className={`badge ${probe.state === "ok" ? "s-sent" : probe.state === "checking" ? "s-queued" : "s-failed"}`}>{label[probe.state]}</span>}
        </div>
        <dl className="facts">
          <dt>Your authority</dt>
          <dd>{r.external.authority ? "You may send externally (delivery.send)." : "You do not hold delivery.send. An operator grants it with the external_sender role."}</dd>
          <dt>Provider</dt>
          <dd>{probe?.detail || "—"}</dd>
          <dt>Configure</dt>
          <dd>{r.external.configuration.join(" and ")}. Values stay in FeltKit's credential custody, never in the app's data.</dd>
          <dt>This session</dt>
          <dd>{canCall ? "Bearer session: can call AppPort capabilities." : "Cookie session: FeltKit refuses cookies on /appport, so this browser cannot probe or send externally. Operators can run `npx feltkit readiness`; or run the app with VITE_FELTKIT_SESSION=bearer."}</dd>
        </dl>
        <div className="row-end"><button className="secondary" onClick={() => void check()}>Check again</button></div>
      </section>
      <section className="card stack">
        <div className="row-between"><h2>Send it myself</h2><span className="badge s-sent">Always available</span></div>
        <p className="small-text muted">{r.manual.detail}</p>
      </section>
      <section className="card">
        <h2>Your deliveries</h2>
        <dl className="facts">
          <dt>Queued</dt><dd>{r.deliveries.queued}</dd>
          <dt>Sent</dt><dd>{r.deliveries.sent}</dd>
          <dt>Not delivered</dt><dd>{r.deliveries.failed}</dd>
          <dt>Outcome unknown</dt><dd>{r.deliveries.unknown}</dd>
          <dt>Your action required</dt><dd>{r.deliveries.manualActionRequired}</dd>
        </dl>
      </section>
    </div>
  );
}
