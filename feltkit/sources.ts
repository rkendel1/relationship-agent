import { fail, s } from "@feltdb/feltkit";
import { app, evidence, sources } from "./app.js";
import { audit, me, owned } from "./_access.js";

/** Every source of evidence the caller has authorized, with how much evidence each holds. */
export const list = app.query({
  access: "connector.read",
  handler: async (ctx) => {
    const ownerId = me(ctx).id;
    const [all, ev] = await Promise.all([ctx.db.find(sources, { ownerId }, { orderBy: [{ field: "createdAt", direction: "asc" }] }), ctx.db.find(evidence, { ownerId })]);
    return all.map((src) => ({ ...src, evidenceCount: ev.filter((e) => e.sourceId === src.id).length }));
  },
});

/**
 * Revokes a source. Its evidence stays stored (for audit and export) but is no longer used:
 * matching, people and match explanations stop reading it immediately.
 */
export const revoke = app.mutation({
  access: "connector.write",
  retry: { sequenceConflicts: 3 },
  args: { id: s.string() },
  handler: async (ctx, { id }) => {
    const src = await owned<{ ownerId: string; status: string }>(ctx, sources, id, "source");
    if (src.status === "revoked") fail("FAILED_PRECONDITION", "That source is already revoked.");
    await ctx.db.patch(sources, id, { status: "revoked", revokedAt: Date.now() });
    await audit(ctx, me(ctx).id, "source.revoked", "source", id);
  },
});
