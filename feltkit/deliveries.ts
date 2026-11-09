/**
 * The delivery boundary: how an approved introduction leaves the app, and how its outcome is known.
 *
 * Every delivery is a record with an idempotency key, created from one approval. Its state is set
 * only from evidence:
 * - in_app:   `dispatch` (the job "deliveries.dispatch", queued after the approval commits)
 *             re-checks the approval and, in one transaction, makes the request visible to the
 *             recipient and marks the delivery sent; the notification is an after-commit effect
 *             with the same key, so it happens if and only if that transaction commits.
 * - external: `prepareExternal` re-checks the approval and returns the exact approved payload; the
 *             person's client then calls the `delivery.send` integration capability with the
 *             delivery's idempotency key. FeltKit records the call and runs `onExternalOutcome`
 *             with the call record: succeeded → sent, failed → failed, unknown → unknown. An
 *             unknown call is never re-sent (FeltKit refuses a replay of its key); it is settled by
 *             verification against the provider's records, which runs the same hook again.
 *
 * Limitation (FeltKit 0.3.18): `feltkit({ authorize })` is not consulted for integration
 * capabilities, so the app cannot refuse a `delivery.send` call whose input differs from the
 * approval before it leaves. `onExternalOutcome` detects it afterwards (contentMismatch) and audits
 * it. External sending is therefore limited to people granted the `external_sender` role.
 */
import { fail, s } from "@feltdb/feltkit";
import { app, approvals, consentGrants, deliveries, introductions } from "./app.js";
import { audit, me, owned } from "./_access.js";
import { checkApproval, deliveryStateFromCall, displayStatus, NOT_SENT_CODES, sha256, subjectFor, type DeliveryState } from "./_delivery.js";
import { currentDelivery, GRANT_TTL_MS, move, profileOf, REQUEST_TTL_MS, reviewFor, type Intro } from "./_flow.js";

type Delivery = {
  id: string;
  ownerId: string;
  introductionId: string;
  approvalId: string;
  channel: "in_app" | "external" | "manual";
  provider: string;
  state: DeliveryState;
  idempotencyKey: string;
  reason?: string;
  providerCallId?: string;
};

async function setState(ctx: any, d: Delivery, state: DeliveryState, patch: Record<string, unknown>, detail: Record<string, string | number | boolean> = {}): Promise<void> {
  await ctx.db.patch(deliveries, d.id, { ...patch, state, updatedAt: Date.now() });
  await audit(ctx, d.ownerId, `delivery.${state}`, "delivery", d.id, { channel: d.channel, provider: d.provider, ...detail });
}

/** The canonical external payload hash: what was approved, as it would be sent. */
async function payloadHash(p: { to: string; subject: string; body: string }): Promise<string> {
  return sha256(JSON.stringify([p.to.trim().toLowerCase(), p.subject, p.body]));
}

/**
 * In-app delivery. Run by the job "deliveries.dispatch" as the person who approved. Idempotent: a
 * delivery that is no longer queued is left as it is, so a retried job does nothing twice.
 */
export const dispatch = app.mutation({
  access: "connector.execute",
  retry: { sequenceConflicts: 3 },
  args: { deliveryId: s.string() },
  returns: s.object({ state: s.string() }),
  handler: async (ctx, { deliveryId }) => {
    const d = await owned<Delivery>(ctx, deliveries, deliveryId, "delivery");
    if (d.state !== "queued") return { state: d.state };
    if (d.channel !== "in_app") fail("FAILED_PRECONDITION", "Only in-app deliveries are dispatched by the app.");
    const intro = (await ctx.db.get(introductions, d.introductionId)) as Intro | null;
    if (!intro) {
      await setState(ctx, d, "failed", { reason: "The introduction no longer exists." });
      return { state: "failed" };
    }
    const approval = await ctx.db.get(approvals, d.approvalId);
    const { hash, reviewable } = await reviewFor(ctx, intro, "in_app");
    const now = Date.now();
    const check = checkApproval(approval ? { ...approval, id: approval.id } : null, { hash, recipient: reviewable.recipient, state: intro.state, ...(intro.approvalId ? { approvalId: intro.approvalId } : {}) }, now);
    if (!check.ok) {
      await setState(ctx, d, "failed", { reason: check.reason, determinedBy: "refusal" });
      return { state: "failed" };
    }
    const recipient = intro.recipientUserId!;
    // The requester's side of the double opt-in: what they agreed to disclose if the recipient accepts.
    await ctx.db.insert(consentGrants, { grantorId: intro.ownerId, granteeId: recipient, introductionId: intro.id, purpose: `Introduction ${intro.id}`, fields: approval!.requesterFields, channel: "in_app", expiresAt: now + GRANT_TTL_MS, createdAt: now });
    await ctx.db.patch(approvals, approval!.id, { consumedAt: now });
    await move(ctx, intro, "consent_requested", { requestedAt: now, expiresAt: now + REQUEST_TTL_MS });
    await setState(ctx, d, "sent", { determinedBy: "commit" });
    const mine = await profileOf(ctx, intro.ownerId);
    ctx.afterCommit.notifications.send({ recipient, type: "introduction.requested", title: `${mine?.displayName ?? intro.ownerId} asked to be introduced`, data: { introductionId: intro.id }, idempotencyKey: d.idempotencyKey });
    return { state: "sent" };
  },
});

/**
 * Prepares an external send of the approved introduction: re-checks the approval (unexpired, not
 * used, content and recipient unchanged) and returns the exact payload and idempotency key the
 * client must use with the `delivery.send` capability. Calling it again returns the same delivery.
 */
export const prepareExternal = app.mutation({
  access: "delivery.send",
  approval: "required",
  retry: { sequenceConflicts: 3 },
  args: { introductionId: s.string() },
  returns: s.union([
    s.object({ ok: s.literal(true), deliveryId: s.string(), idempotencyKey: s.string(), capability: s.string(), input: s.object({ deliveryId: s.string(), to: s.string(), subject: s.string(), body: s.string() }) }),
    s.object({ ok: s.literal(false), reason: s.string(), deliveryId: s.nullable(s.string()) }),
  ]),
  handler: async (ctx, { introductionId }) => {
    const actor = me(ctx);
    if (actor.type !== "user") fail("FORBIDDEN", "Only a person can send an introduction.");
    const intro = await owned<Intro>(ctx, introductions, introductionId, "introduction");
    if (intro.channel !== "external") fail("FAILED_PRECONDITION", "This introduction was not approved for external delivery.");
    const approval = intro.approvalId ? await ctx.db.get(approvals, intro.approvalId) : null;
    const { hash, reviewable, email } = await reviewFor(ctx, intro, "external");
    const mine = await profileOf(ctx, intro.ownerId);
    const input = (deliveryId: string) => ({ deliveryId, to: email ?? "", subject: subjectFor(mine?.displayName ?? intro.ownerId), body: approval!.message });

    // Same approval, delivery already prepared: hand back the same payload and key (FeltKit dedups the call).
    const existing = await currentDelivery(ctx, intro);
    if (existing && existing.channel === "external" && existing.state === "queued") {
      return { ok: true as const, deliveryId: existing.id, idempotencyKey: existing.idempotencyKey, capability: "delivery.send", input: input(existing.id) };
    }
    if (existing && existing.channel === "external" && existing.determinedBy !== "refusal" && existing.state !== "failed") {
      return { ok: false as const, reason: `This approval already has a delivery that is ${existing.state}. ${existing.state === "unknown" ? "It is never resent; settle its outcome first." : ""}`.trim(), deliveryId: existing.id };
    }
    const check = checkApproval(approval ? { ...approval, id: approval.id } : null, { hash, recipient: reviewable.recipient, state: intro.state, ...(intro.approvalId ? { approvalId: intro.approvalId } : {}) }, Date.now());
    if (!check.ok) {
      // Record why nothing was sent, against the approval that was refused.
      if (approval) {
        const now = Date.now();
        const id = await ctx.db.insert(deliveries, { ownerId: intro.ownerId, introductionId, approvalId: approval.id, channel: "external", provider: "integration:delivery", state: "failed", reason: check.reason, determinedBy: "refusal", idempotencyKey: `${intro.idempotencyKey}:${approval.id}:refused:${now}`, createdAt: now, updatedAt: now });
        await audit(ctx, intro.ownerId, "delivery.failed", "delivery", id, { channel: "external", provider: "integration:delivery", determinedBy: "refusal" });
        return { ok: false as const, reason: check.reason, deliveryId: id };
      }
      return { ok: false as const, reason: check.reason, deliveryId: null };
    }
    const now = Date.now();
    const idempotencyKey = `${intro.idempotencyKey}:${approval!.id}`;
    const deliveryId = await ctx.db.insert(deliveries, { ownerId: intro.ownerId, introductionId, approvalId: approval!.id, channel: "external", provider: "integration:delivery", state: "queued", idempotencyKey, createdAt: now, updatedAt: now });
    await ctx.db.patch(approvals, approval!.id, { consumedAt: now });
    await audit(ctx, intro.ownerId, "delivery.queued", "delivery", deliveryId, { channel: "external", provider: "integration:delivery" });
    return { ok: true as const, deliveryId, idempotencyKey, capability: "delivery.send", input: input(deliveryId) };
  },
});

const Call = s.object(
  {
    id: s.string(),
    state: s.string(),
    // FeltKit sends null for fields a call does not have yet (e.g. determinedBy on an unknown call).
    input: s.optional(s.unknown()),
    output: s.optional(s.unknown()),
    status: s.optional(s.nullable(s.number())),
    determinedBy: s.optional(s.nullable(s.string())),
    error: s.optional(s.unknown()),
    idempotencyKey: s.optional(s.nullable(s.string())),
  },
  { additionalProperties: true },
);

/**
 * `onOutcome` of the `delivery.send` integration operation. FeltKit runs it as the caller with the
 * call record when the call finishes (including `unknown`) and again when verification settles it.
 * Idempotent by call id: the call record is authoritative, so its latest state wins.
 */
export const onExternalOutcome = app.mutation({
  access: "delivery.send",
  retry: { sequenceConflicts: 3 },
  args: { call: Call },
  handler: async (ctx, { call }) => {
    const actor = me(ctx);
    const input = (call.input ?? {}) as { deliveryId?: string; to?: string; subject?: string; body?: string };
    const d = input.deliveryId ? ((await ctx.db.get(deliveries, input.deliveryId)) as (Delivery & { providerCallId?: string; state: DeliveryState }) | null) : null;
    if (!d || d.ownerId !== actor.id || d.channel !== "external") {
      // A send that the app did not prepare. It happened (or may have); record that, without content.
      await audit(ctx, actor.id, "delivery.untracked_send", "integration_call", call.id, { state: call.state });
      return;
    }
    const state = deliveryStateFromCall(call.state);
    if (!state) return;
    if (d.providerCallId && d.providerCallId !== call.id && d.state === "sent") return; // a later stray call cannot overwrite a confirmed delivery

    // Compare what was sent with what was approved.
    const approval = await ctx.db.get(approvals, d.approvalId);
    const intro = (await ctx.db.get(introductions, d.introductionId)) as Intro | null;
    const mine = intro ? await profileOf(ctx, intro.ownerId) : null;
    const approvedTo = approval?.recipient.startsWith("email:") ? approval.recipient.slice("email:".length) : "";
    const expected = approval ? await payloadHash({ to: approvedTo, subject: subjectFor(mine?.displayName ?? actor.id), body: approval.message }) : "";
    const sent = await payloadHash({ to: input.to ?? "", subject: input.subject ?? "", body: input.body ?? "" });
    const contentMismatch = Boolean(approval) && expected !== sent;

    const error = (call.error ?? null) as { code?: string; message?: string } | null;
    const output = (call.output ?? null) as { id?: string } | null;
    const reason =
      state === "failed" ? `The provider refused it${call.status ? ` (HTTP ${call.status})` : ""}: ${error?.message ?? "no detail"}. Nothing was delivered. Review and approve again to retry.`
      : state === "unknown" ? `The outcome is unknown${call.status ? ` (HTTP ${call.status})` : ""}: it may have been delivered. It will not be resent; it is settled by verifying with the provider's records.`
      : contentMismatch ? "Sent, but the content sent differs from what was approved." : undefined;
    if (d.state === state && d.providerCallId === call.id && !contentMismatch) return; // already recorded
    await setState(
      ctx,
      d,
      state,
      { providerCallId: call.id, ...(call.status ? { providerStatus: call.status } : {}), ...(error?.code ? { providerCode: error.code } : {}), ...(output?.id ? { providerMessageId: String(output.id) } : {}), determinedBy: call.determinedBy ?? "response", reason, contentMismatch },
      { ...(call.status ? { providerStatus: call.status } : {}), ...(error?.code ? { providerCode: error.code } : {}), determinedBy: call.determinedBy ?? "response", contentMismatch },
    );
    if (contentMismatch) await audit(ctx, d.ownerId, "delivery.content_mismatch", "delivery", d.id);
    if (state === "sent" && intro && intro.state === "approved") await move(ctx, intro, "external_sent", { requestedAt: Date.now() });
  },
});

/**
 * The client reports that FeltKit refused a `delivery.send` call before any request left
 * (NOT_CONFIGURED, FORBIDDEN, …). Only those codes are accepted: anything that may have reached
 * the provider is recorded by FeltKit's call record through `onExternalOutcome`, never by the client.
 */
export const recordNotSent = app.mutation({
  access: "connector.execute",
  retry: { sequenceConflicts: 3 },
  args: { deliveryId: s.string(), code: s.enum(NOT_SENT_CODES), message: s.string({ maxLength: 500 }) },
  handler: async (ctx, { deliveryId, code, message }) => {
    const d = await owned<Delivery>(ctx, deliveries, deliveryId, "delivery");
    if (d.channel !== "external") fail("FAILED_PRECONDITION", "Only an external delivery can be refused by the provider boundary.");
    if (d.state !== "queued" || d.providerCallId) return; // a call record exists or it was settled: that is authoritative
    await setState(ctx, d, "failed", { providerCode: code, determinedBy: "refusal", reason: `Not sent: ${message}` }, { providerCode: code, determinedBy: "refusal" });
  },
});

/** What this person can use to deliver, as far as the app knows. Provider configuration is probed through FeltKit (`delivery.health`). */
export const readiness = app.query({
  access: "connector.read",
  handler: async (ctx) => {
    const ownerId = me(ctx).id;
    const all = await ctx.db.find(deliveries, { ownerId });
    const count = (st: DeliveryState) => all.filter((d) => d.state === st).length;
    return {
      inApp: { available: true, detail: "Members receive requests in the app and a notification." },
      external: {
        authority: ctx.auth.has("delivery.send"),
        capability: "delivery.send",
        healthCapability: "delivery.health",
        configuration: ["DELIVERY_PROVIDER_URL", "FELTKIT_CREDENTIAL_DELIVERY (or Studio → Integrations → Set key)"],
      },
      manual: { available: true, detail: "Always available: you send the approved text yourself and record it." },
      deliveries: { queued: count("queued"), sent: count("sent"), failed: count("failed"), unknown: count("unknown"), manualActionRequired: count("manual_action_required") },
    };
  },
});

/** Delivery attempts for one introduction (owner only), newest first. */
export const forIntroduction = app.query({
  access: "connector.read",
  args: { introductionId: s.string() },
  handler: async (ctx, { introductionId }) => {
    const intro = await owned<Intro>(ctx, introductions, introductionId, "introduction");
    const latest = await currentDelivery(ctx, intro);
    return { status: displayStatus(intro, latest), deliveries: (await ctx.db.find(deliveries, { introductionId })).sort((a, b) => b.createdAt - a.createdAt) };
  },
});
