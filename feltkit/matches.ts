import { s } from "@feltdb/feltkit";
import { app, briefs, matches } from "./app.js";
import { audit, currentEvidence, me, owned, visiblePeople } from "./_access.js";

/**
 * A brief's matches, with each reason's evidence resolved for display. Access is checked now: a
 * reason whose evidence is no longer readable (source revoked, claim retracted) is dropped, and a
 * match left with no evidence is not shown. Contact details are never part of a match.
 */
export const list = app.query({
  access: "connector.read",
  args: { briefId: s.string(), includeRejected: s.optional(s.boolean()) },
  handler: async (ctx, { briefId, includeRejected }) => {
    const ownerId = me(ctx).id;
    await owned(ctx, briefs, briefId, "brief");
    const [all, ev, visible] = await Promise.all([ctx.db.find(matches, { briefId }), currentEvidence(ctx, ownerId), visiblePeople(ctx, ownerId)]);
    const evById = new Map(ev.map((e) => [e.id, e]));
    const personById = new Map(visible.map((p) => [p.id, p]));
    const out = [];
    for (const m of all.sort((a, b) => b.score - a.score)) {
      if (m.ownerId !== ownerId) continue;
      if (m.decision === "rejected" && !includeRejected) continue;
      const person = personById.get(m.personId);
      if (!person) continue;
      const reasons = m.reasons
        .map((r) => ({ ...r, evidenceIds: r.evidenceIds.filter((id) => evById.has(id)) }))
        .filter((r) => r.kind !== "evidence" || r.evidenceIds.length > 0);
      if (!reasons.some((r) => r.kind === "evidence")) continue;
      // Contributions whose evidence is no longer readable no longer count, and are not shown.
      const contributions = (m.contributions ?? []).filter((k) => evById.has(k.evidenceId));
      const cited = [...new Set(reasons.flatMap((r) => r.evidenceIds))].map((id) => {
        const e = evById.get(id)!;
        return { id: e.id, sourceType: e.sourceType, sourceRef: e.sourceRef, claim: e.claim, capturedAt: e.capturedAt, confidence: e.confidence };
      });
      out.push({
        id: m.id,
        personId: m.personId,
        name: person.name,
        organization: person.organization ?? null,
        title: person.title ?? null,
        participant: Boolean(person.linkedUserId),
        score: m.score,
        strength: m.strength ?? null,
        contributions,
        reasons,
        unknowns: m.unknowns,
        relationshipState: m.relationshipState,
        decision: m.decision,
        decisionNote: m.decisionNote ?? null,
        evidence: cited,
      });
    }
    return out;
  },
});

/** The owner's verdict on a match. Stored as a decision on the record, never as a hidden model adjustment. */
export const decide = app.mutation({
  access: "connector.write",
  retry: { sequenceConflicts: 3 },
  args: { id: s.string(), decision: s.enum(["accepted", "rejected", "deferred", "pending"] as const), note: s.optional(s.string({ maxLength: 1000 })) },
  handler: async (ctx, { id, decision, note }) => {
    const m = await owned<{ ownerId: string; personId: string }>(ctx, matches, id, "match");
    await ctx.db.patch(matches, id, { decision, decisionNote: note?.trim() || undefined, decidedAt: Date.now() });
    await audit(ctx, m.ownerId, `match.${decision}`, "match", id, { personId: m.personId });
  },
});

