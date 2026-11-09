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
import { app, blocks, briefs, consentGrants, evidence, introductionEvents, introductions, matches, people, profiles, SHAREABLE_FIELDS } from "./app.js";
import { audit, currentEvidence, ensureSource, me, owned, relationshipState, transitionRelationship } from "./_access.js";
import { canMoveIntroduction, isExcluded, scanDisclosure, type IntroState } from "./_rules.js";
import { truncate } from "./_text.js";

export const REQUEST_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const GRANT_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const DAILY_REQUEST_LIMIT = 10;

type Field = (typeof SHAREABLE_FIELDS)[number];
type Intro = {
  id: string;
  __version: number;
  ownerId: string;
  briefId: string;
  matchId: string;
  personId: string;
  recipientUserId?: string;
  path: "participant" | "manual";
  state: IntroState;
  sharedContext: string;
  requesterFields: Field[];
  message: string;
  idempotencyKey: string;
  requestedAt?: number;
  expiresAt?: number;
  followUpAt?: number;
  outcomeNote?: string;
  createdAt: number;
  updatedAt: number;
};
type Brief = { ownerId: string; target: string; topics: string[]; confidential: boolean; excludedOrganizations: string[]; excludedPersonIds: string[]; geography?: string };

async function move(ctx: any, intro: Intro, to: IntroState, patch: Partial<Intro> = {}): Promise<void> {
  if (!canMoveIntroduction(intro.state, to)) fail("FAILED_PRECONDITION", `An introduction that is ${intro.state.replace("_", " ")} cannot become ${to.replace("_", " ")}.`);
  const now = Date.now();
  await ctx.db.patch(introductions, intro.id, { ...patch, state: to, updatedAt: now });
  await ctx.db.insert(introductionEvents, { introductionId: intro.id, from: intro.state, to, actorId: me(ctx).id, seq: await ctx.db.sequence(`intro:${intro.id}`), at: now });
  await audit(ctx, intro.ownerId, `introduction.${to}`, "introduction", intro.id);
}

async function profileOf(ctx: any, userId: string) {
  return (await ctx.db.find(profiles, { ownerId: userId }))[0] ?? null;
}

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
    const open = (await ctx.db.find(introductions, { matchId })).find((i) => ["draft", "consent_requested", "manual_ready", "introduced"].includes(i.state));
    if (open) return open.id;

    const brief = await owned<Brief>(ctx, briefs, m.briefId, "brief");
    const person = await owned<{ ownerId: string; name: string; organization?: string; linkedUserId?: string }>(ctx, people, m.personId, "person");
    const ev = await currentEvidence(ctx, ownerId, person.id);
    if (brief.confidential && isExcluded({ personId: person.id, name: person.name, ...(person.organization ? { organization: person.organization } : {}), relationshipState: "unknown", evidence: ev }, brief)) {
      fail("FAILED_PRECONDITION", "This person is excluded by your confidential search.");
    }
    const mine = await profileOf(ctx, ownerId);
    const state = await relationshipState(ctx, ownerId, person.id);
    const who = mine?.displayName ?? ownerId;
    const first = person.name.split(/\s+/)[0];

    // Minimum necessary context: what is sought, and only shareable evidence for "why you".
    const why = ev.find((e) => e.scope === "shareable");
    const sharedContext = brief.confidential
      ? `${who} is privately exploring opportunities related to ${brief.topics.join(", ")}.`
      : `${who}${mine?.headline ? ` (${mine.headline})` : ""} is looking for ${brief.target || brief.topics.join(", ")}.${why ? ` Why you: ${truncate(why.claim, 300)}` : ""}`;
    const greeting = state === "unknown" || state === "observed" || state === "introducible" ? `Hi ${first} — we haven't met.` : `Hi ${first},`;
    const message = `${greeting} ${sharedContext} Would you be open to a short conversation? If not, no reply is needed.`;

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
    if (intro.state !== "draft") fail("FAILED_PRECONDITION", "Only a draft can be edited.");
    await ctx.db.patch(introductions, id, { sharedContext: sharedContext.trim(), message: message.trim(), requesterFields: [...new Set(requesterFields)], updatedAt: Date.now() });
    await audit(ctx, intro.ownerId, "introduction.edited", "introduction", id);
  },
});

/**
 * The owner approves the exact draft they previewed (`version`). Checks, in order: the preview is
 * current, the recipient has not blocked the owner, the daily request limit, a confidential brief's
 * exclusions, and the outbound disclosure scan. Approving twice is a no-op, not a second request.
 */
export const approve = app.mutation({
  access: "connector.execute",
  approval: "required",
  retry: { sequenceConflicts: 3 },
  args: { id: s.string(), version: s.number() },
  returns: s.object({ state: s.string(), alreadyApplied: s.boolean() }),
  handler: async (ctx, { id, version }) => {
    const ownerId = me(ctx).id;
    const intro = await owned<Intro>(ctx, introductions, id, "introduction");
    if (intro.state === "consent_requested" || intro.state === "manual_ready") return { state: intro.state, alreadyApplied: true };
    if (intro.state !== "draft") fail("FAILED_PRECONDITION", `This introduction is ${intro.state}; only a draft can be approved.`);
    if (intro.__version !== version) fail("FAILED_PRECONDITION", "The draft changed after you reviewed it. Review the current text and approve again.");

    const brief = await owned<Brief>(ctx, briefs, intro.briefId, "brief");
    const person = await ctx.db.get(people, intro.personId);
    const ev = await currentEvidence(ctx, ownerId, intro.personId);
    if (brief.confidential && person && isExcluded({ personId: person.id, name: person.name, ...(person.organization ? { organization: person.organization } : {}), relationshipState: "unknown", evidence: ev }, brief)) {
      fail("FAILED_PRECONDITION", "This person is excluded by your confidential search.");
    }
    const mine = await profileOf(ctx, ownerId);
    const allowed = intro.requesterFields.includes("email") && mine?.email ? [mine.email] : [];
    const issues = scanDisclosure({ text: `${intro.sharedContext}\n${intro.message}`, allowed, excludedOrganizations: brief.excludedOrganizations, confidential: brief.confidential });
    if (issues.length) fail("FAILED_PRECONDITION", `Not sent. ${issues.join(" ")}`, { issues });

    const now = Date.now();
    const current = await relationshipState(ctx, intro.ownerId, intro.personId);
    if (intro.path === "manual" && (current === "unknown" || current === "observed")) {
      await move(ctx, intro, "manual_ready");
      return { state: "manual_ready", alreadyApplied: false };
    }

    const recipient = intro.recipientUserId!;
    if ((await ctx.db.find(blocks, { blockerId: recipient, blockedId: ownerId })).length) fail("FAILED_PRECONDITION", "This person is not accepting introduction requests from you.");
    const recent = (await ctx.db.find(introductions, { ownerId })).filter((i) => (i.requestedAt ?? 0) > now - 24 * 60 * 60 * 1000).length;
    if (recent >= DAILY_REQUEST_LIMIT) fail("FAILED_PRECONDITION", `You have sent ${DAILY_REQUEST_LIMIT} requests in the last 24 hours. Try again later.`);

    // The owner's side of the double opt-in: what they agree to disclose if the recipient accepts.
    await ctx.db.insert(consentGrants, { grantorId: ownerId, granteeId: recipient, introductionId: id, purpose: `Introduction ${id}`, fields: intro.requesterFields, channel: "in_app", expiresAt: now + GRANT_TTL_MS, createdAt: now });
    await move(ctx, intro, "consent_requested", { requestedAt: now, expiresAt: now + REQUEST_TTL_MS });
    ctx.afterCommit.notifications.send({ recipient, type: "introduction.requested", title: `${mine?.displayName ?? ownerId} asked to be introduced`, data: { introductionId: id }, idempotencyKey: `${intro.idempotencyKey}:requested` });
    return { state: "consent_requested", alreadyApplied: false };
  },
});

/** Manual path: the owner records that they sent the approved text themselves, outside the app. */
export const markSent = app.mutation({
  access: "connector.execute",
  approval: "required",
  retry: { sequenceConflicts: 3 },
  args: { id: s.string() },
  handler: async (ctx, { id }) => {
    const intro = await owned<Intro>(ctx, introductions, id, "introduction");
    if (intro.state === "manual_sent") return;
    await move(ctx, intro, "manual_sent", { requestedAt: Date.now() });
  },
});

export const withdraw = app.mutation({
  access: "connector.write",
  retry: { sequenceConflicts: 3 },
  args: { id: s.string() },
  handler: async (ctx, { id }) => {
    const intro = await owned<Intro>(ctx, introductions, id, "introduction");
    if (intro.state === "withdrawn") return;
    await move(ctx, intro, "withdrawn");
    for (const g of await ctx.db.find(consentGrants, { introductionId: id, grantorId: intro.ownerId })) if (!g.revokedAt) await ctx.db.patch(consentGrants, g.id, { revokedAt: Date.now() });
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
    if (!intro || intro.recipientUserId !== userId || intro.state === "draft") fail("NOT_FOUND", `No introduction request ${id}.`);
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
    return Promise.all(all.map(async (i) => ({ id: i.id, state: i.state, path: i.path, personId: i.personId, personName: (await ctx.db.get(people, i.personId))?.name ?? "(deleted)", briefId: i.briefId, followUpAt: i.followUpAt ?? null, updatedAt: i.updatedAt, expiresAt: i.expiresAt ?? null })));
  },
});

/** Requests addressed to the caller. Shows only what the requester chose to share. */
export const incoming = app.query({
  access: "connector.read",
  handler: async (ctx) => {
    const userId = me(ctx).id;
    const all = ((await ctx.db.find(introductions, { recipientUserId: userId })) as Intro[]).filter((i) => i.state !== "draft").sort((a, b) => b.updatedAt - a.updatedAt);
    return Promise.all(
      all.map(async (i) => ({ id: i.id, state: i.state, from: (await profileOf(ctx, i.ownerId))?.displayName ?? i.ownerId, sharedContext: i.sharedContext, message: i.message, expiresAt: i.expiresAt ?? null, disclosed: await disclosed(ctx, i, i.ownerId, userId), myConsentActive: Boolean(activeGrant(await ctx.db.find(consentGrants, { introductionId: i.id }), userId, i.ownerId, Date.now())) })),
    );
  },
});

/** The owner's full view of one introduction: the exact text, its history, and what has been disclosed to them. */
export const get = app.query({
  access: "connector.read",
  args: { id: s.string() },
  handler: async (ctx, { id }) => {
    const intro = await owned<Intro>(ctx, introductions, id, "introduction");
    const person = await ctx.db.get(people, intro.personId);
    const events = await ctx.db.find(introductionEvents, { introductionId: id }, { orderBy: [{ field: "seq", direction: "asc" }] });
    const grants = await ctx.db.find(consentGrants, { introductionId: id });
    return {
      ...intro,
      personName: person?.name ?? "(deleted)",
      events,
      disclosed: intro.recipientUserId ? await disclosed(ctx, intro, intro.recipientUserId, intro.ownerId) : {},
      myConsentActive: Boolean(intro.recipientUserId && activeGrant(grants, intro.ownerId, intro.recipientUserId, Date.now())),
    };
  },
});
