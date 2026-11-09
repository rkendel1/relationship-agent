/**
 * User-declared equivalent terms. Matching treats a term and its declared equivalents as the same
 * word, at a slightly lower weight, and every match through an alias cites the alias. Nothing is
 * inferred: if it is not declared here, "postgres" does not match "databases".
 */
import { fail, s } from "@feltdb/feltkit";
import { aliases, app } from "./app.js";
import { audit, me, owned } from "./_access.js";
import { words } from "./_text.js";

const norm = (v: string) => words(v).join(" ");

export const list = app.query({
  access: "connector.read",
  handler: async (ctx) => ctx.db.find(aliases, { ownerId: me(ctx).id }, { orderBy: [{ field: "term", direction: "asc" }] }),
});

export const set = app.mutation({
  access: "connector.write",
  retry: { sequenceConflicts: 3 },
  args: { term: s.string({ minLength: 1, maxLength: 80 }), equivalents: s.array(s.string({ minLength: 1, maxLength: 80 }), { minItems: 1, maxItems: 20 }) },
  returns: s.string(),
  handler: async (ctx, args) => {
    const ownerId = me(ctx).id;
    const term = norm(args.term);
    const equivalents = [...new Set(args.equivalents.map(norm))].filter((e) => e && e !== term);
    if (!term) fail("INVALID_ARGUMENT", "The term has no searchable words (stop words and very short words are ignored).");
    if (!equivalents.length) fail("INVALID_ARGUMENT", "Give at least one equivalent term that differs from the term itself.");
    const existing = (await ctx.db.find(aliases, { ownerId, term }))[0];
    const id = existing ? (await ctx.db.patch(aliases, existing.id, { equivalents })).id : await ctx.db.insert(aliases, { ownerId, term, equivalents, createdAt: Date.now() });
    await audit(ctx, ownerId, "alias.set", "alias", id, { equivalents: equivalents.length });
    return id;
  },
});

export const remove = app.mutation({
  access: "connector.write",
  retry: { sequenceConflicts: 3 },
  args: { id: s.string() },
  handler: async (ctx, { id }) => {
    await owned(ctx, aliases, id, "alias");
    await ctx.db.delete(aliases, id);
    await audit(ctx, me(ctx).id, "alias.removed", "alias", id);
  },
});
