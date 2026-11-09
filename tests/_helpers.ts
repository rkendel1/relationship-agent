/** Shared test helpers. Not a test file (no `.test.ts`), so `feltkit test` does not run it on its own. */
import type { createTestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.js";

export type T = Awaited<ReturnType<typeof createTestApp>>;
type Caller = ReturnType<T["as"]>;
type Channel = "in_app" | "external" | "manual";

export const profile = (displayName: string, extra: Record<string, unknown> = {}) => ({ displayName, headline: "", projects: [], expertise: [], needs: [], boundaries: "", openToIntroductions: false, introTopics: [], ...extra });

/** What the review screen shows for a channel: the hash a person approves. */
export async function reviewHash(who: Caller, id: string, channel: Channel): Promise<string> {
  const intro = await who.query(api.introductions.get, { id });
  const option = intro.channels.find((c) => c.channel === channel);
  if (!option) throw new Error(`channel ${channel} not offered`);
  return option.hash;
}

/** Approve exactly what is shown now, then let after-commit work (the dispatch job, notifications) run. */
export async function approveAndDeliver(t: T, who: Caller, id: string, channel: Channel = "in_app") {
  const result = await who.mutation(api.introductions.approve, { id, channel, contentHash: await reviewHash(who, id, channel) });
  await t.runtime.runServices();
  return result;
}

export async function notificationsFor(t: T, recipient: string) {
  const all = await t.runtime.instance.handle("test").collection<{ recipient: string; type: string; data?: { introductionId?: string } }>("notifications").find({});
  return all.filter((n) => n.recipient === recipient);
}
