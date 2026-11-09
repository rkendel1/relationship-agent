/**
 * Pure policy: relationship transitions, introduction transitions, match scoring and outbound
 * disclosure checks. No I/O; every rule here is covered by tests/rules.test.ts.
 */
import type { EVIDENCE_SOURCE_TYPES, INTRO_STATES, RELATIONSHIP_STATES } from "./app.js";

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
  draft: ["approved", "withdrawn"],
  // An approval chose a channel; a delivery (or the owner, on the manual path) moves it on.
  approved: ["consent_requested", "manual_ready", "external_sent", "withdrawn"],
  consent_requested: ["introduced", "declined", "withdrawn", "expired"],
  introduced: ["completed"],
  manual_ready: ["manual_sent", "withdrawn"],
  manual_sent: ["completed"],
  external_sent: ["completed"],
  completed: [],
  declined: [],
  withdrawn: [],
  expired: [],
};

export function canMoveIntroduction(from: IntroState, to: IntroState): boolean {
  return INTRO_TRANSITIONS[from].includes(to);
}

// Matching lives in _match.ts.
export { isExcluded } from "./_match.js";

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
