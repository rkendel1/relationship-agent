/**
 * Pure policy: relationship transitions, introduction transitions, match scoring and outbound
 * disclosure checks. No I/O; every rule here is covered by tests/rules.test.ts.
 */
import type { EVIDENCE_SOURCE_TYPES, INTRO_STATES, RELATIONSHIP_STATES } from "./app.js";
import { overlap, tokens, truncate } from "./_text.js";

export type RelationshipState = (typeof RELATIONSHIP_STATES)[number];
export type IntroState = (typeof INTRO_STATES)[number];
export type EvidenceSourceType = (typeof EVIDENCE_SOURCE_TYPES)[number];

// ---------------------------------------------------------------------------------------------
// Relationship transitions

const RANK: Record<RelationshipState, number> = { unknown: 0, observed: 1, known: 2, connected: 3, introducible: 3, introduced: 4, active: 5 };

/**
 * Why a relationship may change, and who may cause it. A model or agent has no cause that
 * promotes a person: `user.attest` and `interaction.recorded` require the owner as a user.
 */
export const RELATIONSHIP_CAUSES = {
  // Evidence from an authorized source (import, URL, manual note) exists for this person.
  "source.observed": { to: ["observed"], from: ["unknown"], actor: "any" },
  // The owner says they know / are connected to this person.
  "user.attest": { to: ["known", "connected"], from: ["unknown", "observed", "known", "connected"], actor: "owner" },
  // The person is a participant who opted in to introduction requests on these topics.
  "participant.optin": { to: ["introducible"], from: ["unknown", "observed", "known", "connected"], actor: "any" },
  // Both sides consented and the introduction was made.
  "introduction.introduced": { to: ["introduced"], from: ["unknown", "observed", "known", "connected", "introducible"], actor: "any" },
  // The owner recorded an interaction after an introduction or with someone they know.
  "interaction.recorded": { to: ["active"], from: ["known", "connected", "introducible", "introduced", "active"], actor: "owner" },
} as const satisfies Record<string, { to: readonly RelationshipState[]; from: readonly RelationshipState[]; actor: "any" | "owner" }>;

export type RelationshipCause = keyof typeof RELATIONSHIP_CAUSES;

export type TransitionDecision = { ok: true; changed: boolean } | { ok: false; reason: string };

export function decideRelationshipTransition(input: { from: RelationshipState; to: RelationshipState; cause: RelationshipCause; actorIsOwner: boolean; actorType: string }): TransitionDecision {
  const rule = RELATIONSHIP_CAUSES[input.cause];
  if (!rule) return { ok: false, reason: `Unknown cause ${input.cause}.` };
  if (rule.actor === "owner" && !(input.actorIsOwner && input.actorType === "user")) return { ok: false, reason: `${input.cause} must be performed by the owner, as a person.` };
  if (!(rule.to as readonly string[]).includes(input.to)) return { ok: false, reason: `${input.cause} cannot set ${input.to}.` };
  if (input.from === input.to) return { ok: true, changed: false };
  // System causes never lower a relationship the owner or a workflow has already raised.
  if (rule.actor === "any" && RANK[input.from] >= RANK[input.to]) return { ok: true, changed: false };
  if (!(rule.from as readonly string[]).includes(input.from)) return { ok: false, reason: `${input.cause} cannot move a relationship from ${input.from} to ${input.to}.` };
  return { ok: true, changed: true };
}

// ---------------------------------------------------------------------------------------------
// Introduction transitions

export const INTRO_TRANSITIONS: Record<IntroState, readonly IntroState[]> = {
  draft: ["consent_requested", "manual_ready", "withdrawn"],
  consent_requested: ["introduced", "declined", "withdrawn", "expired"],
  introduced: ["completed"],
  manual_ready: ["manual_sent", "withdrawn"],
  manual_sent: ["completed"],
  completed: [],
  declined: [],
  withdrawn: [],
  expired: [],
};

export function canMoveIntroduction(from: IntroState, to: IntroState): boolean {
  return INTRO_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------------------------
// Matching

export const SOURCE_WEIGHT: Record<EvidenceSourceType, number> = { interaction: 1, participant_statement: 0.9, user_attested: 0.85, contact_import: 0.6, public_url: 0.7 };
const RELATIONSHIP_BONUS: Record<RelationshipState, number> = { unknown: 0, observed: 0, known: 0.15, connected: 0.25, introducible: 0.2, introduced: 0.3, active: 0.35 };
export const STALE_AFTER_MS = 365 * 24 * 60 * 60 * 1000;

export interface CandidateEvidence {
  id: string;
  sourceType: EvidenceSourceType;
  claim: string;
  topics: string[];
  confidence: number;
  capturedAt: number;
}

export interface Candidate {
  personId: string;
  name: string;
  organization?: string;
  relationshipState: RelationshipState;
  evidence: CandidateEvidence[];
}

export interface BriefForMatching {
  topics: string[];
  geography?: string;
  excludedOrganizations: string[];
  excludedPersonIds: string[];
}

export interface ScoredMatch {
  personId: string;
  score: number;
  reasons: Array<{ text: string; evidenceIds: string[]; kind: "evidence" | "relationship" | "inference" }>;
  unknowns: string[];
  relationshipState: RelationshipState;
}

const SOURCE_LABEL: Record<EvidenceSourceType, string> = {
  interaction: "Recorded interaction",
  participant_statement: "Their own network profile",
  user_attested: "Your note",
  contact_import: "Imported contact",
  public_url: "Public source",
};

/** Whether a candidate touches an excluded organization (by org field or anything in its evidence). */
export function isExcluded(candidate: Candidate, brief: BriefForMatching): boolean {
  if (brief.excludedPersonIds.includes(candidate.personId)) return true;
  const orgs = brief.excludedOrganizations.map((o) => o.toLowerCase().trim()).filter(Boolean);
  if (!orgs.length) return false;
  const haystack = [candidate.organization ?? "", ...candidate.evidence.map((e) => e.claim)].join("\n").toLowerCase();
  return orgs.some((o) => haystack.includes(o));
}

/**
 * Scores candidates against a brief. A candidate is returned only when at least one evidence
 * record shares a topic with the brief; each reason cites the evidence ids it rests on.
 */
export function scoreCandidates(brief: BriefForMatching, candidates: Candidate[], now: number): ScoredMatch[] {
  const out: ScoredMatch[] = [];
  for (const c of candidates) {
    if (isExcluded(c, brief)) continue;
    const covered = new Set<string>();
    const reasons: ScoredMatch["reasons"] = [];
    let score = 0;
    const stale: CandidateEvidence[] = [];
    for (const e of c.evidence) {
      const words = [...e.topics, ...tokens(e.claim)];
      const hit = overlap(brief.topics, words);
      if (!hit.length) continue;
      const fresh = now - e.capturedAt <= STALE_AFTER_MS;
      if (!fresh) stale.push(e);
      const weight = SOURCE_WEIGHT[e.sourceType] * e.confidence * (fresh ? 1 : 0.5);
      for (const t of hit) {
        if (!covered.has(t)) score += weight;
        covered.add(t);
      }
      reasons.push({ text: `${SOURCE_LABEL[e.sourceType]}: “${truncate(e.claim, 160)}” — matches ${hit.join(", ")}`, evidenceIds: [e.id], kind: "evidence" });
    }
    if (!reasons.length) continue;
    const coverage = brief.topics.length ? covered.size / brief.topics.length : 0;
    score = score / Math.max(1, brief.topics.length) + coverage * 0.5 + RELATIONSHIP_BONUS[c.relationshipState];

    const relEvidence = c.evidence.filter((e) => e.sourceType === "user_attested" || e.sourceType === "interaction").map((e) => e.id);
    if (c.relationshipState === "known" || c.relationshipState === "connected") reasons.push({ text: `You recorded that you are ${c.relationshipState === "known" ? "acquainted with" : "connected to"} them.`, evidenceIds: relEvidence, kind: "relationship" });
    if (c.relationshipState === "introducible") reasons.push({ text: "They opted in to receive introduction requests on these topics.", evidenceIds: c.evidence.filter((e) => e.sourceType === "participant_statement").map((e) => e.id), kind: "relationship" });
    if (c.relationshipState === "introduced" || c.relationshipState === "active") reasons.push({ text: "You have already been introduced.", evidenceIds: relEvidence, kind: "relationship" });

    const unknowns: string[] = [];
    const missing = brief.topics.filter((t) => !covered.has(t));
    if (missing.length) unknowns.push(`No evidence for: ${missing.join(", ")}.`);
    if (c.relationshipState === "unknown" || c.relationshipState === "observed") unknowns.push("No relationship evidence: this is a discovery, not a connection. Do not imply you know them.");
    if (c.relationshipState !== "introducible") unknowns.push("Whether they are willing to help is unknown.");
    if (brief.geography && !c.evidence.some((e) => e.claim.toLowerCase().includes(brief.geography!.toLowerCase()))) unknowns.push(`Location (${brief.geography}) is not evidenced.`);
    for (const e of stale) unknowns.push(`Evidence ${e.id} is more than a year old and may be out of date.`);

    out.push({ personId: c.personId, score: Math.round(score * 1000) / 1000, reasons, unknowns, relationshipState: c.relationshipState });
  }
  return out.sort((a, b) => b.score - a.score || (a.personId < b.personId ? -1 : 1));
}

// ---------------------------------------------------------------------------------------------
// Outbound disclosure check

export interface DisclosureInput {
  text: string;
  /** Strings the sender has explicitly chosen to disclose (e.g. their own e-mail address). */
  allowed: string[];
  /** Organizations a confidential brief must never reach or mention. */
  excludedOrganizations: string[];
  confidential: boolean;
}

/** Finds private data in outbound text: contact details not chosen for disclosure, excluded organizations. */
export function scanDisclosure(input: DisclosureInput): string[] {
  const issues: string[] = [];
  const allowed = input.allowed.map((a) => a.toLowerCase());
  for (const email of input.text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? []) {
    if (!allowed.includes(email.toLowerCase())) issues.push(`Contains an e-mail address (${email}) that was not chosen for disclosure.`);
  }
  for (const phone of input.text.match(/\+?\d[\d\s().-]{7,}\d/g) ?? []) {
    if (phone.replace(/\D/g, "").length >= 9) issues.push(`Contains what looks like a phone number (${phone.trim()}).`);
  }
  if (input.confidential) {
    for (const org of input.excludedOrganizations) {
      if (org && input.text.toLowerCase().includes(org.toLowerCase())) issues.push(`Mentions ${org}, which this confidential search excludes.`);
    }
  }
  return issues;
}
