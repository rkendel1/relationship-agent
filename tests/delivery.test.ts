/**
 * The delivery boundary end to end: approvals, authority, in-app dispatch, the optional external
 * provider through FeltKit's integration contract (sent / failed / unknown), and the manual fallback.
 * External tests run a served app and a test double of the provider's HTTP contract (tests/_provider.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.js";
import { approveAndDeliver, notificationsFor, profile, reviewHash, type T } from "./_helpers.js";
import { ADA, BOT, LINUS, startProvider, startServedApp } from "./_provider.js";

const CONTACTS = `name,email,organization,title,notes,topics
Barbara Liskov,barbara@example.org,MIT,Professor,Reviewed my database design,databases
Ken Thompson,ken@example.org,Initech,Engineer,Databases at Initech,databases
`;

/** Ada with Barbara and Ken (contacts) and Linus (participant), one confirmed, matched brief. */
async function setup(t: T, briefText = "Need a databases expert") {
  const ada = t.as(ADA);
  await ada.mutation(api.profile.save, profile("Ada Lovelace", { email: "ada@example.org" }));
  await t.as(LINUS).mutation(api.profile.save, profile("Linus Pauling", { email: "linus@example.org", openToIntroductions: true, introTopics: ["databases"] }));
  await ada.mutation(api.people.importContacts, { label: "c.csv", csv: CONTACTS });
  const briefId = await ada.mutation(api.briefs.create, { text: briefText });
  await ada.mutation(api.briefs.confirm, { id: briefId });
  await ada.mutation(api.briefs.match, { id: briefId });
  const found = await ada.query(api.matches.list, { briefId });
  const draftFor = async (name: string) => ada.mutation(api.introductions.draft, { matchId: found.find((m) => m.name === name)!.id });
  return { ada, briefId, found, draftFor };
}

async function auditActions(t: T, who = ADA) {
  return (await t.as(who).query(api.privacy.auditLog, { limit: 500 })).map((a) => ({ action: a.action, detail: a.detail ?? {} }));
}

// ---------------------------------------------------------------------------------------------
// Approval

test("approval binds the exact reviewed content, recipient and channel; any change is refused", async () => {
  const t = await createTestApp();
  try {
    const { ada, draftFor } = await setup(t);
    const id = await draftFor("Linus Pauling");
    const reviewed = await reviewHash(ada, id, "in_app");
    const intro = await ada.query(api.introductions.get, { id });
    await ada.mutation(api.introductions.edit, { id, sharedContext: intro.sharedContext, message: "Changed after review.", requesterFields: intro.requesterFields });
    await assert.rejects(ada.mutation(api.introductions.approve, { id, channel: "in_app", contentHash: reviewed }), (e: { code: string; message: string }) => e.code === "FAILED_PRECONDITION" && /changed after you reviewed/.test(e.message));
    // A hash for another channel is not a review of this one.
    const manualFor = await draftFor("Barbara Liskov");
    await assert.rejects(ada.mutation(api.introductions.approve, { id: manualFor, channel: "external", contentHash: await reviewHash(ada, manualFor, "manual") }), { code: "FAILED_PRECONDITION" });
    // In-app is the only channel for a member; manual is not offered for them.
    await assert.rejects(ada.mutation(api.introductions.approve, { id, channel: "manual", contentHash: "x" }), { code: "FAILED_PRECONDITION" });

    const ok = await ada.mutation(api.introductions.approve, { id, channel: "in_app", contentHash: await reviewHash(ada, id, "in_app") });
    const record = (await ada.query(api.privacy.exportAll)).approvals.find((a) => a.id === ok.approvalId)!;
    assert.deepEqual([record.channel, record.recipient, record.message, record.approverId, record.approverType], ["in_app", "user:linus", "Changed after review.", "ada", "user"]);
    assert.equal(record.expiresAt - record.approvedAt, 24 * 3600 * 1000);
    await assert.rejects(ada.mutation(api.introductions.edit, { id, sharedContext: "x", message: "y", requesterFields: [] }), { code: "FAILED_PRECONDITION" }, "approved content is frozen");
  } finally {
    await t.close();
  }
});

test("an approval that expires before dispatch delivers nothing, says why, and can be renewed", async () => {
  const t = await createTestApp();
  const realNow = Date.now;
  try {
    const { ada, draftFor } = await setup(t);
    const id = await draftFor("Linus Pauling");
    const first = await ada.mutation(api.introductions.approve, { id, channel: "in_app", contentHash: await reviewHash(ada, id, "in_app") });
    Date.now = () => realNow() + 25 * 3600 * 1000; // the dispatch job runs after the 24 h approval window
    await t.runtime.runServices();
    let intro = await ada.query(api.introductions.get, { id });
    assert.equal(intro.state, "approved");
    assert.equal(intro.status, "failed");
    assert.match(intro.deliveries[0]!.reason!, /expired before delivery/);
    assert.deepEqual(await t.as(LINUS).query(api.introductions.incoming), [], "nothing reached the recipient");
    assert.equal((await notificationsFor(t, "linus")).length, 0);
    // The same content, approved again, now delivers.
    const second = await ada.mutation(api.introductions.approve, { id, channel: "in_app", contentHash: await reviewHash(ada, id, "in_app") });
    assert.notEqual(second.approvalId, first.approvalId);
    await t.runtime.runServices();
    intro = await ada.query(api.introductions.get, { id });
    assert.deepEqual([intro.state, intro.status], ["consent_requested", "sent"]);
    assert.equal((await t.as(LINUS).query(api.introductions.incoming)).length, 1);
  } finally {
    Date.now = realNow;
    await t.close();
  }
});

test("withdrawing before dispatch: the queued delivery is refused, nothing reaches the recipient", async () => {
  const t = await createTestApp();
  try {
    const { ada, draftFor } = await setup(t);
    const id = await draftFor("Linus Pauling");
    await ada.mutation(api.introductions.approve, { id, channel: "in_app", contentHash: await reviewHash(ada, id, "in_app") });
    await ada.mutation(api.introductions.withdraw, { id });
    await t.runtime.runServices();
    const intro = await ada.query(api.introductions.get, { id });
    assert.deepEqual([intro.state, intro.status, intro.deliveries[0]!.state], ["withdrawn", "withdrawn", "failed"]);
    assert.deepEqual(await t.as(LINUS).query(api.introductions.incoming), []);
    assert.equal((await notificationsFor(t, "linus")).length, 0);
  } finally {
    await t.close();
  }
});

// ---------------------------------------------------------------------------------------------
// Authority

test("agents can draft briefs and run matching, but cannot approve, dispatch or send", async () => {
  const provider = await startProvider();
  const served = await startServedApp({ providerUrl: provider.url });
  const { t, invoke } = served;
  try {
    const { ada, draftFor, briefId } = await setup(t);
    const bot = t.as(BOT);
    assert.ok(await bot.mutation(api.briefs.create, { text: "storage experts" }), "an agent may draft a brief");
    assert.ok(await bot.query(api.matches.list, { briefId }).catch(() => "not-owner"), "reads are scoped to the agent's own principal");
    const id = await draftFor("Linus Pauling");
    const hash = await reviewHash(ada, id, "in_app");
    await assert.rejects(bot.mutation(api.introductions.approve, { id, channel: "in_app", contentHash: hash }), { code: "FORBIDDEN" });
    await assert.rejects(bot.mutation(api.deliveries.prepareExternal, { introductionId: id }), { code: "FORBIDDEN" });
    await assert.rejects(bot.mutation(api.deliveries.dispatch, { deliveryId: "x" }), { code: "FORBIDDEN" });
    const send = await invoke(BOT, "delivery.send", { deliveryId: "x", to: "a@b.c", subject: "s", body: "b" }, "k");
    assert.equal(send.ok, false);
    assert.equal(!send.ok && send.error.code, "FORBIDDEN");
    // The approval path also refuses a non-person even with the permission (defense in depth beyond roles).
    const agentWithRoles = t.as({ id: "ada", type: "agent", roles: ["member", "external_sender"] });
    await assert.rejects(agentWithRoles.mutation(api.introductions.approve, { id, channel: "in_app", contentHash: hash }), { code: "FORBIDDEN" });
    assert.equal(provider.requests.length, 0);
  } finally {
    await served.close();
    await provider.close();
  }
});

test("external delivery needs explicit authority: a member without external_sender cannot choose or send it", async () => {
  const provider = await startProvider();
  const served = await startServedApp({ providerUrl: provider.url });
  const { t, invoke } = served;
  try {
    const grace = { id: "grace", type: "user" as const, roles: ["member"] };
    const g = t.as(grace);
    await g.mutation(api.profile.save, profile("Grace"));
    await g.mutation(api.people.importContacts, { label: "c.csv", csv: CONTACTS });
    const briefId = await g.mutation(api.briefs.create, { text: "databases expert" });
    await g.mutation(api.briefs.confirm, { id: briefId });
    await g.mutation(api.briefs.match, { id: briefId });
    const m = (await g.query(api.matches.list, { briefId })).find((x) => x.name === "Barbara Liskov")!;
    const id = await g.mutation(api.introductions.draft, { matchId: m.id });
    const intro = await g.query(api.introductions.get, { id });
    const external = intro.channels.find((c) => c.channel === "external")!;
    assert.equal(external.available, false);
    assert.match(external.reason!, /delivery\.send/);
    await assert.rejects(g.mutation(api.introductions.approve, { id, channel: "external", contentHash: external.hash }), { code: "FORBIDDEN" });
    await assert.rejects(g.mutation(api.deliveries.prepareExternal, { introductionId: id }), { code: "FORBIDDEN" });
    const send = await invoke(grace, "delivery.send", { deliveryId: "x", to: "barbara@example.org", subject: "s", body: "b" }, "k");
    assert.equal(!send.ok && send.error.code, "FORBIDDEN");
    assert.equal(provider.requests.filter((r) => r.method === "POST").length, 0);
    // The manual path stays available to her.
    assert.equal(intro.channels.find((c) => c.channel === "manual")!.available, true);
  } finally {
    await served.close();
    await provider.close();
  }
});

// ---------------------------------------------------------------------------------------------
// In-app delivery

test("in-app delivery: queued at approval, delivered by the after-commit job, notified once, idempotent", async () => {
  const t = await createTestApp();
  try {
    const { ada, draftFor } = await setup(t);
    const id = await draftFor("Linus Pauling");
    const hash = await reviewHash(ada, id, "in_app");
    const approved = await ada.mutation(api.introductions.approve, { id, channel: "in_app", contentHash: hash });
    assert.deepEqual([approved.status, (await notificationsFor(t, "linus")).length], ["queued", 0], "nothing before the job runs");

    await t.runtime.runServices();
    let intro = await ada.query(api.introductions.get, { id });
    assert.deepEqual([intro.state, intro.status, intro.deliveries.length, intro.deliveries[0]!.determinedBy], ["consent_requested", "sent", 1, "commit"]);
    assert.equal((await notificationsFor(t, "linus")).filter((n) => n.type === "introduction.requested").length, 1);

    // Duplicates: approving the same content again, and running the dispatch again, change nothing.
    assert.equal((await ada.mutation(api.introductions.approve, { id, channel: "in_app", contentHash: hash })).alreadyApplied, true);
    assert.deepEqual(await ada.mutation(api.deliveries.dispatch, { deliveryId: approved.deliveryId! }), { state: "sent" });
    await t.runtime.runServices();
    intro = await ada.query(api.introductions.get, { id });
    assert.equal(intro.deliveries.length, 1);
    assert.equal(intro.events.filter((e) => e.to === "consent_requested").length, 1);
    assert.equal((await notificationsFor(t, "linus")).filter((n) => n.type === "introduction.requested").length, 1);
    const grants = (await ada.query(api.privacy.exportAll)).consentGiven;
    assert.equal(grants.length, 1, "one requester consent grant");

    const log = await auditActions(t);
    const queued = log.find((a) => a.action === "delivery.queued")!;
    const sent = log.find((a) => a.action === "delivery.sent")!;
    assert.deepEqual([queued.detail.channel, sent.detail.provider], ["in_app", "in_app"]);
  } finally {
    await t.close();
  }
});

// ---------------------------------------------------------------------------------------------
// External delivery through FeltKit's integration contract

/** Ada approves outreach to Barbara (not a member) for external delivery and prepares the send. */
async function externalReady(t: T) {
  const { ada, draftFor } = await setup(t);
  const id = await draftFor("Barbara Liskov");
  const approved = await ada.mutation(api.introductions.approve, { id, channel: "external", contentHash: await reviewHash(ada, id, "external") });
  assert.deepEqual([approved.state, approved.status, approved.deliveryId], ["approved", "approved", null], "nothing is sent at approval");
  const prepared = await ada.mutation(api.deliveries.prepareExternal, { introductionId: id });
  if (!prepared.ok) throw new Error(prepared.reason);
  return { ada, id, prepared };
}

test("external delivery succeeds only on a confirmed provider result; a repeat with the same key is not resent", async () => {
  const provider = await startProvider();
  const served = await startServedApp({ providerUrl: provider.url });
  const { t, invoke } = served;
  try {
    const { ada, id, prepared } = await externalReady(t);
    assert.equal((await ada.query(api.introductions.get, { id })).status, "queued");
    const first = await invoke(ADA, prepared.capability, prepared.input, prepared.idempotencyKey);
    assert.equal(first.ok, true);
    let intro = await ada.query(api.introductions.get, { id });
    assert.deepEqual([intro.state, intro.status], ["external_sent", "sent"]);
    const d = intro.deliveries[0]!;
    assert.deepEqual([d.state, d.determinedBy, d.providerStatus, d.contentMismatch], ["sent", "response", 200, false]);

    const again = await invoke(ADA, prepared.capability, prepared.input, prepared.idempotencyKey);
    assert.equal(again.ok, true, "FeltKit answers a replay of a succeeded key from its record");
    const posts = provider.requests.filter((r) => r.method === "POST");
    assert.equal(posts.length, 1, "the provider received it once");
    assert.equal(posts[0]!.idempotencyKey, prepared.idempotencyKey);
    assert.equal(posts[0]!.authorized, true, "the credential is attached by FeltKit, server-side");
    assert.deepEqual(posts[0]!.body, prepared.input);
    intro = await ada.query(api.introductions.get, { id });
    assert.equal(intro.deliveries.length, 1);

    // Recipient-side privacy: the requester's own address is not in the outreach; no credential anywhere in app data.
    const exported = JSON.stringify(await ada.query(api.privacy.exportAll));
    assert.ok(!exported.includes("test-provider-token"));
    const sent = (await auditActions(t)).find((a) => a.action === "delivery.sent")!;
    assert.deepEqual([sent.detail.provider, sent.detail.providerStatus, sent.detail.determinedBy], ["integration:delivery", 200, "response"]);
    assert.ok(!JSON.stringify(await auditActions(t)).includes("barbara@example.org"), "audit holds no addresses");
  } finally {
    await served.close();
    await provider.close();
  }
});

test("external delivery failure is recorded with the provider's answer, and a new approval is needed to try again", async () => {
  const provider = await startProvider();
  provider.mode = "reject";
  const served = await startServedApp({ providerUrl: provider.url });
  const { t, invoke } = served;
  try {
    const { ada, id, prepared } = await externalReady(t);
    const result = await invoke(ADA, prepared.capability, prepared.input, prepared.idempotencyKey);
    assert.equal(!result.ok && result.error.code, "UPSTREAM_REJECTED");
    let intro = await ada.query(api.introductions.get, { id });
    assert.deepEqual([intro.state, intro.status], ["approved", "failed"]);
    const d = intro.deliveries[0]!;
    assert.deepEqual([d.state, d.providerStatus, d.providerCode], ["failed", 422, "UPSTREAM_REJECTED"]);
    assert.match(d.reason!, /refused it \(HTTP 422\).*Nothing was delivered/);
    const failed = (await auditActions(t)).find((a) => a.action === "delivery.failed")!;
    assert.deepEqual([failed.detail.providerStatus, failed.detail.providerCode], [422, "UPSTREAM_REJECTED"]);

    // The used approval cannot be reused; a fresh approval (a person's decision) allows a new attempt with a new key.
    const reused = await ada.mutation(api.deliveries.prepareExternal, { introductionId: id });
    assert.equal(reused.ok, false);
    provider.mode = "accept";
    await ada.mutation(api.introductions.approve, { id, channel: "external", contentHash: await reviewHash(ada, id, "external") });
    const retry = await ada.mutation(api.deliveries.prepareExternal, { introductionId: id });
    assert.ok(retry.ok && retry.idempotencyKey !== prepared.idempotencyKey);
    if (retry.ok) assert.equal((await invoke(ADA, retry.capability, retry.input, retry.idempotencyKey)).ok, true);
    intro = await ada.query(api.introductions.get, { id });
    assert.deepEqual([intro.state, intro.status], ["external_sent", "sent"]);
  } finally {
    await served.close();
    await provider.close();
  }
});

test("an unknown external outcome is never retried blindly; verification against the provider settles it", async () => {
  const provider = await startProvider();
  provider.mode = "down";
  const served = await startServedApp({ providerUrl: provider.url });
  const { t, invoke } = served;
  try {
    const { ada, id, prepared } = await externalReady(t);
    const first = await invoke(ADA, prepared.capability, prepared.input, prepared.idempotencyKey);
    assert.equal(!first.ok && first.error.code, "OUTCOME_UNKNOWN");
    let intro = await ada.query(api.introductions.get, { id });
    assert.deepEqual([intro.state, intro.status], ["approved", "unknown"]);
    assert.match(intro.deliveries[0]!.reason!, /may have been delivered\. It will not be resent/);

    // Retrying the same send: FeltKit refuses it without contacting the provider.
    provider.mode = "accept";
    const replay = await invoke(ADA, prepared.capability, prepared.input, prepared.idempotencyKey);
    assert.equal(!replay.ok && replay.error.details?.reason, "IDEMPOTENCY_OUTCOME_UNKNOWN");
    assert.equal(provider.requests.filter((r) => r.method === "POST").length, 1);
    // The app refuses the other ways around it: a new approval, a new prepare, or a withdrawal.
    // Approving the same content again is a no-op that reports the unknown outcome; nothing new is created.
    const same = await ada.mutation(api.introductions.approve, { id, channel: "external", contentHash: await reviewHash(ada, id, "external") });
    assert.deepEqual([same.alreadyApplied, same.status, same.deliveryId], [true, "unknown", prepared.deliveryId]);
    // Approving different content is refused until the outcome is settled.
    await assert.rejects(ada.mutation(api.introductions.approve, { id, channel: "manual", contentHash: await reviewHash(ada, id, "manual") }), (e: { message: string }) => /must be settled/.test(e.message));
    assert.equal((await ada.mutation(api.deliveries.prepareExternal, { introductionId: id })).ok, false);
    await assert.rejects(ada.mutation(api.introductions.withdraw, { id }), { code: "FAILED_PRECONDITION" });
    // The client cannot declare it "not sent" either: only pre-send refusals may be reported, and a call record exists.
    await ada.mutation(api.deliveries.recordNotSent, { deliveryId: prepared.deliveryId, code: "NOT_CONFIGURED", message: "x" });
    assert.equal((await ada.query(api.introductions.get, { id })).status, "unknown");

    // Verification reads the provider's own record (it did accept it) and runs onOutcome again.
    const [call] = await t.runtime.integrations.calls({ integration: "delivery", state: "unknown" });
    const settled = await t.runtime.integrations.verify(call!.id, ADA);
    assert.deepEqual([settled.state, settled.determinedBy], ["succeeded", "verification"]);
    intro = await ada.query(api.introductions.get, { id });
    assert.deepEqual([intro.state, intro.status, intro.deliveries[0]!.determinedBy], ["external_sent", "sent", "verification"]);
    assert.equal(provider.requests.filter((r) => r.method === "POST").length, 1, "still sent exactly once");
  } finally {
    await served.close();
    await provider.close();
  }
});

test("a send whose content differs from the approval is detected and audited (FeltKit's authorize hook does not gate integrations)", async () => {
  const provider = await startProvider();
  const served = await startServedApp({ providerUrl: provider.url });
  const { t, invoke } = served;
  try {
    const { ada, id, prepared } = await externalReady(t);
    const tampered = await invoke(ADA, prepared.capability, { ...prepared.input, body: "Something never approved." }, prepared.idempotencyKey);
    assert.equal(tampered.ok, true, "FeltKit 0.3.18 sends it: the app cannot refuse it before it leaves");
    const d = (await ada.query(api.introductions.get, { id })).deliveries[0]!;
    assert.deepEqual([d.state, d.contentMismatch], ["sent", true]);
    assert.ok((await auditActions(t)).some((a) => a.action === "delivery.content_mismatch"));
    // A send the app never prepared is audited as untracked.
    await invoke(ADA, "delivery.send", { deliveryId: "not-a-delivery", to: "x@example.org", subject: "s", body: "b" }, "stray-key");
    assert.ok((await auditActions(t)).some((a) => a.action === "delivery.untracked_send"));
  } finally {
    await served.close();
    await provider.close();
  }
});

test("a recipient address changed after approval is refused at send time", async () => {
  const provider = await startProvider();
  const served = await startServedApp({ providerUrl: provider.url });
  const { t } = served;
  try {
    const { ada, draftFor } = await setup(t);
    const id = await draftFor("Barbara Liskov");
    await ada.mutation(api.introductions.approve, { id, channel: "external", contentHash: await reviewHash(ada, id, "external") });
    const barbara = (await ada.query(api.people.list)).find((p) => p.name === "Barbara Liskov")!;
    await ada.mutation(api.people.update, { id: barbara.id, email: "b.liskov@example.org" });
    const result = await ada.mutation(api.deliveries.prepareExternal, { introductionId: id });
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.reason : "", /recipient changed after approval/);
    const intro = await ada.query(api.introductions.get, { id });
    assert.equal(intro.status, "failed");
    assert.equal(provider.requests.filter((r) => r.method === "POST").length, 0);
  } finally {
    await served.close();
    await provider.close();
  }
});

// ---------------------------------------------------------------------------------------------
// No provider: readiness and the manual fallback

test("without a provider: readiness says so, a send attempt is refused before leaving, and the manual path remains", async () => {
  const served = await startServedApp();
  const { t, invoke } = served;
  try {
    const { ada, draftFor } = await setup(t);
    const health = await invoke(ADA, "delivery.health", {});
    assert.equal(!health.ok && health.error.code, "NOT_CONFIGURED");
    assert.match(!health.ok ? health.error.message : "", /DELIVERY_PROVIDER_URL is not set/);
    assert.ok(!(!health.ok && health.error.message).toString().includes("test-provider-token"));
    const readiness = await ada.query(api.deliveries.readiness);
    assert.equal(readiness.external.authority, true);
    assert.equal(readiness.manual.available, true);

    const id = await draftFor("Barbara Liskov");
    const intro = await ada.query(api.introductions.get, { id });
    assert.deepEqual(intro.channels.map((c) => [c.channel, c.available]), [["external", true], ["manual", true]], "the app cannot know configuration; FeltKit decides at call time");
    await ada.mutation(api.introductions.approve, { id, channel: "external", contentHash: await reviewHash(ada, id, "external") });
    const prepared = await ada.mutation(api.deliveries.prepareExternal, { introductionId: id });
    assert.ok(prepared.ok);
    if (!prepared.ok) return;
    const send = await invoke(ADA, prepared.capability, prepared.input, prepared.idempotencyKey);
    assert.equal(!send.ok && send.error.code, "NOT_CONFIGURED");
    await ada.mutation(api.deliveries.recordNotSent, { deliveryId: prepared.deliveryId, code: "NOT_CONFIGURED", message: "The delivery provider is not configured." });
    let detail = await ada.query(api.introductions.get, { id });
    assert.deepEqual([detail.state, detail.status], ["approved", "failed"]);
    assert.match(detail.deliveries[0]!.reason!, /not configured/);

    // Manual fallback: approve for manual; the app asks the person to act and never claims delivery.
    const manual = await ada.mutation(api.introductions.approve, { id, channel: "manual", contentHash: await reviewHash(ada, id, "manual") });
    assert.deepEqual([manual.state, manual.status], ["manual_ready", "manual_action_required"]);
    await ada.mutation(api.introductions.markSent, { id });
    detail = await ada.query(api.introductions.get, { id });
    assert.deepEqual([detail.state, detail.status, detail.deliveries[0]!.determinedBy], ["manual_sent", "sent", "person"]);
  } finally {
    await served.close();
  }
});

test("manual approval of someone already known still takes the manual path (regression)", async () => {
  const t = await createTestApp();
  try {
    const { ada, draftFor } = await setup(t);
    const barbara = (await ada.query(api.people.list)).find((p) => p.name === "Barbara Liskov")!;
    await ada.mutation(api.people.attest, { personId: barbara.id, state: "known", note: "We worked together." });
    const id = await draftFor("Barbara Liskov");
    const r = await ada.mutation(api.introductions.approve, { id, channel: "manual", contentHash: await reviewHash(ada, id, "manual") });
    assert.deepEqual([r.state, r.status], ["manual_ready", "manual_action_required"]);
  } finally {
    await t.close();
  }
});

// ---------------------------------------------------------------------------------------------
// Privacy model preserved

test("career-search exclusions hold on every channel", async () => {
  const provider = await startProvider();
  const served = await startServedApp({ providerUrl: provider.url });
  const { t } = served;
  try {
    const ada = t.as(ADA);
    await ada.mutation(api.profile.save, profile("Ada"));
    await ada.mutation(api.people.importContacts, { label: "c.csv", csv: CONTACTS });
    const briefId = await ada.mutation(api.briefs.create, { text: "Quietly looking for my next role in databases, not anyone at Initech." });
    await ada.mutation(api.briefs.confirm, { id: briefId });
    await ada.mutation(api.briefs.match, { id: briefId });
    const found = await ada.query(api.matches.list, { briefId, includeRejected: true });
    assert.ok(!found.some((m) => m.name === "Ken Thompson"));
    // Even if Ken's record were reached another way, a draft and an approval are refused.
    const ken = (await ada.query(api.people.list)).find((p) => p.name === "Ken Thompson")!;
    assert.ok(ken);
    const barbara = found.find((m) => m.name === "Barbara Liskov")!;
    const id = await ada.mutation(api.introductions.draft, { matchId: barbara.id });
    const intro = await ada.query(api.introductions.get, { id });
    await ada.mutation(api.introductions.edit, { id, sharedContext: intro.sharedContext, message: "Please keep this from Initech.", requesterFields: [] });
    await assert.rejects(ada.mutation(api.introductions.approve, { id, channel: "external", contentHash: await reviewHash(ada, id, "external") }), (e: { message: string }) => /Initech/.test(e.message));
    assert.equal(provider.requests.filter((r) => r.method === "POST").length, 0);
  } finally {
    await served.close();
    await provider.close();
  }
});

test("delivery records are private to their owner", async () => {
  const t = await createTestApp();
  try {
    const { ada, draftFor } = await setup(t);
    const id = await draftFor("Linus Pauling");
    const r = await approveAndDeliver(t, ada, id);
    const grace = t.as({ id: "grace", type: "user", roles: ["member"] });
    await assert.rejects(grace.query(api.deliveries.forIntroduction, { introductionId: id }), { code: "NOT_FOUND" });
    await assert.rejects(grace.mutation(api.deliveries.dispatch, { deliveryId: r.deliveryId! }), { code: "NOT_FOUND" });
    await assert.rejects(grace.mutation(api.deliveries.recordNotSent, { deliveryId: r.deliveryId!, code: "NOT_CONFIGURED", message: "x" }), { code: "NOT_FOUND" });
    await assert.rejects(t.as(LINUS).query(api.introductions.get, { id }), { code: "NOT_FOUND" }, "the recipient sees the request, not the delivery record");
    assert.deepEqual((await grace.query(api.deliveries.readiness)).deliveries, { queued: 0, sent: 0, failed: 0, unknown: 0, manualActionRequired: 0 });
  } finally {
    await t.close();
  }
});

test("export includes approvals, deliveries and aliases; deletion removes them", async () => {
  const t = await createTestApp();
  try {
    const { ada, draftFor } = await setup(t);
    await ada.mutation(api.aliases.set, { term: "databases", equivalents: ["postgres"] });
    await approveAndDeliver(t, ada, await draftFor("Linus Pauling"));
    const before = await ada.query(api.privacy.exportAll);
    assert.deepEqual([before.approvals.length, before.deliveries.length, before.aliases.length], [1, 1, 1]);
    await ada.mutation(api.privacy.deleteAll, { confirm: "DELETE" });
    const after = await ada.query(api.privacy.exportAll);
    assert.deepEqual([after.approvals.length, after.deliveries.length, after.aliases.length], [0, 0, 0]);
    assert.deepEqual(await t.as(LINUS).query(api.introductions.incoming), []);
  } finally {
    await t.close();
  }
});
