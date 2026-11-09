/** Pure policy: interpreter, transitions, scoring and disclosure. No database. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { interpretBrief } from "../feltkit/_intent.js";
import { canMoveIntroduction, decideRelationshipTransition, scanDisclosure, scoreCandidates, STALE_AFTER_MS, type Candidate } from "../feltkit/_rules.js";
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
  assert.ok(canMoveIntroduction("draft", "consent_requested"));
  assert.ok(canMoveIntroduction("consent_requested", "introduced"));
  assert.ok(!canMoveIntroduction("draft", "introduced"), "no introduction without a consent request");
  assert.ok(!canMoveIntroduction("declined", "introduced"));
  assert.ok(!canMoveIntroduction("expired", "consent_requested"));
  assert.ok(!canMoveIntroduction("withdrawn", "introduced"));
});

const now = Date.UTC(2026, 10, 9);
const person = (id: string, evidence: Candidate["evidence"], extra: Partial<Candidate> = {}): Candidate => ({ personId: id, name: id, relationshipState: "observed", evidence, ...extra });
const ev = (id: string, claim: string, extra: Partial<Candidate["evidence"][number]> = {}) => ({ id, sourceType: "contact_import" as const, claim, topics: [], confidence: 0.6, capturedAt: now, ...extra });

test("only candidates with matching evidence are returned, and every reason cites it", () => {
  const brief = { topics: ["feltkit", "databases"], excludedOrganizations: [], excludedPersonIds: [] };
  const out = scoreCandidates(brief, [person("a", [ev("e1", "Built three databases")]), person("b", [ev("e2", "Plays the cello")]), person("c", [])], now);
  assert.deepEqual(out.map((m) => m.personId), ["a"]);
  assert.deepEqual(out[0]!.reasons.filter((r) => r.kind === "evidence").map((r) => r.evidenceIds), [["e1"]]);
  assert.ok(out[0]!.unknowns.some((u) => u.includes("feltkit")), "names the topic with no evidence");
  assert.ok(out[0]!.unknowns.some((u) => u.includes("discovery, not a connection")));
});

test("relationship strength and freshness change ranking; exclusions remove candidates", () => {
  const brief = { topics: ["databases"], excludedOrganizations: ["Initech"], excludedPersonIds: ["x"] };
  const out = scoreCandidates(
    brief,
    [
      person("stale", [ev("s", "databases expert", { capturedAt: now - STALE_AFTER_MS - 1 })]),
      person("known", [ev("k", "databases expert")], { relationshipState: "known" }),
      person("plain", [ev("p", "databases expert")]),
      person("initech", [ev("i", "databases expert")], { organization: "Initech Labs" }),
      person("mentions", [ev("m", "databases lead, formerly at Initech")]),
      person("x", [ev("xx", "databases expert")]),
    ],
    now,
  );
  assert.deepEqual(out.map((m) => m.personId), ["known", "plain", "stale"]);
  assert.ok(out[2]!.unknowns.some((u) => u.includes("more than a year old")));
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
