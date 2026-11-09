/** Deterministic matching (_match.ts): weights, low-signal terms, aliases, freshness, confidence and provenance. Pure. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ALIAS_FACTOR, FIELD_WEIGHT, LOW_SIGNAL_FACTOR, scoreCandidates, SOURCE_WEIGHT, STALE_AFTER_MS, type MatchBrief, type MatchCandidate, type MatchEvidence } from "../feltkit/_match.js";

const now = Date.UTC(2026, 10, 9);
const DAY = 86_400_000;
const brief = (topics: string[], extra: Partial<MatchBrief> = {}): MatchBrief => ({ opportunityType: "expert", topics, target: "", excludedOrganizations: [], excludedPersonIds: [], ...extra });
const ev = (id: string, extra: Partial<MatchEvidence> = {}): MatchEvidence => ({ id, sourceType: "user_attested", claim: "", topics: [], confidence: 0.8, capturedAt: now, ...extra });
const person = (id: string, evidence: MatchEvidence[], extra: Partial<MatchCandidate> = {}): MatchCandidate => ({ personId: id, name: id, relationshipState: "observed", evidence, ...extra });
const byId = (out: ReturnType<typeof scoreCandidates>, id: string) => out.find((m) => m.personId === id);

test("weighting: explicit capability terms outweigh free-text mentions; brief context words count less than topics", () => {
  const out = scoreCandidates(brief(["databases"], { target: "a databases person who knows storage" }), [person("cap", [ev("c", { topics: ["databases"] })]), person("claim", [ev("t", { claim: "Has worked on databases" })]), person("ctx", [ev("x", { claim: "storage engineer" })])], [], now);
  const cap = byId(out, "cap")!.contributions.find((k) => k.counted)!;
  const claim = byId(out, "claim")!.contributions.find((k) => k.counted)!;
  assert.equal(cap.field, "capability");
  assert.equal(claim.field, "claim");
  assert.ok(Math.abs(cap.points / claim.points - FIELD_WEIGHT.capability / FIELD_WEIGHT.claim) < 0.01);
  const ctx = byId(out, "ctx")!.contributions.find((k) => k.counted)!;
  assert.deepEqual([ctx.briefTerm, ctx.termKind], ["storage", "context"]);
  assert.ok(ctx.points < claim.points);
  assert.deepEqual(out.map((m) => m.personId), ["cap", "claim", "ctx"]);
});

test("needs count only for searches where a need is a fit", () => {
  const needy = person("needy", [ev("n", { sourceType: "participant_statement", needTopics: ["compliance"] })]);
  assert.equal(scoreCandidates(brief(["compliance"]), [needy], [], now).length, 0, "an expert search ignores what someone needs");
  const out = scoreCandidates(brief(["compliance"], { opportunityType: "design_partner" }), [needy], [], now);
  assert.equal(out[0]!.contributions[0]!.field, "need");
});

test("low-signal terms count little, never alone make a strong match, and weak matches are shown, labelled", () => {
  const b = brief(["compilers", "systems"]);
  const out = scoreCandidates(b, [person("generic", [ev("g", { claim: "Distributed systems at scale" })]), person("real", [ev("r", { topics: ["compilers"] })])], [], now);
  const generic = byId(out, "generic")!;
  assert.ok(generic, "a weak match is returned, not hidden");
  assert.equal(generic.strength, "weak");
  assert.ok(generic.unknowns.some((u) => u.startsWith("Weak match: only generic")));
  const k = generic.contributions.find((c) => c.counted)!;
  assert.equal(k.lowSignal, true);
  assert.ok(Math.abs(k.points - FIELD_WEIGHT.claim * LOW_SIGNAL_FACTOR * SOURCE_WEIGHT.user_attested * 0.8) < 0.001);
  assert.ok(byId(out, "real")!.score > generic.score);
  assert.notEqual(byId(out, "real")!.strength, "weak");
  // Stop words never match at all.
  assert.deepEqual(scoreCandidates(brief(["compilers"]), [person("stop", [ev("s", { claim: "the and with for someone who" })])], [], now), []);
});

test("aliases: only declared equivalents match, both directions, at a lower weight, citing the alias", () => {
  const pg = person("pg", [ev("p", { claim: "Runs Postgres in production", topics: [] })]);
  assert.deepEqual(scoreCandidates(brief(["databases"]), [pg], [], now), [], "no semantic inference without an alias");
  const aliases = [{ id: "alias-1", term: "databases", equivalents: ["postgres", "distributed storage"] }];
  const [m] = scoreCandidates(brief(["databases"]), [pg], aliases, now);
  const k = m!.contributions.find((c) => c.counted)!;
  assert.deepEqual([k.matchedWord, k.aliasId], ["postgres", "alias-1"]);
  const direct = scoreCandidates(brief(["databases"]), [person("d", [ev("d", { claim: "Runs databases in production" })])], [], now)[0]!.contributions[0]!;
  assert.ok(Math.abs(k.points / direct.points - ALIAS_FACTOR) < 0.01);
  assert.match(m!.reasons[0]!.text, /as “postgres”, your alias/);
  // Reverse direction and multi-word equivalents.
  const rev = scoreCandidates(brief(["postgres"]), [person("r", [ev("r", { topics: ["databases"] })])], aliases, now);
  assert.equal(rev[0]!.contributions[0]!.aliasId, "alias-1");
  const phrase = scoreCandidates(brief(["databases"]), [person("ph", [ev("ph", { claim: "Built distributed storage engines" })])], aliases, now);
  assert.equal(phrase[0]!.contributions[0]!.matchedWord, "distributed storage");
});

test("fresh, high-confidence evidence is preferred", () => {
  const b = brief(["kernels"]);
  const out = scoreCandidates(
    b,
    [
      person("fresh-high", [ev("a", { topics: ["kernels"], confidence: 0.9 })]),
      person("fresh-low", [ev("b", { topics: ["kernels"], confidence: 0.4 })]),
      person("aging", [ev("c", { topics: ["kernels"], confidence: 0.9, capturedAt: now - 200 * DAY })]),
      person("stale", [ev("d", { topics: ["kernels"], confidence: 0.9, capturedAt: now - STALE_AFTER_MS - DAY })]),
    ],
    [],
    now,
  );
  assert.deepEqual(out.map((m) => m.personId), ["fresh-high", "aging", "fresh-low", "stale"]);
  assert.deepEqual(out.map((m) => m.contributions[0]!.freshness), [1, 0.75, 1, 0.4]);
  assert.ok(byId(out, "stale")!.unknowns.some((u) => u.includes("more than a year old")));
  assert.ok(byId(out, "aging")!.unknowns.some((u) => u.includes("more than six months old")));
  // Within one person, the best evidence for a term is the one counted.
  const both = scoreCandidates(b, [person("x", [ev("old", { topics: ["kernels"], capturedAt: now - STALE_AFTER_MS - DAY }), ev("new", { topics: ["kernels"] })])], [], now)[0]!;
  assert.equal(both.contributions.find((k) => k.counted)!.evidenceId, "new");
  assert.equal(both.contributions.filter((k) => k.counted).length, 1, "a term is counted once, however many records mention it");
});

test("provenance: every point and every reason traces to evidence or a relationship event", () => {
  const out = scoreCandidates(
    brief(["databases", "rust"], { geography: "Berlin" }),
    [person("a", [ev("e1", { topics: ["databases"] }), ev("e2", { claim: "writes Rust daily" })], { relationshipState: "known", relationshipEventId: "rel-9" })],
    [],
    now,
  );
  const m = out[0]!;
  const evidenceIds = new Set(["e1", "e2"]);
  for (const k of m.contributions) assert.ok(evidenceIds.has(k.evidenceId));
  const counted = m.contributions.filter((k) => k.counted).reduce((sum, k) => sum + k.points, 0);
  assert.ok(Math.abs(m.score - (counted / 2 + 0.1)) < 0.002, "score = counted points / total term weight + relationship bonus");
  for (const r of m.reasons) {
    if (r.kind === "evidence") assert.ok(r.evidenceIds.length > 0 && r.evidenceIds.every((id) => evidenceIds.has(id)));
    else assert.deepEqual(r.relationshipEventIds, ["rel-9"]);
  }
  assert.ok(m.unknowns.some((u) => u.includes("Location (Berlin)")));
});

test("exclusions apply before scoring", () => {
  const out = scoreCandidates(brief(["databases"], { excludedOrganizations: ["Initech"] }), [person("a", [ev("a", { topics: ["databases"], claim: "Lead at Initech" })]), person("b", [ev("b", { topics: ["databases"] })], { organization: "INITECH Labs" }), person("c", [ev("c", { topics: ["databases"] })])], [], now);
  assert.deepEqual(out.map((m) => m.personId), ["c"]);
});

test("matching is deterministic", () => {
  const input = [person("a", [ev("a", { topics: ["databases"], claim: "systems and databases" })]), person("b", [ev("b", { claim: "databases" })])];
  assert.deepEqual(scoreCandidates(brief(["databases", "systems"]), input, [], now), scoreCandidates(brief(["databases", "systems"]), input, [], now));
});
