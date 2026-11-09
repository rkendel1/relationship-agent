/**
 * The delivery boundary's policy. Pure, apart from hashing with the platform's Web Crypto
 * (`globalThis.crypto.subtle`, standard in Node 20+ and browsers; no Node built-ins).
 *
 * Channels:
 * - in_app    the recipient is a member: delivery makes the request visible in their Requests and
 *             notifies them (FeltKit Notifications, after commit). Decided entirely in-app.
 * - external  the recipient is not a member and the `delivery` integration is configured: the
 *             approved message is sent through FeltKit's integration contract; its call record
 *             decides the state (sent / failed / unknown). Requires the delivery.send permission.
 * - manual    no provider: the owner sends the approved text themselves and records it.
 */
import type { DELIVERY_CHANNELS, DELIVERY_STATES, INTRO_STATES, SHAREABLE_FIELDS } from "./app.js";

export type Channel = (typeof DELIVERY_CHANNELS)[number];
export type DeliveryState = (typeof DELIVERY_STATES)[number];
type IntroState = (typeof INTRO_STATES)[number];
type Field = (typeof SHAREABLE_FIELDS)[number];

export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export interface Reviewable {
  introductionId: string;
  sharedContext: string;
  message: string;
  requesterFields: Field[];
  channel: Channel;
  recipient: string;
}

/** The exact string a person reviews and approves. Field order is fixed; any change changes the hash. */
export function canonical(r: Reviewable): string {
  return JSON.stringify([r.introductionId, r.channel, r.recipient, r.sharedContext, r.message, [...r.requesterFields].sort()]);
}

export async function sha256(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function contentHash(r: Reviewable): Promise<string> {
  return sha256(canonical(r));
}

/** Who a channel delivers to, as stored on the approval. An external recipient includes the address, so changing it invalidates the approval. */
export function recipientRef(channel: Channel, input: { recipientUserId?: string; personId: string; email?: string }): string {
  if (channel === "in_app") return `user:${input.recipientUserId ?? ""}`;
  if (channel === "external") return `email:${(input.email ?? "").trim().toLowerCase()}`;
  return `person:${input.personId}`;
}

export function subjectFor(displayName: string): string {
  return `Introduction request from ${displayName}`;
}

export interface ChannelOption {
  channel: Channel;
  available: boolean;
  reason?: string;
}

/** Which channels an introduction may use. Configuration of the external provider is checked by FeltKit at call time. */
export function channelOptions(input: { participant: boolean; hasEmail: boolean; mayDeliverExternally: boolean }): ChannelOption[] {
  if (input.participant) return [{ channel: "in_app", available: true }];
  return [
    {
      channel: "external",
      available: input.hasEmail && input.mayDeliverExternally,
      ...(!input.hasEmail ? { reason: "No e-mail address is recorded for this person." } : !input.mayDeliverExternally ? { reason: "You do not hold the delivery.send permission (role external_sender)." } : {}),
    },
    { channel: "manual", available: true },
  ];
}

export interface ApprovalRecord {
  id: string;
  channel: Channel;
  recipient: string;
  contentHash: string;
  expiresAt: number;
  consumedAt?: number;
  supersededAt?: number;
}

export type Check = { ok: true } | { ok: false; reason: string };

/** Whether an approval still authorizes a delivery of the introduction as it stands now. */
export function checkApproval(a: ApprovalRecord | null, current: { hash: string; recipient: string; state: IntroState; approvalId?: string }, now: number): Check {
  if (!a) return { ok: false, reason: "There is no approval for this introduction." };
  if (current.approvalId !== a.id || a.supersededAt) return { ok: false, reason: "A newer approval replaced this one." };
  if (a.consumedAt) return { ok: false, reason: "This approval was already used for a delivery." };
  if (a.expiresAt <= now) return { ok: false, reason: "The approval expired before delivery. Review the text and approve it again." };
  if (current.state !== "approved") return { ok: false, reason: `The introduction is ${current.state.replace("_", " ")}, not approved.` };
  if (a.recipient !== current.recipient) return { ok: false, reason: "The recipient changed after approval. Review and approve again." };
  if (a.contentHash !== current.hash) return { ok: false, reason: "The content changed after approval. Review and approve again." };
  return { ok: true };
}

/** FeltKit integration call states → delivery states. Only a confirmed call becomes "sent". */
export function deliveryStateFromCall(callState: string): DeliveryState | null {
  if (callState === "succeeded") return "sent";
  if (callState === "failed") return "failed";
  if (callState === "unknown") return "unknown";
  return null; // "started": not settled
}

/** Pre-send refusals: FeltKit answered before any request left, so nothing was delivered. */
export const NOT_SENT_CODES = ["NOT_CONFIGURED", "FORBIDDEN", "UNAUTHORIZED", "INVALID_INPUT", "INVALID_ARGUMENT"] as const;

export type DisplayStatus = "draft" | "approved" | "queued" | "sent" | "failed" | "unknown" | "declined" | "withdrawn" | "manual_action_required" | "expired";

/** One status for people to read, from the introduction's state and its latest delivery. */
export function displayStatus(intro: { state: IntroState }, latest: { state: DeliveryState } | null): DisplayStatus {
  switch (intro.state) {
    case "draft":
      return "draft";
    case "withdrawn":
      return "withdrawn";
    case "declined":
      return "declined";
    case "expired":
      return "expired";
    case "manual_ready":
      return "manual_action_required";
    case "approved":
      return latest ? (latest.state === "sent" ? "sent" : latest.state) : "approved";
    default:
      // consent_requested, introduced, completed, manual_sent, external_sent: it went out.
      return "sent";
  }
}
