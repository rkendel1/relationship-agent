import { s } from "@feltdb/feltkit";
import { app, profiles } from "./app.js";
import { audit, me } from "./_access.js";
import { normalizeTopics } from "./_text.js";

/** The caller's own profile (null until saved). */
export const get = app.query({
  access: "connector.read",
  handler: async (ctx) => (await ctx.db.find(profiles, { ownerId: me(ctx).id }))[0] ?? null,
});

const list = s.array(s.string({ maxLength: 200 }), { maxItems: 40 });

export const save = app.mutation({
  access: "connector.write",
  retry: { sequenceConflicts: 3 },
  args: {
    displayName: s.string({ minLength: 1, maxLength: 120 }),
    headline: s.string({ maxLength: 200 }),
    email: s.optional(s.string({ maxLength: 200 })),
    projects: list,
    expertise: list,
    needs: list,
    boundaries: s.string({ maxLength: 1000 }),
    openToIntroductions: s.boolean(),
    introTopics: list,
    needsVisible: s.optional(s.boolean()),
  },
  handler: async (ctx, args) => {
    const ownerId = me(ctx).id;
    const clean = {
      ...args,
      displayName: args.displayName.trim(),
      headline: args.headline.trim(),
      ...(args.email?.trim() ? { email: args.email.trim() } : { email: undefined }),
      projects: args.projects.map((p) => p.trim()).filter(Boolean),
      expertise: normalizeTopics(args.expertise),
      needs: args.needs.map((p) => p.trim()).filter(Boolean),
      introTopics: normalizeTopics(args.introTopics),
      needsVisible: args.needsVisible ?? false,
      updatedAt: Date.now(),
    };
    const existing = (await ctx.db.find(profiles, { ownerId }))[0];
    if (existing) await ctx.db.patch(profiles, existing.id, clean);
    else await ctx.db.insert(profiles, { ownerId, ...clean });
    await audit(ctx, ownerId, "profile.saved", "profile", ownerId, { openToIntroductions: clean.openToIntroductions });
  },
});
