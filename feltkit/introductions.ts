/**
 * The introduction workflow: draft → (owner approves the exact preview) → consent request →
 * recipient accepts or declines → introduced → completed. Every transition goes through
 * INTRO_TRANSITIONS, writes an introductionEvent and an audit event, and every outbound effect
 * carries the introduction's idempotency key.
 *
 * Two delivery paths exist, and only these:
 * - participant: the recipient is a member; the request and the answer happen in-app.
 * - manual: no outbound connector is configured in this MVP, so the owner sends the approved text
 *   themselves and records that they did. The app never claims to have delivered it.
 */
import { fail, s } from "@feltdb/feltkit";
import { app, approvals, blocks, briefs, consentGrants, deliveries, DELIVERY_CHANNELS, evidence, introductionEvents, introductions, matches, people, SHAREABLE_FIELDS } from "./app.js";
import { audit, currentEvidence, ensureSource, me, owned, relationshipState, transitionRelationship } from "./_access.js";
import { APPROVAL_TTL_MS, channelOptions, displayStatus } from "./_delivery.js";
import { currentDelivery, DAILY_REQUEST_LIMIT, GRANT_TTL_MS, move, profileOf, reviewFor, type Field, type Intro } from "./_flow.js";
import { isExcluded, scanDisclosure } from "./_rules.js";
import { overlap, truncate } from "./_text.js";

export { DAILY_REQUEST_LIMIT, GRANT_TTL_MS, REQUEST_TTL_MS } from "./_flow.js";

type Brief = { ownerId: string; target: string; topics: string[]; confidential: boolean; excludedOrganizations: string[]; excludedPersonIds: string[]; geography?: string };

function activeGrant(grants: Array<{ grantorId: string; granteeId: string; revokedAt?: number; expiresAt: number; fields: Field[] }>, grantorId: string, granteeId: string, now: number) {
  return grants.find((g) => g.grantorId === grantorId && g.granteeId === granteeId && !g.revokedAt && g.expiresAt > now) ?? null;
}

/** Contact fields disclosed by `grantor` to `grantee` for this introduction: only after both consented, and only while the grant is live. */
async function disclosed(ctx: any, intro: Intro, grantorId: string, granteeId: string): Promise<Partial<Record<Field, string>>> {
  if (intro.state !== "introduced" && intro.state !== "completed") return {};
  const grant = activeGrant(await ctx.db.find(consentGrants, { introductionId: intro.id }), grantorId, granteeId, Date.now());
  if (!grant) return {};
  const profile = await profileOf(ctx, grantorId);
  const out: Partial<Record<Field, string>> = {};
  for (const f of grant.fields) if (profile?.[f]) out[f] = profile[f];
  return out;
}

// ---------------------------------------------------------------------------------------------
// Owner side

/** Drafts an introduction request for a match. Private until the owner approves it. */
export const draft = app.mutation({
  access: "connector.write",
  retry: { sequenceConflicts: 3 },
  args: { matchId: s.string() },
  returns: s.string(),
  handler: async (ctx, { matchId }) => {
    const ownerId = me(ctx).id;
    const m = await owned<{ ownerId: string; briefId: string; personId: string; decision: string }>(ctx, matches, matchId, "match");
    if (m.decision === "rejected") fail("FAILED_PRECONDITION", "You rejected this match. Change the decision before drafting an introduction.");
    const open = (await ctx.db.find(introductions, { matchId })).find((i) => ["draft", "approved", "consent_requested", "manual_ready", "introduced", "external_sent"].includes(i.state));
    if (open) return open.id;

    const brief = await owned<Brief>(ctx, briefs, m.briefId, "brief");
    const person = await owned<{ ownerId: string; name: string; organization?: string; linkedUserId?: string }>(ctx, people, m.personId, "person");
    const ev = await currentEvidence(ctx, ownerId, person.id);
    if (brief.confidential && isExcluded({ personId: person.id, ...(person.organization ? { organization: person.organization } : {}), evidence: ev }, brief)) {
      fail("FAILED_PRECONDITION", "This person is excluded by your confidential search.");
    }
    const mine = await profileOf(ctx, ownerId);
    const state = await relationshipState(ctx, ownerId, person.id);
    const who = mine?.displayName ?? ownerId;
    const first = person.name.split(/\s+/)[0];

    // Minimum necessary context: what is sought, and why this person. Private evidence (your notes,
    // imported contacts) is never quoted; a participant is told which of their own topics matched.
    const participantEv = ev.find((e) => e.sourceType === "participant_statement");
    const publicEv = ev.find((e) => e.sourceType === "public_url");
    const matched = participantEv ? [...new Set(overlap(participantEv.topics, brief.topics))] : [];
    const why = matched.length ? ` Why you: you said you take requests about ${matched.join(", ")}.` : publicEv ? ` Why you: ${truncate(publicEv.claim, 300)} (${publicEv.sourceRef})` : "";
    const sharedContext = brief.confidential
      ? `${who} is privately exploring opportunities related to ${brief.topics.join(", ")}.`
      : `${who}${mine?.headline ? ` (${mine.headline})` : ""} is looking for ${brief.target || brief.topics.join(", ")}.${why}`;
    const greeting = state === "unknown" || state === "observed" || state === "introducible" ? `Hi ${first} — we haven't met.` : `Hi ${first},`;
    const ask = "Would you be open to a short conversation? If not, no reply is needed.";
    // In-app requests show the shared context beside the message, so the message does not repeat it.
    const message = person.linkedUserId ? `${greeting} ${ask}` : `${greeting} ${sharedContext} ${ask}`;

    const n = (await ctx.db.count(introductions, { matchId })) + 1;
    const now = Date.now();
    const id = await ctx.db.insert(introductions, {
      ownerId,
      briefId: m.briefId,
      matchId,
      personId: person.id,
      ...(person.linkedUserId ? { recipientUserId: person.linkedUserId } : {}),
      path: person.linkedUserId ? "participant" : "manual",
      state: "draft",
      sharedContext,
      requesterFields: brief.confidential ? [] : ["headline"],
      message,
      idempotencyKey: `intro:${matchId}:${n}`,
      createdAt: now,
      updatedAt: now,
    });
    await audit(ctx, ownerId, "introduction.drafted", "introduction", id, { path: person.linkedUserId ? "participant" : "manual" });
    return id;
  },
});

export const edit = app.mutation({
  access: "connector.write",
  retry: { sequenceConflicts: 3 },
  args: { id: s.string(), sharedContext: s.string({ minLength: 1, maxLength: 2000 }), message: s.string({ minLength: 1, maxLength: 4000 }), requesterFields: s.array(s.enum(SHAREABLE_FIELDS)) },
  handler: async (ctx, { id, sharedContext, message, requesterFields }) => {
    const intro = await owned<Intro>(ctx, introductions, id, "introduction");
    if (intro.state !== "draft") fail("FAILED_PRECONDITION", "Only a draft can be edited. Withdraw it and draft again to change approved text.");
    await ctx.db.patch(introductions, id, { sharedContext: sharedContext.trim(), message: message.trim(), requesterFields: [...new Set(requesterFields)], updatedAt: Date.now() });
    await audit(ctx, intro.ownerId, "introduction.edited", "introduction", id);
  },
});

/**
 * A person approves the exact content they reviewed, for one channel. `contentHash` is the hash the
 * review screen showed (introductions:get → channels[].hash); it covers the text, the fields the
 * requester will share, the channel and the recipient. If anything changed since, approval is
 * refused. The approval record keeps that content, recipient, channel and an expiry.
 *
 * Then, by channel:
 * - in_app:   a delivery is queued and dispatched after commit by the job "deliveries.dispatch",
 *             which re-validates the approval before the request becomes visible to the recipient.
 * - external: nothing is sent yet. The person sends it (deliveries:prepareExternal, then the
 *             `delivery.send` integration capability), which needs the delivery.send permission.
 * - manual:   the person must send it themselves (state manual_action_required).
 *
 * Approving the same content again while its delivery is in progress is a no-op.
 */
export const approve = app.mutation({
  access: "connector.execute",
  approval: "required",
  retry: { sequenceConflicts: 3 },
  args: { id: s.string(), channel: s.enum(DELIVERY_CHANNELS), contentHash: s.string() },
  returns: s.object({ state: s.string(), status: s.string(), approvalId: s.string(), deliveryId: s.nullable(s.string()), alreadyApplied: s.boolean() }),
  handler: async (ctx, { id, channel, contentHash }) => {
    const actor = me(ctx);
    if (actor.type !== "user") fail("FORBIDDEN", "Only a person can approve an introduction.");
    const ownerId = actor.id;
    const intro = await owned<Intro>(ctx, introductions, id, "introduction");
    const { reviewable, hash, email } = await reviewFor(ctx, intro, channel);

    // Idempotent: the same content, already approved for the same channel, with its delivery in progress or done.
    if (intro.state !== "draft" && intro.approvalId) {
      const prior = await ctx.db.get(approvals, intro.approvalId);
      const latest = await currentDelivery(ctx, intro);
      const settledBad = !latest || latest.state === "failed";
      const expired = prior && prior.expiresAt <= Date.now() && !prior.consumedAt;
      if (prior && prior.contentHash === contentHash && prior.channel === channel && !(intro.state === "approved" && (settledBad || expired))) {
        return { state: intro.state, status: displayStatus(intro, latest), approvalId: prior.id, deliveryId: latest?.id ?? null, alreadyApplied: true };
      }
    }
    if (intro.state !== "draft" && intro.state !== "approved") fail("FAILED_PRECONDITION", `This introduction is ${intro.state.replace("_", " ")}; it cannot be approved again.`);
    if (intro.state === "approved") {
      const latest = await currentDelivery(ctx, intro);
      if (latest && (latest.state === "queued" || latest.state === "unknown")) fail("FAILED_PRECONDITION", `A delivery is ${latest.state}. ${latest.state === "unknown" ? "Its outcome must be settled before anything is approved again; it is never resent automatically." : "Wait for it to finish."}`);
    }
    if (contentHash !== hash) fail("FAILED_PRECONDITION", "The content, recipient or channel changed after you reviewed it. Review the current text and approve again.");

    const person = await ctx.db.get(people, intro.personId);
    const options = channelOptions({ participant: Boolean(intro.recipientUserId), hasEmail: Boolean(email), mayDeliverExternally: ctx.auth.has("delivery.send") });
    const option = options.find((o) => o.channel === channel);
    if (!option) fail("FAILED_PRECONDITION", `The ${channel.replace("_", "-")} channel does not apply to this introduction.`);
    if (!option.available) fail("FORBIDDEN", option.reason ?? `The ${channel} channel is not available.`);

    const brief = await owned<Brief>(ctx, briefs, intro.briefId, "brief");
    const ev = await currentEvidence(ctx, ownerId, intro.personId);
    if (brief.confidential && person && isExcluded({ personId: person.id, ...(person.organization ? { organization: person.organization } : {}), evidence: ev }, brief)) {
      fail("FAILED_PRECONDITION", "This person is excluded by your confidential search.");
    }
    const mine = await profileOf(ctx, ownerId);
    const allowed = intro.requesterFields.includes("email") && mine?.email ? [mine.email] : [];
    const issues = scanDisclosure({ text: `${intro.sharedContext}\n${intro.message}`, allowed, excludedOrganizations: brief.excludedOrganizations, confidential: brief.confidential });
    if (issues.length) fail("FAILED_PRECONDITION", `Not approved. ${issues.join(" ")}`, { issues });

    const now = Date.now();
    if (channel === "in_app") {
      if ((await ctx.db.find(blocks, { blockerId: intro.recipientUserId!, blockedId: ownerId })).length) fail("FAILED_PRECONDITION", "This person is not accepting introduction requests from you.");
    }
    if (channel !== "manual") {
      const recent = (await ctx.db.find(approvals, { ownerId })).filter((a) => a.channel !== "manual" && a.approvedAt > now - 24 * 60 * 60 * 1000).length;
      if (recent >= DAILY_REQUEST_LIMIT) fail("FAILED_PRECONDITION", `You have approved ${DAILY_REQUEST_LIMIT} requests in the last 24 hours. Try again later.`);
    }

    // Replace any earlier approval: only one is ever in force.
    for (const a of await ctx.db.find(approvals, { introductionId: id })) if (!a.supersededAt && !a.consumedAt) await ctx.db.patch(approvals, a.id, { supersededAt: now });
    const approvalId = await ctx.db.insert(approvals, {
      ownerId,
      introductionId: id,
      approverId: actor.id,
      approverType: actor.type,
      channel,
      recipient: reviewable.recipient,
      sharedContext: reviewable.sharedContext,
      message: reviewable.message,
      requesterFields: reviewable.requesterFields,
      contentHash: hash,
      approvedAt: now,
      expiresAt: now + APPROVAL_TTL_MS,
    });
    await audit(ctx, ownerId, "introduction.content_approved", "introduction", id, { approvalId, channel, expiresAt: now + APPROVAL_TTL_MS });
    if (intro.state === "draft") await move(ctx, intro, "approved", { channel, approvalId });
    else await ctx.db.patch(introductions, id, { channel, approvalId, updatedAt: now });
    intro.approvalId = approvalId;

    let deliveryId: string | null = null;
    if (channel === "in_app") {
      deliveryId = await ctx.db.insert(deliveries, { ownerId, introductionId: id, approvalId, channel, provider: "in_app", state: "queued", idempotencyKey: `${intro.idempotencyKey}:${approvalId}`, createdAt: now, updatedAt: now });
      await audit(ctx, ownerId, "delivery.queued", "delivery", deliveryId, { channel, provider: "in_app" });
      ctx.afterCommit.jobs.enqueue("deliveries.dispatch", { deliveryId });
    } else if (channel === "manual") {
      deliveryId = await ctx.db.insert(deliveries, { ownerId, introductionId: id, approvalId, channel, provider: "manual", state: "manual_action_required", reason: "No provider was used. Copy the approved text, send it yourself, then record that you did.", idempotencyKey: `${intro.idempotencyKey}:${approvalId}`, createdAt: now, updatedAt: now });
      await ctx.db.patch(approvals, approvalId, { consumedAt: now });
      await audit(ctx, ownerId, "delivery.manual_action_required", "delivery", deliveryId, { channel });
      await move(ctx, intro, "manual_ready");
    }
    const latest = deliveryId ? await ctx.db.get(deliveries, deliveryId) : null;
    return { state: intro.state, status: displayStatus(intro, latest), approvalId, deliveryId, alreadyApplied: false };
  },
});

/** Manual path: the owner records that they sent the approved text themselves, outside the app. */
export const markSent = app.mutation({
  access: "connector.execute",
  approval: "required",
  retry: { sequenceConflicts: 3 },
  args: { id: s.string() },
  handler: async (ctx, { id }) => {
    if (me(ctx).type !== "user") fail("FORBIDDEN", "Only a person can record a manual send.");
    const intro = await owned<Intro>(ctx, introductions, id, "introduction");
    if (intro.state === "manual_sent") return;
    await move(ctx, intro, "manual_sent", { requestedAt: Date.now() });
    const latest = await currentDelivery(ctx, intro);
    if (latest && latest.state === "manual_action_required") {
      await ctx.db.patch(deliveries, latest.id, { state: "sent", determinedBy: "person", reason: "Recorded as sent by you; the app did not deliver it.", updatedAt: Date.now() });
      await audit(ctx, intro.ownerId, "delivery.sent", "delivery", latest.id, { channel: "manual", determinedBy: "person" });
    }
  },
});

export const withdraw = app.mutation({
  access: "connector.write",
  retry: { sequenceConflicts: 3 },
  args: { id: s.string() },
  handler: async (ctx, { id }) => {
    const intro = await owned<Intro>(ctx, introductions, id, "introduction");
    if (intro.state === "withdrawn") return;
    const latest = await currentDelivery(ctx, intro);
    if (latest && latest.channel === "external" && (latest.state === "queued" || latest.state === "unknown")) {
      fail("FAILED_PRECONDITION", `An external delivery is ${latest.state}; withdrawing would not stop it. Settle its outcome first.`);
    }
    await move(ctx, intro, "withdrawn");
    const now = Date.now();
    for (const g of await ctx.db.find(consentGrants, { introductionId: id, grantorId: intro.ownerId })) if (!g.revokedAt) await ctx.db.patch(consentGrants, g.id, { revokedAt: now });
    for (const a of await ctx.db.find(approvals, { introductionId: id })) if (!a.supersededAt && !a.consumedAt) await ctx.db.patch(approvals, a.id, { supersededAt: now });
  },
});

export const setFollowUp = app.mutation({
  access: "connector.write",
  retry: { sequenceConflicts: 3 },
  args: { id: s.string(), at: s.nullable(s.number()) },
  handler: async (ctx, { id, at }) => {
    const intro = await owned<Intro>(ctx, introductions, id, "introduction");
    await ctx.db.patch(introductions, id, { followUpAt: at ?? undefined, updatedAt: Date.now() });
    await audit(ctx, intro.ownerId, at ? "introduction.followup.set" : "introduction.followup.cleared", "introduction", id);
  },
});

/** The owner records what happened. The outcome is private and becomes interaction evidence. */
export const complete = app.mutation({
  access: "connector.write",
  retry: { sequenceConflicts: 3 },
  args: { id: s.string(), note: s.string({ minLength: 1, maxLength: 4000 }) },
  handler: async (ctx, { id, note }) => {
    const intro = await owned<Intro>(ctx, introductions, id, "introduction");
    await move(ctx, intro, "completed", { outcomeNote: note.trim(), followUpAt: undefined });
    const sourceId = await ensureSource(ctx, intro.ownerId, "manual", "Added by hand");
    const person = await ctx.db.get(people, intro.personId);
    if (person && !person.sourceIds.includes(sourceId)) await ctx.db.patch(people, person.id, { sourceIds: [...person.sourceIds, sourceId] });
    const evidenceId = await ctx.db.insert(evidence, { ownerId: intro.ownerId, personId: intro.personId, sourceId, sourceType: "interaction", sourceRef: `introduction:${id}`, claim: note.trim(), topics: [], confidence: 0.95, scope: "private", capturedAt: Date.now(), retracted: false });
    const current = await relationshipState(ctx, intro.ownerId, intro.personId);
    if (intro.path === "manual" && (current === "unknown" || current === "observed")) {
      // A manually sent request is not proof of an introduction; recording an outcome is the owner's attestation of contact.
      await transitionRelationship(ctx, intro.ownerId, intro.personId, "known", "user.attest", [evidenceId]);
    }
    await transitionRelationship(ctx, intro.ownerId, intro.personId, "active", "interaction.recorded", [evidenceId]);
  },
});

// ---------------------------------------------------------------------------------------------
// Recipient side

/**
 * The recipient answers. Accepting creates their consent grant, completing the double opt-in:
 * only then are the chosen contact fields disclosed, both ways. Declining can also block the
 * requester from sending more.
 */
export const respond = app.mutation({
  access: "connector.execute",
  approval: "required",
  retry: { sequenceConflicts: 3 },
  args: { id: s.string(), accept: s.boolean(), fields: s.array(s.enum(SHAREABLE_FIELDS)), block: s.optional(s.boolean()) },
  returns: s.object({ state: s.string() }),
  handler: async (ctx, { id, accept, fields, block }) => {
    const userId = me(ctx).id;
    const intro = (await ctx.db.get(introductions, id)) as Intro | null;
    if (!intro || intro.recipientUserId !== userId || intro.requestedAt === undefined) fail("NOT_FOUND", `No introduction request ${id}.`);
    if ((accept && intro.state === "introduced") || (!accept && intro.state === "declined")) return { state: intro.state };
    if (intro.state === "consent_requested" && intro.expiresAt && intro.expiresAt < Date.now()) {
      await move(ctx, intro, "expired");
      return { state: "expired" };
    }
    if (intro.state !== "consent_requested") fail("FAILED_PRECONDITION", `This request is ${intro.state} and can no longer be answered.`);
    const now = Date.now();
    if (accept) {
      await ctx.db.insert(consentGrants, { grantorId: userId, granteeId: intro.ownerId, introductionId: id, purpose: `Introduction ${id}`, fields: [...new Set(fields)], channel: "in_app", expiresAt: now + GRANT_TTL_MS, createdAt: now });
      await move(ctx, intro, "introduced");
      await transitionRelationship(ctx, intro.ownerId, intro.personId, "introduced", "introduction.introduced", []);
      ctx.afterCommit.notifications.send({ recipient: intro.ownerId, type: "introduction.accepted", title: "Your introduction request was accepted", data: { introductionId: id }, idempotencyKey: `${intro.idempotencyKey}:accepted` });
      return { state: "introduced" };
    }
    await move(ctx, intro, "declined");
    if (block && !(await ctx.db.find(blocks, { blockerId: userId, blockedId: intro.ownerId })).length) {
      await ctx.db.insert(blocks, { blockerId: userId, blockedId: intro.ownerId, createdAt: now });
      await audit(ctx, userId, "requester.blocked", "principal", intro.ownerId);
    }
    ctx.afterCommit.notifications.send({ recipient: intro.ownerId, type: "introduction.declined", title: "Your introduction request was declined", data: { introductionId: id }, idempotencyKey: `${intro.idempotencyKey}:declined` });
    return { state: "declined" };
  },
});

/** Either side withdraws its consent grant. Disclosure stops at once; a message already delivered cannot be recalled. */
export const revokeConsent = app.mutation({
  access: "connector.write",
  retry: { sequenceConflicts: 3 },
  args: { introductionId: s.string() },
  returns: s.integer(),
  handler: async (ctx, { introductionId }) => {
    const userId = me(ctx).id;
    let revoked = 0;
    for (const g of await ctx.db.find(consentGrants, { introductionId, grantorId: userId })) {
      if (g.revokedAt) continue;
      await ctx.db.patch(consentGrants, g.id, { revokedAt: Date.now() });
      revoked++;
    }
    if (!revoked) fail("NOT_FOUND", "You have no active consent for that introduction.");
    await audit(ctx, userId, "consent.revoked", "introduction", introductionId);
    return revoked;
  },
});

/** Expires the caller's unanswered requests past their deadline (outgoing and incoming). Run by the job "introductions.expire-due". */
export const expireDue = app.mutation({
  access: "connector.write",
  retry: { sequenceConflicts: 3 },
  returns: s.object({ expired: s.integer() }),
  handler: async (ctx) => {
    const userId = me(ctx).id;
    const now = Date.now();
    const mine = [...(await ctx.db.find(introductions, { ownerId: userId, state: "consent_requested" })), ...(await ctx.db.find(introductions, { recipientUserId: userId, state: "consent_requested" }))];
    let expired = 0;
    for (const intro of mine) {
      if (intro.expiresAt && intro.expiresAt < now) {
        await move(ctx, intro as Intro, "expired");
        expired++;
      }
    }
    return { expired };
  },
});

// ---------------------------------------------------------------------------------------------
// Reads

export const outgoing = app.query({
  access: "connector.read",
  handler: async (ctx) => {
    const ownerId = me(ctx).id;
    const all = (await ctx.db.find(introductions, { ownerId }, { orderBy: [{ field: "updatedAt", direction: "desc" }] })) as Intro[];
    return Promise.all(
      all.map(async (i) => {
        const latest = await currentDelivery(ctx, i);
        return { id: i.id, state: i.state, status: displayStatus(i, latest), channel: i.channel ?? null, path: i.path, personId: i.personId, personName: (await ctx.db.get(people, i.personId))?.name ?? "(deleted)", briefId: i.briefId, followUpAt: i.followUpAt ?? null, updatedAt: i.updatedAt, expiresAt: i.expiresAt ?? null };
      }),
    );
  },
});

/** Requests addressed to the caller. Shows only what the requester chose to share. */
export const incoming = app.query({
  access: "connector.read",
  handler: async (ctx) => {
    const userId = me(ctx).id;
    // A request exists for its recipient only once it was delivered (requestedAt is set by the in-app dispatch).
    const all = ((await ctx.db.find(introductions, { recipientUserId: userId })) as Intro[]).filter((i) => i.requestedAt !== undefined).sort((a, b) => b.updatedAt - a.updatedAt);
    return Promise.all(
      all.map(async (i) => ({ id: i.id, state: i.state, from: (await profileOf(ctx, i.ownerId))?.displayName ?? i.ownerId, sharedContext: i.sharedContext, message: i.message, expiresAt: i.expiresAt ?? null, disclosed: await disclosed(ctx, i, i.ownerId, userId), myConsentActive: Boolean(activeGrant(await ctx.db.find(consentGrants, { introductionId: i.id }), userId, i.ownerId, Date.now())) })),
    );
  },
});

/**
 * The owner's full view of one introduction: the exact text, the channels it may use with the hash
 * of what would be approved for each, the approval in force, every delivery attempt with its
 * provider outcome, its history, and what has been disclosed to them.
 */
export const get = app.query({
  access: "connector.read",
  args: { id: s.string() },
  handler: async (ctx, { id }) => {
    const intro = await owned<Intro>(ctx, introductions, id, "introduction");
    const person = await ctx.db.get(people, intro.personId);
    const events = await ctx.db.find(introductionEvents, { introductionId: id }, { orderBy: [{ field: "seq", direction: "asc" }] });
    const grants = await ctx.db.find(consentGrants, { introductionId: id });
    const options = channelOptions({ participant: Boolean(intro.recipientUserId), hasEmail: Boolean(person?.email), mayDeliverExternally: ctx.auth.has("delivery.send") });
    const channels = await Promise.all(options.map(async (o) => ({ ...o, hash: (await reviewFor(ctx, intro, o.channel)).hash })));
    const approval = intro.approvalId ? await ctx.db.get(approvals, intro.approvalId) : null;
    const attempts = (await ctx.db.find(deliveries, { introductionId: id })).sort((a, b) => b.createdAt - a.createdAt);
    const latest = await currentDelivery(ctx, intro);
    return {
      ...intro,
      personName: person?.name ?? "(deleted)",
      status: displayStatus(intro, latest),
      channels,
      approval: approval ? { id: approval.id, channel: approval.channel, recipient: approval.recipient.startsWith("email:") ? "external address on file" : approval.recipient, contentHash: approval.contentHash, approvedAt: approval.approvedAt, expiresAt: approval.expiresAt, consumedAt: approval.consumedAt ?? null, expired: approval.expiresAt <= Date.now() && !approval.consumedAt } : null,
      deliveries: attempts.map((d) => ({ id: d.id, channel: d.channel, provider: d.provider, state: d.state, reason: d.reason ?? null, providerStatus: d.providerStatus ?? null, providerCode: d.providerCode ?? null, determinedBy: d.determinedBy ?? null, contentMismatch: d.contentMismatch ?? false, idempotencyKey: d.idempotencyKey, createdAt: d.createdAt, updatedAt: d.updatedAt })),
      events,
      disclosed: intro.recipientUserId ? await disclosed(ctx, intro, intro.recipientUserId, intro.ownerId) : {},
      myConsentActive: Boolean(intro.recipientUserId && activeGrant(grants, intro.ownerId, intro.recipientUserId, Date.now())),
    };
  },
});
