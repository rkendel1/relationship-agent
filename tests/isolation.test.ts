/** Principal isolation, export and deletion. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.js";
import { approveAndDeliver } from "./_helpers.js";

const profile = (displayName: string, extra: Record<string, unknown> = {}) => ({ displayName, headline: "", projects: [], expertise: [], needs: [], boundaries: "", openToIntroductions: false, introTopics: [], ...extra });

test("one member can neither read nor change another's graph, briefs, matches or introductions", async () => {
  const t = await createTestApp();
  try {
    const ada = t.as("ada");
    const grace = t.as("grace");
    await t.as("linus").mutation(api.profile.save, profile("Linus", { openToIntroductions: true, introTopics: ["databases"] }));
    const personId = await ada.mutation(api.people.add, { name: "Barbara", note: "databases expert", topics: ["databases"] });
    const briefId = await ada.mutation(api.briefs.create, { text: "databases expert" });
    await ada.mutation(api.briefs.confirm, { id: briefId });
    await ada.mutation(api.briefs.match, { id: briefId });
    const [match] = await ada.query(api.matches.list, { briefId });
    const linusMatch = (await ada.query(api.matches.list, { briefId })).find((m) => m.participant)!;
    const introId = await ada.mutation(api.introductions.draft, { matchId: linusMatch.id });
    await approveAndDeliver(t, ada, introId);

    const notFound = { code: "NOT_FOUND" };
    await assert.rejects(grace.query(api.people.get, { id: personId }), notFound);
    await assert.rejects(grace.query(api.briefs.get, { id: briefId }), notFound);
    await assert.rejects(grace.query(api.matches.list, { briefId }), notFound);
    await assert.rejects(grace.query(api.introductions.get, { id: introId }), notFound);
    await assert.rejects(grace.mutation(api.matches.decide, { id: match!.id, decision: "rejected" }), notFound);
    await assert.rejects(grace.mutation(api.briefs.match, { id: briefId }), notFound);
    await assert.rejects(grace.mutation(api.people.attest, { personId, state: "known", note: "x" }), notFound);
    await assert.rejects(grace.mutation(api.introductions.respond, { id: introId, accept: true, fields: ["email"] }), notFound, "only the addressed recipient can answer");
    await assert.rejects(grace.mutation(api.introductions.withdraw, { id: introId }), notFound);
    assert.deepEqual(await grace.query(api.people.list), []);
    assert.deepEqual(await grace.query(api.briefs.list), []);
    assert.deepEqual(await grace.query(api.introductions.outgoing), []);
    assert.deepEqual(await grace.query(api.introductions.incoming), []);
    assert.deepEqual(await grace.query(api.privacy.auditLog, {}), []);
    // The recipient cannot read the requester's full record either, only the incoming view.
    await assert.rejects(t.as("linus").query(api.introductions.get, { id: introId }), notFound);
    await assert.rejects(t.query(api.people.list), { code: "UNAUTHORIZED" });
  } finally {
    await t.close();
  }
});

test("export returns everything; delete removes it, keeps a content-free audit trail, and ends disclosure", async () => {
  const t = await createTestApp();
  try {
    const ada = t.as("ada");
    const linus = t.as("linus");
    await ada.mutation(api.profile.save, profile("Ada", { email: "ada@example.org" }));
    await linus.mutation(api.profile.save, profile("Linus", { email: "linus@example.org", openToIntroductions: true, introTopics: ["databases"] }));
    const briefId = await ada.mutation(api.briefs.create, { text: "databases expert" });
    await ada.mutation(api.briefs.confirm, { id: briefId });
    await ada.mutation(api.briefs.match, { id: briefId });
    const [m] = await ada.query(api.matches.list, { briefId });
    const introId = await ada.mutation(api.introductions.draft, { matchId: m!.id });
    await ada.mutation(api.introductions.edit, { id: introId, sharedContext: "Ada is looking for a databases expert.", message: "Hi Linus — we haven't met.", requesterFields: ["email"] });
    await approveAndDeliver(t, ada, introId);
    await linus.mutation(api.introductions.respond, { id: introId, accept: true, fields: ["email"] });
    assert.deepEqual((await linus.query(api.introductions.incoming))[0]!.disclosed, { email: "ada@example.org" });

    const exported = await ada.query(api.privacy.exportAll);
    assert.equal(exported.format, "boundry-connector.export@1");
    assert.equal(exported.briefs.length, 1);
    assert.equal(exported.introductions.length, 1);
    assert.ok(exported.people.length >= 1 && exported.evidence.length >= 1 && exported.audit.length > 0);

    await assert.rejects(ada.mutation(api.privacy.deleteAll, { confirm: "yes" }), { code: "INVALID_ARGUMENT" });
    const { deleted } = await ada.mutation(api.privacy.deleteAll, { confirm: "DELETE" });
    assert.ok(deleted > 5);
    const after = await ada.query(api.privacy.exportAll);
    for (const k of ["sources", "people", "evidence", "relationships", "briefs", "matches", "introductions", "consentGiven"] as const) assert.deepEqual(after[k], [], k);
    assert.equal(after.profile, null);
    assert.equal(after.audit.at(-1)!.action, "privacy.deleted");
    assert.ok(!JSON.stringify(after.audit).includes("@example.org"));
    assert.deepEqual(await linus.query(api.introductions.incoming), [], "Linus no longer sees Ada's request or address");
    assert.ok((await linus.query(api.profile.get)) !== null, "another member's data is untouched");
  } finally {
    await t.close();
  }
});
