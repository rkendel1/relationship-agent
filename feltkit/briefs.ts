import { fail, s } from "@feltdb/feltkit";
import { app, blocks, briefs, evidence, matches, OPPORTUNITY_TYPES, people, profiles } from "./app.js";
import { audit, currentEvidence, ensureSource, me, owned, relationshipState, transitionRelationship, visiblePeople } from "./_access.js";
import { interpretBrief, INTERPRETER } from "./_intent.js";
import { isExcluded, scoreCandidates, type Candidate } from "./_rules.js";
import { normalizeTopics, overlap } from "./_text.js";

type Brief = { id: string; __version: number; ownerId: string; status: "draft" | "confirmed" | "archived"; topics: string[]; geography?: string; confidential: boolean; excludedOrganizations: string[]; excludedPersonIds: string[] };

export const list = app.query({
  access: "connector.read",
  handler: async (ctx) => ctx.db.find(briefs, { ownerId: me(ctx).id }, { orderBy: [{ field: "createdAt", direction: "desc" }] }),
});

export const get = app.query({
  access: "connector.read",
  args: { id: s.string() },
  handler: async (ctx, { id }) => {
    const brief = await ctx.db.get(briefs, id);
    if (!brief || brief.ownerId !== me(ctx).id) fail("NOT_FOUND", `No brief ${id}.`);
    return brief;
  },
});

/**
 * Interprets a natural-language request into a draft brief. Nothing is searched or sent: the
 * user inspects the interpretation, answers its questions, and confirms it.
 */
export const create = app.mutation({
  access: "connector.advise",
  retry: { sequenceConflicts: 3 },
  args: { text: s.string({ minLength: 1, maxLength: 4000 }) },
  returns: s.string(),
  capability: { name: "briefs.create", description: "Draft an opportunity brief from a natural-language request. Private; the owner confirms it before any search." },
  handler: async (ctx, { text }) => {
    const ownerId = me(ctx).id;
    const it = interpretBrief(text);
    const id = await ctx.db.insert(briefs, { ownerId, text: text.trim(), ...it, excludedPersonIds: [], interpretedBy: INTERPRETER, status: "draft", createdAt: Date.now() });
    await audit(ctx, ownerId, "brief.drafted", "brief", id, { interpretedBy: INTERPRETER });
    return id;
  },
});

/** The owner edits the interpretation. Editing a confirmed brief returns it to draft. */
export const update = app.mutation({
  access: "connector.write",
  retry: { sequenceConflicts: 3 },
  args: {
    id: s.string(),
    opportunityType: s.enum(OPPORTUNITY_TYPES),
    target: s.string({ maxLength: 300 }),
    topics: s.array(s.string({ maxLength: 80 }), { maxItems: 30 }),
    geography: s.optional(s.string({ maxLength: 120 })),
    timing: s.optional(s.string({ maxLength: 120 })),
    successCondition: s.optional(s.string({ maxLength: 400 })),
    confidential: s.boolean(),
    excludedOrganizations: s.array(s.string({ maxLength: 160 }), { maxItems: 30 }),
    excludedPersonIds: s.array(s.string(), { maxItems: 200 }),
  },
  handler: async (ctx, { id, ...fields }) => {
    const brief = await owned<Brief>(ctx, briefs, id, "brief");
    if (brief.status === "archived") fail("FAILED_PRECONDITION", "An archived brief cannot be edited.");
    const opt = (v?: string) => (v?.trim() ? v.trim() : undefined);
    await ctx.db.patch(briefs, id, {
      opportunityType: fields.opportunityType,
      target: fields.target.trim(),
      topics: normalizeTopics(fields.topics),
      geography: opt(fields.geography),
      timing: opt(fields.timing),
      successCondition: opt(fields.successCondition),
      confidential: fields.confidential,
      excludedOrganizations: fields.excludedOrganizations.map((o) => o.trim()).filter(Boolean),
      excludedPersonIds: fields.excludedPersonIds,
      questions: [],
      status: "draft",
      confirmedAt: undefined,
    });
    await audit(ctx, brief.ownerId, "brief.edited", "brief", id);
  },
});

export const confirm = app.mutation({
  access: "connector.write",
  retry: { sequenceConflicts: 3 },
  args: { id: s.string() },
  handler: async (ctx, { id }) => {
    const brief = await owned<Brief>(ctx, briefs, id, "brief");
    if (brief.status !== "draft") fail("FAILED_PRECONDITION", `Only a draft brief can be confirmed; this one is ${brief.status}.`);
    if (!brief.topics.length) fail("FAILED_PRECONDITION", "Add at least one topic before confirming: matching needs something to look for.");
    await ctx.db.patch(briefs, id, { status: "confirmed", confirmedAt: Date.now() });
    await audit(ctx, brief.ownerId, "brief.confirmed", "brief", id);
  },
});

export const archive = app.mutation({
  access: "connector.write",
  retry: { sequenceConflicts: 3 },
  args: { id: s.string() },
  handler: async (ctx, { id }) => {
    const brief = await owned<Brief>(ctx, briefs, id, "brief");
    await ctx.db.patch(briefs, id, { status: "archived" });
    await audit(ctx, brief.ownerId, "brief.archived", "brief", id);
  },
});

/**
 * Brings opted-in network participants whose stated topics overlap the brief into the owner's
 * graph, as people with evidence of what they said about themselves. Contact details are not
 * copied: they are disclosed only through an introduction's consent grants.
 */
async function discoverParticipants(ctx: any, ownerId: string, brief: Brief): Promise<void> {
  const open = (await ctx.db.find(profiles, { openToIntroductions: true })).filter((p: { ownerId: string }) => p.ownerId !== ownerId);
  if (!open.length) return;
  const blockedBy = new Set((await ctx.db.find(blocks, { blockedId: ownerId })).map((b: { blockerId: string }) => b.blockerId));
  const mine = await ctx.db.find(people, { ownerId });
  for (const profile of open) {
    if (blockedBy.has(profile.ownerId)) continue;
    const offered = [...profile.introTopics, ...profile.expertise];
    if (!overlap(brief.topics, offered).length) continue;
    const claim = `${profile.headline ? `${profile.headline}. ` : ""}Open to introductions about: ${profile.introTopics.join(", ") || "(none listed)"}. Expertise: ${profile.expertise.join(", ") || "(none listed)"}.`;
    // A confidential brief must not create a record of anyone tied to an excluded organization.
    if (isExcluded({ personId: "", name: profile.displayName, relationshipState: "unknown", evidence: [{ id: "", sourceType: "participant_statement", claim, topics: [], confidence: 1, capturedAt: 0 }] }, brief)) continue;
    const sourceId = await ensureSource(ctx, ownerId, "network", "Boundry network profiles");
    let person = mine.find((p: { linkedUserId?: string }) => p.linkedUserId === profile.ownerId);
    if (!person) {
      const id = await ctx.db.insert(people, { ownerId, name: profile.displayName, linkedUserId: profile.ownerId, sourceIds: [sourceId], createdAt: Date.now() });
      person = { id, sourceIds: [sourceId] };
      mine.push({ ...person, linkedUserId: profile.ownerId });
      await audit(ctx, ownerId, "person.discovered", "person", id, { via: "network" });
    } else if (!person.sourceIds.includes(sourceId)) {
      await ctx.db.patch(people, person.id, { sourceIds: [...person.sourceIds, sourceId] });
    }
    const sourceRef = `profile:${profile.ownerId}@${profile.updatedAt}`;
    let evidenceId = (await ctx.db.find(evidence, { ownerId, personId: person.id, sourceRef }))[0]?.id as string | undefined;
    if (!evidenceId) {
      evidenceId = await ctx.db.insert(evidence, { ownerId, personId: person.id, sourceId, sourceType: "participant_statement", sourceRef, claim, topics: offered, confidence: 0.9, scope: "shareable", capturedAt: Date.now(), retracted: false });
    }
    await transitionRelationship(ctx, ownerId, person.id, "introducible", "participant.optin", [evidenceId!]);
  }
}

/**
 * Runs matching for a confirmed brief: deterministic retrieval over the owner's current evidence
 * and opted-in participants, scored by _rules.ts. Earlier decisions (accepted, rejected, deferred)
 * are kept; a rejected person is never re-proposed for this brief.
 */
export const match = app.mutation({
  access: "connector.advise",
  retry: { sequenceConflicts: 3 },
  args: { id: s.string() },
  returns: s.object({ candidates: s.integer(), matches: s.integer() }),
  capability: { name: "briefs.match", description: "Find evidence-backed candidates for a confirmed brief. No one is contacted." },
  handler: async (ctx, { id }) => {
    const ownerId = me(ctx).id;
    const brief = await owned<Brief>(ctx, briefs, id, "brief");
    if (brief.status !== "confirmed") fail("FAILED_PRECONDITION", "Confirm the brief before matching.");
    await discoverParticipants(ctx, ownerId, brief);

    const [all, ev] = await Promise.all([visiblePeople(ctx, ownerId), currentEvidence(ctx, ownerId)]);
    const candidates: Candidate[] = await Promise.all(
      all.map(async (p) => ({
        personId: p.id,
        name: p.name,
        ...(p.organization ? { organization: p.organization } : {}),
        relationshipState: await relationshipState(ctx, ownerId, p.id),
        evidence: ev.filter((e) => e.personId === p.id),
      })),
    );
    const scored = scoreCandidates(brief, candidates, Date.now()).slice(0, 25);
    const existing = new Map((await ctx.db.find(matches, { briefId: id })).map((m) => [m.personId, m]));
    for (const m of scored) {
      const prior = existing.get(m.personId);
      if (prior) await ctx.db.patch(matches, prior.id, { score: m.score, reasons: m.reasons, unknowns: m.unknowns, relationshipState: m.relationshipState });
      else await ctx.db.insert(matches, { ownerId, briefId: id, ...m, decision: "pending", createdAt: Date.now() });
    }
    await ctx.db.patch(briefs, id, { matchedAt: Date.now() });
    await audit(ctx, ownerId, "brief.matched", "brief", id, { candidates: candidates.length, matches: scored.length });
    return { candidates: candidates.length, matches: scored.length };
  },
});
