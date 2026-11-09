/** Pure policy: interpreter, transitions, scoring and disclosure. No database. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { interpretBrief } from "../feltkit/_intent.js";
import { canMoveIntroduction, decideRelationshipTransition, scanDisclosure } from "../feltkit/_rules.js";
import { parseCsv } from "../feltkit/_csv.js";

test("the interpreter extracts type, topics, place, timing and exclusions deterministically", () => {
  const text = "Find me an expert who can evaluate a FeltKit project on durable databases, ideally in Berlin, this month.";
  const a = interpretBrief(text);
  assert.equal(a.opportunityType, "expert");
  assert.ok(a.topics.includes("feltkit") && a.topics.includes("durable") && a.topics.includes("databases"), a.topics.join(","));
  assert.equal(a.geography, "Berlin");
  assert.equal(a.timing, "this month");
  assert.equal(a.confidential, false);
  assert.deepEqual(interpretBrief(text), a, "same text, same brief");

  const job = interpretBrief("Quietly looking for my next role in developer tools, not anyone at Initech.");
  assert.equal(job.opportunityType, "job");
  assert.equal(job.confidential, true);
  assert.deepEqual(job.excludedOrganizations, ["Initech"]);
  assert.ok(!job.topics.includes("initech"));

  const vague = interpretBrief("Can you help me?");
  assert.equal(vague.opportunityType, "other");
  assert.ok(vague.questions.length >= 2, "asks what kind and about what");
});

test("a model or agent can never promote a relationship; system causes never lower one", () => {
  assert.deepEqual(decideRelationshipTransition({ from: "observed", to: "known", cause: "user.attest", actorIsOwner: true, actorType: "user" }), { ok: true, changed: true });
  assert.equal(decideRelationshipTransition({ from: "observed", to: "known", cause: "user.attest", actorIsOwner: true, actorType: "agent" }).ok, false);
  assert.equal(decideRelationshipTransition({ from: "observed", to: "known", cause: "user.attest", actorIsOwner: false, actorType: "user" }).ok, false);
  assert.equal(decideRelationshipTransition({ from: "unknown", to: "known", cause: "source.observed", actorIsOwner: true, actorType: "user" }).ok, false, "evidence alone cannot make someone known");
  assert.deepEqual(decideRelationshipTransition({ from: "connected", to: "observed", cause: "source.observed", actorIsOwner: true, actorType: "user" }), { ok: true, changed: false });
  assert.equal(decideRelationshipTransition({ from: "observed", to: "active", cause: "interaction.recorded", actorIsOwner: true, actorType: "user" }).ok, false, "an interaction needs a relationship first");
});

test("introduction transitions are a closed state machine", () => {
  assert.ok(canMoveIntroduction("draft", "approved"));
  assert.ok(!canMoveIntroduction("draft", "consent_requested"), "nothing is requested without an approval");
  assert.ok(canMoveIntroduction("approved", "consent_requested"));
  assert.ok(canMoveIntroduction("approved", "external_sent"));
  assert.ok(canMoveIntroduction("consent_requested", "introduced"));
  assert.ok(!canMoveIntroduction("draft", "introduced"), "no introduction without a consent request");
  assert.ok(!canMoveIntroduction("declined", "introduced"));
  assert.ok(!canMoveIntroduction("expired", "consent_requested"));
  assert.ok(!canMoveIntroduction("withdrawn", "introduced"));
});

test("the disclosure scan catches contact details and excluded organizations", () => {
  assert.deepEqual(scanDisclosure({ text: "Reach me at me@ada.dev", allowed: ["me@ada.dev"], excludedOrganizations: [], confidential: false }), []);
  assert.equal(scanDisclosure({ text: "Her email is bob@corp.com", allowed: [], excludedOrganizations: [], confidential: false }).length, 1);
  assert.equal(scanDisclosure({ text: "Call +1 (415) 555-0100", allowed: [], excludedOrganizations: [], confidential: false }).length, 1);
  assert.equal(scanDisclosure({ text: "I am leaving Initech", allowed: [], excludedOrganizations: ["Initech"], confidential: true }).length, 1);
  assert.equal(scanDisclosure({ text: "I am leaving Initech", allowed: [], excludedOrganizations: ["Initech"], confidential: false }).length, 0);
});

test("CSV import handles quotes, commas and CRLF", () => {
  const rows = parseCsv('Name,Email,Notes\r\n"Hopper, Grace",g@navy.mil,"Said ""hello"""\r\n\r\nLinus,,\r\n');
  assert.deepEqual(rows, [
    { name: "Hopper, Grace", email: "g@navy.mil", notes: 'Said "hello"' },
    { name: "Linus", email: "", notes: "" },
  ]);
});
