/**
 * Export, deletion and the audit trail.
 *
 * Retention policy (MVP): deletion removes the caller's profile, sources, people, evidence,
 * relationships and their history, briefs, matches, aliases, outgoing introductions with their
 * events, approvals and delivery records, and consent grants the caller gave. FeltKit's own
 * integration call records (`_feltkit_integration_calls`) are platform evidence the app cannot
 * delete; they hold redacted input as FeltKit records it. Audit events are kept: they hold ids and
 * action names only, never content or contact details, and record that the deletion happened.
 */
import { fail, s } from "@feltdb/feltkit";
import { aliases, app, approvals, auditEvents, blocks, briefs, consentGrants, deliveries, evidence, introductionEvents, introductions, matches, people, profiles, relationshipEvents, relationships, sources } from "./app.js";
import { audit, me } from "./_access.js";

export const auditLog = app.query({
  access: "connector.read",
  args: { limit: s.optional(s.integer({ minimum: 1, maximum: 500 })) },
  handler: async (ctx, { limit }) => ctx.db.find(auditEvents, { ownerId: me(ctx).id }, { orderBy: [{ field: "seq", direction: "desc" }], limit: limit ?? 100 }),
});

/** Everything the app holds for the caller, as one JSON document. */
export const exportAll = app.query({
  access: "connector.read",
  handler: async (ctx) => {
    const ownerId = me(ctx).id;
    const outgoing = await ctx.db.find(introductions, { ownerId });
    const introEvents = (await Promise.all(outgoing.map((i) => ctx.db.find(introductionEvents, { introductionId: i.id })))).flat();
    return {
      format: "boundry-connector.export@1",
      exportedAt: Date.now(),
      ownerId,
      profile: (await ctx.db.find(profiles, { ownerId }))[0] ?? null,
      sources: await ctx.db.find(sources, { ownerId }),
      people: await ctx.db.find(people, { ownerId }),
      evidence: await ctx.db.find(evidence, { ownerId }),
      relationships: await ctx.db.find(relationships, { ownerId }),
      relationshipEvents: await ctx.db.find(relationshipEvents, { ownerId }),
      briefs: await ctx.db.find(briefs, { ownerId }),
      matches: await ctx.db.find(matches, { ownerId }),
      introductions: outgoing,
      introductionEvents: introEvents,
      approvals: await ctx.db.find(approvals, { ownerId }),
      deliveries: await ctx.db.find(deliveries, { ownerId }),
      aliases: await ctx.db.find(aliases, { ownerId }),
      consentGiven: await ctx.db.find(consentGrants, { grantorId: ownerId }),
      blocks: await ctx.db.find(blocks, { blockerId: ownerId }),
      audit: await ctx.db.find(auditEvents, { ownerId }, { orderBy: [{ field: "seq", direction: "asc" }] }),
    };
  },
});

/** Deletes the caller's data per the retention policy above. Requires typing DELETE. */
export const deleteAll = app.mutation({
  access: "connector.write",
  retry: { sequenceConflicts: 3 },
  args: { confirm: s.string() },
  returns: s.object({ deleted: s.integer() }),
  handler: async (ctx, { confirm }) => {
    if (confirm !== "DELETE") fail("INVALID_ARGUMENT", 'Type DELETE to confirm.');
    const ownerId = me(ctx).id;
    let deleted = 0;
    const del = async (collection: unknown, records: Array<{ id: string }>) => {
      for (const r of records) await ctx.db.delete(collection as never, r.id), deleted++;
    };
    // Consent the caller gave, and every grant on their outgoing introductions: deleting a grant
    // ends disclosure, because contact fields are only ever read through a live grant.
    const outgoing = await ctx.db.find(introductions, { ownerId });
    const grants = new Map((await ctx.db.find(consentGrants, { grantorId: ownerId })).map((g) => [g.id, g]));
    for (const i of outgoing) {
      for (const g of await ctx.db.find(consentGrants, { introductionId: i.id })) grants.set(g.id, g);
      await del(introductionEvents, await ctx.db.find(introductionEvents, { introductionId: i.id }));
    }
    await del(consentGrants, [...grants.values()]);
    await del(approvals, await ctx.db.find(approvals, { ownerId }));
    await del(deliveries, await ctx.db.find(deliveries, { ownerId }));
    await del(aliases, await ctx.db.find(aliases, { ownerId }));
    await del(introductions, outgoing);
    await del(matches, await ctx.db.find(matches, { ownerId }));
    await del(briefs, await ctx.db.find(briefs, { ownerId }));
    await del(relationshipEvents, await ctx.db.find(relationshipEvents, { ownerId }));
    await del(relationships, await ctx.db.find(relationships, { ownerId }));
    await del(evidence, await ctx.db.find(evidence, { ownerId }));
    await del(people, await ctx.db.find(people, { ownerId }));
    await del(sources, await ctx.db.find(sources, { ownerId }));
    await del(profiles, await ctx.db.find(profiles, { ownerId }));
    await audit(ctx, ownerId, "privacy.deleted", "principal", ownerId, { records: deleted });
    return { deleted };
  },
});
