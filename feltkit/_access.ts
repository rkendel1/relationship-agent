/**
 * Ownership, audit and relationship-state helpers shared by every function module.
 *
 * Isolation is enforced here, in one place: every principal-owned record carries `ownerId`, reads
 * filter by it, and `owned()` answers NOT_FOUND for another principal's record (never revealing it
 * exists). Tests in tests/isolation.test.ts exercise it across every module.
 */
import { fail } from "@feltdb/feltkit";
import { auditEvents, evidence, people, relationshipEvents, relationships, sources, SOURCE_KINDS } from "./app.js";
import { decideRelationshipTransition, type RelationshipCause, type RelationshipState } from "./_rules.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Ctx = any; // FeltKit's handler context (query or mutation); kept loose so helpers serve both.

export function me(ctx: Ctx): { id: string; type: string } {
  const p = ctx.auth.requirePrincipal();
  return { id: p.id, type: String(p.type ?? "user") };
}

/** The caller's record in a principal-owned collection, or NOT_FOUND. */
export async function owned<T extends { ownerId: string }>(ctx: Ctx, collection: unknown, id: string, label: string): Promise<T & { id: string; __version: number }> {
  const record = await ctx.db.get(collection, id);
  if (!record || record.ownerId !== me(ctx).id) fail("NOT_FOUND", `No ${label} ${id}.`);
  return record;
}

type AuditDetail = Record<string, string | number | boolean>;

/** Appends an audit event to the owner's stream. Ids and action names only: never content or contact details. */
export async function audit(ctx: Ctx, ownerId: string, action: string, subjectType: string, subjectId: string, detail?: AuditDetail): Promise<void> {
  const actor = me(ctx);
  await ctx.db.insert(auditEvents, {
    ownerId,
    actorId: actor.id,
    actorType: actor.type,
    action,
    subjectType,
    subjectId,
    ...(detail ? { detail } : {}),
    seq: await ctx.db.sequence(`audit:${ownerId}`),
    at: Date.now(),
  });
}

/** The owner's single source of a kind and label (e.g. the "manual" source), created on first use. */
export async function ensureSource(ctx: Ctx, ownerId: string, kind: (typeof SOURCE_KINDS)[number], label: string): Promise<string> {
  const existing = (await ctx.db.find(sources, { ownerId, kind, label }))[0];
  if (existing) {
    if (existing.status !== "active") fail("FAILED_PRECONDITION", `The source "${label}" was revoked. Create a new one to add evidence from it again.`);
    return existing.id;
  }
  const id = await ctx.db.insert(sources, { ownerId, kind, label, status: "active", createdAt: Date.now() });
  await audit(ctx, ownerId, "source.created", "source", id, { kind });
  return id;
}

export async function activeSourceIds(ctx: Ctx, ownerId: string): Promise<Set<string>> {
  return new Set((await ctx.db.find(sources, { ownerId, status: "active" })).map((s: { id: string }) => s.id));
}

export type EvidenceRecord = {
  id: string;
  ownerId: string;
  personId: string;
  sourceId: string;
  sourceType: "user_attested" | "contact_import" | "public_url" | "participant_statement" | "interaction";
  sourceRef: string;
  claim: string;
  topics: string[];
  confidence: number;
  scope: "private" | "shareable";
  capturedAt: number;
  supersedes?: string;
  retracted: boolean;
};

/**
 * The evidence the owner may use now: from active sources, not superseded by a correction, and not
 * a retraction. Access is decided here, at read time, so revoking a source takes effect at once.
 */
export async function currentEvidence(ctx: Ctx, ownerId: string, personId?: string): Promise<EvidenceRecord[]> {
  const active = await activeSourceIds(ctx, ownerId);
  const all: EvidenceRecord[] = await ctx.db.find(evidence, personId ? { ownerId, personId } : { ownerId });
  const superseded = new Set(all.filter((e) => e.supersedes && active.has(e.sourceId)).map((e) => e.supersedes!));
  return all.filter((e) => active.has(e.sourceId) && !superseded.has(e.id) && !e.retracted);
}

/** People the owner may see now: at least one of their sources is still active. */
export async function visiblePeople(ctx: Ctx, ownerId: string): Promise<Array<{ id: string; name: string; email?: string; organization?: string; title?: string; linkedUserId?: string; sourceIds: string[]; createdAt: number }>> {
  const active = await activeSourceIds(ctx, ownerId);
  return (await ctx.db.find(people, { ownerId })).filter((p: { sourceIds: string[] }) => p.sourceIds.some((s) => active.has(s)));
}

export async function relationshipState(ctx: Ctx, ownerId: string, personId: string): Promise<RelationshipState> {
  return ((await ctx.db.find(relationships, { ownerId, personId }))[0]?.state as RelationshipState | undefined) ?? "unknown";
}

/**
 * Applies a relationship transition through the policy in _rules.ts, recording an append-only
 * event. Refused transitions fail; no-ops (already at or above a system-caused state) write nothing.
 */
export async function transitionRelationship(ctx: Ctx, ownerId: string, personId: string, to: RelationshipState, cause: RelationshipCause, evidenceIds: string[]): Promise<RelationshipState> {
  const actor = me(ctx);
  const current = (await ctx.db.find(relationships, { ownerId, personId }))[0];
  const from: RelationshipState = current?.state ?? "unknown";
  const decision = decideRelationshipTransition({ from, to, cause, actorIsOwner: actor.id === ownerId, actorType: actor.type });
  if (!decision.ok) fail("FAILED_PRECONDITION", decision.reason);
  if (!decision.changed) {
    if (!current) await ctx.db.insert(relationships, { ownerId, personId, state: from, updatedAt: Date.now() });
    return from;
  }
  const now = Date.now();
  if (current) await ctx.db.patch(relationships, current.id, { state: to, updatedAt: now });
  else await ctx.db.insert(relationships, { ownerId, personId, state: to, updatedAt: now });
  await ctx.db.insert(relationshipEvents, { ownerId, personId, from, to, actorId: actor.id, actorType: actor.type, cause, evidenceIds, seq: await ctx.db.sequence(`rel:${ownerId}:${personId}`), at: now });
  await audit(ctx, ownerId, "relationship.changed", "person", personId, { from, to, cause });
  return to;
}
