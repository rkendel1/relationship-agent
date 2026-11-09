import { fail, s } from "@feltdb/feltkit";
import { app, evidence, people, relationshipEvents, sources } from "./app.js";
import { audit, currentEvidence, ensureSource, me, owned, relationshipState, transitionRelationship, visiblePeople, type EvidenceRecord } from "./_access.js";
import { parseCsv } from "./_csv.js";
import { normalizeTopics, tokens } from "./_text.js";

const CONFIDENCE = { user_attested: 0.8, public_url: 0.6, contact_import: 0.5, participant_statement: 0.9, interaction: 0.95 } as const;

/** People in the caller's graph whose evidence is still accessible, with relationship state. */
export const list = app.query({
  access: "connector.read",
  handler: async (ctx) => {
    const ownerId = me(ctx).id;
    const [all, ev] = await Promise.all([visiblePeople(ctx, ownerId), currentEvidence(ctx, ownerId)]);
    return Promise.all(
      all
        .sort((a, b) => (a.name < b.name ? -1 : 1))
        .map(async (p) => ({ id: p.id, name: p.name, organization: p.organization ?? null, title: p.title ?? null, participant: Boolean(p.linkedUserId), state: await relationshipState(ctx, ownerId, p.id), evidenceCount: ev.filter((e) => e.personId === p.id).length })),
    );
  },
});

/** One person: their record, current evidence, superseded history, and relationship events. */
export const get = app.query({
  access: "connector.read",
  args: { id: s.string() },
  handler: async (ctx, { id }) => {
    const ownerId = me(ctx).id;
    const person = await owned<{ ownerId: string; name: string }>(ctx, people, id, "person");
    const visible = (await visiblePeople(ctx, ownerId)).some((p) => p.id === id);
    if (!visible) fail("NOT_FOUND", `No person ${id}.`);
    const current = await currentEvidence(ctx, ownerId, id);
    const allSources = await ctx.db.find(sources, { ownerId });
    const sourceLabel = new Map(allSources.map((s) => [s.id, `${s.label}${s.status === "revoked" ? " (revoked)" : ""}`]));
    const events = await ctx.db.find(relationshipEvents, { ownerId, personId: id }, { orderBy: [{ field: "seq", direction: "asc" }] });
    return {
      person,
      state: await relationshipState(ctx, ownerId, id),
      evidence: current.sort((a, b) => b.capturedAt - a.capturedAt).map((e) => ({ ...e, sourceLabel: sourceLabel.get(e.sourceId) ?? "unknown source" })),
      events,
    };
  },
});

async function addEvidenceRecord(ctx: any, input: Omit<EvidenceRecord, "id" | "capturedAt" | "retracted"> & { retracted?: boolean }): Promise<string> {
  const id = await ctx.db.insert(evidence, { ...input, retracted: input.retracted ?? false, capturedAt: Date.now() });
  await audit(ctx, input.ownerId, "evidence.added", "person", input.personId, { evidenceId: id, sourceType: input.sourceType });
  return id;
}

/** Adds a person by hand, optionally with a note about what they know. Creates a discovery, not a relationship. */
export const add = app.mutation({
  access: "connector.write",
  retry: { sequenceConflicts: 3 },
  args: {
    name: s.string({ minLength: 1, maxLength: 160 }),
    email: s.optional(s.string({ maxLength: 200 })),
    organization: s.optional(s.string({ maxLength: 160 })),
    title: s.optional(s.string({ maxLength: 160 })),
    note: s.optional(s.string({ maxLength: 2000 })),
    topics: s.optional(s.array(s.string({ maxLength: 80 }), { maxItems: 40 })),
  },
  returns: s.string(),
  handler: async (ctx, args) => {
    const ownerId = me(ctx).id;
    const sourceId = await ensureSource(ctx, ownerId, "manual", "Added by hand");
    const personId = await ctx.db.insert(people, {
      ownerId,
      name: args.name.trim(),
      ...(args.email?.trim() ? { email: args.email.trim() } : {}),
      ...(args.organization?.trim() ? { organization: args.organization.trim() } : {}),
      ...(args.title?.trim() ? { title: args.title.trim() } : {}),
      sourceIds: [sourceId],
      createdAt: Date.now(),
    });
    await audit(ctx, ownerId, "person.added", "person", personId);
    const evidenceIds: string[] = [];
    if (args.note?.trim()) {
      evidenceIds.push(await addEvidenceRecord(ctx, { ownerId, personId, sourceId, sourceType: "user_attested", sourceRef: "manual", claim: args.note.trim(), topics: normalizeTopics(args.topics ?? []), confidence: CONFIDENCE.user_attested, scope: "private" }));
    }
    await transitionRelationship(ctx, ownerId, personId, "observed", "source.observed", evidenceIds);
    return personId;
  },
});

/**
 * Imports contacts from a CSV export (columns: name, email, organization, title, notes, topics —
 * topics separated by ";"). One source per import, so it can be revoked as a unit. People are
 * merged only on an exact e-mail match; nothing is merged by name.
 */
export const importContacts = app.mutation({
  access: "connector.write",
  retry: { sequenceConflicts: 3 },
  args: { label: s.string({ minLength: 1, maxLength: 200 }), csv: s.string({ minLength: 1, maxLength: 500_000 }) },
  returns: s.object({ sourceId: s.string(), created: s.integer(), merged: s.integer(), skipped: s.integer() }),
  handler: async (ctx, { label, csv }) => {
    const ownerId = me(ctx).id;
    const rows = parseCsv(csv);
    if (!rows.length) fail("INVALID_ARGUMENT", "The CSV has no rows. The first line must be a header with at least a name column.");
    if (!("name" in rows[0]!)) fail("INVALID_ARGUMENT", 'The CSV header needs a "name" column.');
    if (rows.length > 2000) fail("INVALID_ARGUMENT", "Import at most 2,000 contacts at a time.");
    const sourceId = await ctx.db.insert(sources, { ownerId, kind: "contacts_import", label: label.trim(), status: "active", createdAt: Date.now() });
    await audit(ctx, ownerId, "source.created", "source", sourceId, { kind: "contacts_import", rows: rows.length });

    const existing = await ctx.db.find(people, { ownerId });
    const byEmail = new Map(existing.filter((p) => p.email).map((p) => [p.email!.toLowerCase(), p]));
    let created = 0;
    let merged = 0;
    let skipped = 0;
    for (const row of rows) {
      const name = row.name?.trim();
      if (!name) {
        skipped++;
        continue;
      }
      const email = row.email?.trim() || undefined;
      const organization = row.organization?.trim() || row.company?.trim() || undefined;
      const title = row.title?.trim() || undefined;
      let person = email ? byEmail.get(email.toLowerCase()) : undefined;
      let personId: string;
      if (person) {
        personId = person.id;
        if (!person.sourceIds.includes(sourceId)) await ctx.db.patch(people, personId, { sourceIds: [...person.sourceIds, sourceId] });
        merged++;
      } else {
        personId = await ctx.db.insert(people, { ownerId, name, ...(email ? { email } : {}), ...(organization ? { organization } : {}), ...(title ? { title } : {}), sourceIds: [sourceId], createdAt: Date.now() });
        if (email) byEmail.set(email.toLowerCase(), { id: personId, sourceIds: [sourceId] } as never);
        created++;
      }
      // The row as a claim. Imported text is stored as data: nothing in it is executed or obeyed.
      const role = [title, organization].filter(Boolean).join(" at ");
      const claim = [role ? `In your contacts as ${role}.` : "In your contacts.", row.notes?.trim()].filter(Boolean).join(" ");
      const topics = normalizeTopics([...(row.topics ?? "").split(";"), title ?? ""]);
      const evidenceId = await addEvidenceRecord(ctx, { ownerId, personId, sourceId, sourceType: "contact_import", sourceRef: label.trim(), claim, topics, confidence: CONFIDENCE.contact_import, scope: "private" });
      await transitionRelationship(ctx, ownerId, personId, "observed", "source.observed", [evidenceId]);
    }
    return { sourceId, created, merged, skipped };
  },
});

/**
 * Corrects a person's own record (address, organization, title). An approval for external delivery
 * names the address it was approved for, so changing it invalidates that approval.
 */
export const update = app.mutation({
  access: "connector.write",
  retry: { sequenceConflicts: 3 },
  args: { id: s.string(), email: s.optional(s.string({ maxLength: 200 })), organization: s.optional(s.string({ maxLength: 160 })), title: s.optional(s.string({ maxLength: 160 })) },
  handler: async (ctx, { id, email, organization, title }) => {
    const ownerId = me(ctx).id;
    await owned(ctx, people, id, "person");
    const v = (x?: string) => (x === undefined ? {} : x.trim() ? { value: x.trim() } : { value: undefined });
    const patch: Record<string, string | undefined> = {};
    for (const [k, x] of Object.entries({ email, organization, title })) if (x !== undefined) patch[k] = v(x).value;
    if (!Object.keys(patch).length) fail("INVALID_ARGUMENT", "Nothing to change.");
    await ctx.db.patch(people, id, patch);
    await audit(ctx, ownerId, "person.updated", "person", id, { fields: Object.keys(patch).join(",") });
  },
});

/** Records a claim about a person: the owner's own note, or a public URL the owner supplied. */
export const addEvidence = app.mutation({
  access: "connector.write",
  retry: { sequenceConflicts: 3 },
  args: {
    personId: s.string(),
    kind: s.enum(["user_attested", "public_url"] as const),
    claim: s.string({ minLength: 1, maxLength: 2000 }),
    url: s.optional(s.string({ maxLength: 500 })),
    topics: s.optional(s.array(s.string({ maxLength: 80 }), { maxItems: 40 })),
  },
  returns: s.string(),
  handler: async (ctx, { personId, kind, claim, url, topics }) => {
    const ownerId = me(ctx).id;
    const person = await owned<{ ownerId: string; sourceIds: string[] }>(ctx, people, personId, "person");
    if (kind === "public_url" && !/^https?:\/\/\S+$/.test(url ?? "")) fail("INVALID_ARGUMENT", "A public source needs its http(s) URL.");
    const sourceId = kind === "public_url" ? await ensureSource(ctx, ownerId, "public_url", url!) : await ensureSource(ctx, ownerId, "manual", "Added by hand");
    if (!person.sourceIds.includes(sourceId)) await ctx.db.patch(people, personId, { sourceIds: [...person.sourceIds, sourceId] });
    const id = await addEvidenceRecord(ctx, { ownerId, personId, sourceId, sourceType: kind, sourceRef: kind === "public_url" ? url! : "manual", claim: claim.trim(), topics: normalizeTopics(topics ?? []), confidence: CONFIDENCE[kind], scope: kind === "public_url" ? "shareable" : "private" });
    await transitionRelationship(ctx, ownerId, personId, "observed", "source.observed", [id]);
    return id;
  },
});

/** Corrects or retracts a claim. The original is never edited: a new record supersedes it. */
export const correctEvidence = app.mutation({
  access: "connector.write",
  retry: { sequenceConflicts: 3 },
  args: { evidenceId: s.string(), claim: s.optional(s.string({ minLength: 1, maxLength: 2000 })), retract: s.boolean() },
  returns: s.string(),
  handler: async (ctx, { evidenceId, claim, retract }) => {
    const ownerId = me(ctx).id;
    const original = await owned<EvidenceRecord>(ctx, evidence, evidenceId, "evidence");
    if (!retract && !claim?.trim()) fail("INVALID_ARGUMENT", "Give the corrected claim, or retract it.");
    const sourceId = await ensureSource(ctx, ownerId, "manual", "Added by hand");
    const person = await ctx.db.get(people, original.personId);
    if (person && !person.sourceIds.includes(sourceId)) await ctx.db.patch(people, person.id, { sourceIds: [...person.sourceIds, sourceId] });
    const id = await ctx.db.insert(evidence, {
      ownerId,
      personId: original.personId,
      sourceId,
      sourceType: "user_attested",
      sourceRef: `correction:${evidenceId}`,
      claim: retract ? `Retracted: ${original.claim}` : claim!.trim(),
      topics: retract ? [] : normalizeTopics([...original.topics, ...tokens(claim!)]),
      confidence: CONFIDENCE.user_attested,
      scope: "private",
      capturedAt: Date.now(),
      supersedes: evidenceId,
      retracted: retract,
    });
    await audit(ctx, ownerId, retract ? "evidence.retracted" : "evidence.corrected", "evidence", evidenceId, { by: id });
    return id;
  },
});

/** The owner states how they know someone. Only a person can do this; an agent never can. */
export const attest = app.mutation({
  access: "connector.write",
  retry: { sequenceConflicts: 3 },
  args: { personId: s.string(), state: s.enum(["known", "connected"] as const), note: s.string({ minLength: 1, maxLength: 1000 }) },
  returns: s.string(),
  handler: async (ctx, { personId, state, note }) => {
    const ownerId = me(ctx).id;
    const person = await owned<{ ownerId: string; sourceIds: string[] }>(ctx, people, personId, "person");
    const sourceId = await ensureSource(ctx, ownerId, "manual", "Added by hand");
    if (!person.sourceIds.includes(sourceId)) await ctx.db.patch(people, personId, { sourceIds: [...person.sourceIds, sourceId] });
    const evidenceId = await addEvidenceRecord(ctx, { ownerId, personId, sourceId, sourceType: "user_attested", sourceRef: "attestation", claim: note.trim(), topics: [], confidence: CONFIDENCE.user_attested, scope: "private" });
    return transitionRelationship(ctx, ownerId, personId, state, "user.attest", [evidenceId]);
  },
});
