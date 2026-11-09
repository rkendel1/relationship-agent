/** Introduction workflow helpers shared by introductions.ts and deliveries.ts. */
import { fail } from "@feltdb/feltkit";
import { deliveries, introductionEvents, introductions, people, profiles, SHAREABLE_FIELDS } from "./app.js";
import { audit, me } from "./_access.js";
import { contentHash, recipientRef, type Channel, type DeliveryState, type Reviewable } from "./_delivery.js";
import { canMoveIntroduction, type IntroState } from "./_rules.js";

export const REQUEST_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const GRANT_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const DAILY_REQUEST_LIMIT = 10;

export type Field = (typeof SHAREABLE_FIELDS)[number];
export type Intro = {
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
  channel?: Channel;
  approvalId?: string;
  requestedAt?: number;
  expiresAt?: number;
  followUpAt?: number;
  outcomeNote?: string;
  createdAt: number;
  updatedAt: number;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function move(ctx: any, intro: Intro, to: IntroState, patch: Partial<Intro> = {}): Promise<void> {
  if (!canMoveIntroduction(intro.state, to)) fail("FAILED_PRECONDITION", `An introduction that is ${intro.state.replace("_", " ")} cannot become ${to.replace("_", " ")}.`);
  const now = Date.now();
  await ctx.db.patch(introductions, intro.id, { ...patch, state: to, updatedAt: now });
  await ctx.db.insert(introductionEvents, { introductionId: intro.id, from: intro.state, to, actorId: me(ctx).id, seq: await ctx.db.sequence(`intro:${intro.id}`), at: now });
  await audit(ctx, intro.ownerId, `introduction.${to}`, "introduction", intro.id);
  intro.state = to;
}

export async function profileOf(ctx: any, userId: string) {
  return (await ctx.db.find(profiles, { ownerId: userId }))[0] ?? null;
}

/** What a person reviews for one channel, and its hash. The recipient is resolved from current data. */
export async function reviewFor(ctx: any, intro: Intro, channel: Channel): Promise<{ reviewable: Reviewable; hash: string; email?: string }> {
  const person = await ctx.db.get(people, intro.personId);
  const email: string | undefined = person?.email;
  const reviewable: Reviewable = {
    introductionId: intro.id,
    sharedContext: intro.sharedContext,
    message: intro.message,
    requesterFields: intro.requesterFields,
    channel,
    recipient: recipientRef(channel, { ...(intro.recipientUserId ? { recipientUserId: intro.recipientUserId } : {}), personId: intro.personId, ...(email ? { email } : {}) }),
  };
  return { reviewable, hash: await contentHash(reviewable), ...(email ? { email } : {}) };
}

/**
 * The delivery for the approval currently in force, if any. A real attempt (one that may have
 * reached someone) always outranks a refusal recorded later for the same approval, so a refusal
 * can never hide a queued, sent or unknown delivery.
 */
export async function currentDelivery(ctx: any, intro: Intro) {
  if (!intro.approvalId) return null;
  type D = { id: string; approvalId: string; channel: Channel; state: DeliveryState; idempotencyKey: string; createdAt: number; determinedBy?: string; reason?: string };
  const forApproval = (await ctx.db.find(deliveries, { introductionId: intro.id })).filter((d: D) => d.approvalId === intro.approvalId);
  const newest = (list: D[]) => [...list].sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
  return newest(forApproval.filter((d: D) => d.determinedBy !== "refusal")) ?? newest(forApproval);
}
