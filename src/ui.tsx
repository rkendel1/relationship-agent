/** Shared UI helpers and vocabulary for Boundry Connector's screens. */
import { useState, type ReactNode } from "react";

export type Props = { onError: (e: unknown) => void; onInfo: (text: string) => void };

export const STATE_LABEL: Record<string, string> = {
  unknown: "Unknown",
  observed: "Observed",
  known: "Known",
  connected: "Connected",
  introducible: "Introducible",
  introduced: "Introduced",
  active: "Active",
};
export const STATE_HELP: Record<string, string> = {
  unknown: "Referenced, with no relationship evidence.",
  observed: "Seen in an authorized source. You have not said you know them.",
  known: "You said you have interacted with them.",
  connected: "You said you are connected. That does not imply they will make introductions.",
  introducible: "They opted in to receive relevant introduction requests.",
  introduced: "Both sides opted in and the introduction was made.",
  active: "You recorded an ongoing interaction.",
};
export const INTRO_LABEL: Record<string, string> = {
  draft: "Draft",
  approved: "Approved",
  consent_requested: "Requested — awaiting their answer",
  introduced: "Introduced",
  completed: "Completed",
  declined: "Declined",
  withdrawn: "Withdrawn",
  expired: "Expired",
  manual_ready: "Approved — send it yourself",
  manual_sent: "Sent by you",
  external_sent: "Sent by the provider",
};

export const fmt = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");
export const fmtDate = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleDateString(undefined, { dateStyle: "medium" }) : "");
export const splitList = (s: string) => s.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);

export function useAction(onError: (e: unknown) => void) {
  const [busy, setBusy] = useState(false);
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    try {
      return await fn();
    } catch (e) {
      onError(e);
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

export function Badge({ state, kind = "rel" }: { state: string; kind?: "rel" | "intro" }) {
  const label = kind === "rel" ? STATE_LABEL[state] ?? state : INTRO_LABEL[state] ?? state;
  return (
    <span className={`badge b-${state}`} title={kind === "rel" ? STATE_HELP[state] : undefined}>
      {label}
    </span>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty small">
      <h2>{title}</h2>
      {children && <p className="muted">{children}</p>}
    </div>
  );
}


/** Delivery status, as people read it (introductions:get → status). */
export const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  approved: "Approved — not sent",
  queued: "Queued",
  sent: "Sent",
  failed: "Not delivered",
  unknown: "Outcome unknown",
  declined: "Declined",
  withdrawn: "Withdrawn",
  manual_action_required: "Your action required",
  expired: "Expired",
};

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge s-${status}`}>{STATUS_LABEL[status] ?? status}</span>;
}
