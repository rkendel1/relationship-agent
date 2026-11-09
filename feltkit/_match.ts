/**
 * Deterministic, explainable matching. Pure: no I/O, no clock (the caller passes `now`), no model.
 *
 * A candidate's score is the sum of *contributions*. Each contribution is one brief term found in
 * one field of one evidence record, and records every factor that produced its points:
 *
 *   points = termWeight × fieldWeight × signal × alias × sourceWeight × confidence × freshness
 *
 * - termWeight   explicit brief topics 1.0; words from the brief's "looking for" text 0.4
 * - fieldWeight  capability terms (what the person offers) 1.0; free-text claim 0.6;
 *                stated needs 0.8 (only for customer / design partner / collaborator searches)
 * - signal       0.3 for low-signal words ("systems", "software", …), else 1
 * - alias        0.9 when the term matched only through a user-declared alias
 * - freshness    1 up to 180 days, 0.75 up to a year, 0.4 after
 *
 * Only the best contribution per brief term is counted, so repeating a word in many records does
 * not inflate a score. Nothing is inferred: a term matches its own stem or a declared alias.
 */
import type { EVIDENCE_SOURCE_TYPES, OPPORTUNITY_TYPES, RELATIONSHIP_STATES } from "./app.js";
import { GENERIC } from "./_intent.js";
import { isLowSignal, stem, tokens, truncate, words } from "./_text.js";

type RelationshipState = (typeof RELATIONSHIP_STATES)[number];
type EvidenceSourceType = (typeof EVIDENCE_SOURCE_TYPES)[number];
type OpportunityType = (typeof OPPORTUNITY_TYPES)[number];

export const TERM_WEIGHT = { explicit: 1, context: 0.4 } as const;
export const FIELD_WEIGHT = { capability: 1, claim: 0.6, need: 0.8 } as const;
export const LOW_SIGNAL_FACTOR = 0.3;
export const ALIAS_FACTOR = 0.9;
export const SOURCE_WEIGHT: Record<EvidenceSourceType, number> = { interaction: 1, participant_statement: 0.9, user_attested: 0.85, public_url: 0.7, contact_import: 0.6 };
export const RELATIONSHIP_BONUS: Record<RelationshipState, number> = { unknown: 0, observed: 0, known: 0.1, connected: 0.15, introducible: 0.12, introduced: 0.2, active: 0.25 };
const DAY = 24 * 60 * 60 * 1000;
export const FRESH_FOR_MS = 180 * DAY;
export const STALE_AFTER_MS = 365 * DAY;
/** Search types where what a person *needs* is evidence that they fit. */
export const NEED_TYPES: readonly OpportunityType[] = ["customer", "design_partner", "collaborator"];

export function freshness(capturedAt: number, now: number): number {
  const age = now - capturedAt;
  return age <= FRESH_FOR_MS ? 1 : age <= STALE_AFTER_MS ? 0.75 : 0.4;
}

export interface MatchEvidence {
  id: string;
  sourceType: EvidenceSourceType;
  claim: string;
  topics: string[];
  needTopics?: string[];
  confidence: number;
  capturedAt: number;
}

export interface MatchCandidate {
  personId: string;
  name: string;
  organization?: string;
  relationshipState: RelationshipState;
  /** The relationship event that established the current state, if any. */
  relationshipEventId?: string;
  evidence: MatchEvidence[];
}

export interface MatchBrief {
  opportunityType: OpportunityType;
  topics: string[];
  target: string;
  geography?: string;
  excludedOrganizations: string[];
  excludedPersonIds: string[];
}

export interface Alias {
  id: string;
  term: string;
  equivalents: string[];
}

export interface Contribution {
  briefTerm: string;
  termKind: "explicit" | "context";
  matchedWord: string;
  field: "capability" | "claim" | "need";
  evidenceId: string;
  aliasId?: string;
  lowSignal: boolean;
  confidence: number;
  freshness: number;
  points: number;
  counted: boolean;
}

export interface Reason {
  text: string;
  evidenceIds: string[];
  kind: "evidence" | "relationship" | "inference";
  relationshipEventIds?: string[];
}

export interface Scored {
  personId: string;
  score: number;
  strength: "strong" | "moderate" | "weak";
  contributions: Contribution[];
  reasons: Reason[];
  unknowns: string[];
  relationshipState: RelationshipState;
}

/** Brief terms with their kind: explicit topics, then distinct content words from the target text. */
export function briefTerms(brief: Pick<MatchBrief, "topics" | "target">): Array<{ term: string; kind: "explicit" | "context" }> {
  const explicit = [...new Set(brief.topics.map((t) => t.toLowerCase()))];
  const seen = new Set(explicit.map(stem));
  const context = tokens(brief.target).filter((t) => !GENERIC.has(t) && !isLowSignal(t) && !seen.has(stem(t)) && (seen.add(stem(t)), true));
  return [...explicit.map((term) => ({ term, kind: "explicit" as const })), ...context.map((term) => ({ term, kind: "context" as const }))];
}

/** For each term, the stems it may match and the alias that allows each one (declared aliases only, both directions). */
export function expansions(term: string, aliases: Alias[]): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>([[stem(term), undefined]]);
  for (const a of aliases) {
    const stems = [a.term, ...a.equivalents].map((w) => words(w).map(stem).join(" ")).filter(Boolean);
    if (!stems.includes(stem(term))) continue;
    for (const s of stems) if (!out.has(s)) out.set(s, a.id);
  }
  return out;
}

const SOURCE_LABEL: Record<EvidenceSourceType, string> = {
  interaction: "Recorded interaction",
  participant_statement: "Their own network profile",
  user_attested: "Your note",
  contact_import: "Imported contact",
  public_url: "Public source",
};

/** Whether a candidate touches an excluded person or organization (by org field or anything in its evidence). */
export function isExcluded(candidate: Pick<MatchCandidate, "personId" | "organization" | "evidence">, brief: Pick<MatchBrief, "excludedOrganizations" | "excludedPersonIds">): boolean {
  if (brief.excludedPersonIds.includes(candidate.personId)) return true;
  const orgs = brief.excludedOrganizations.map((o) => o.toLowerCase().trim()).filter(Boolean);
  if (!orgs.length) return false;
  const haystack = [candidate.organization ?? "", ...candidate.evidence.map((e) => e.claim)].join("\n").toLowerCase();
  return orgs.some((o) => haystack.includes(o));
}

/** Content words of one evidence field, in order, so multi-word alias phrases can match adjacent words. */
function fieldWords(e: MatchEvidence, field: Contribution["field"]): string[] {
  if (field === "capability") return e.topics.flatMap((t) => words(t));
  if (field === "need") return (e.needTopics ?? []).flatMap((t) => words(t));
  return words(e.claim);
}

function findIn(words: string[], targets: Map<string, string | undefined>): { word: string; aliasId?: string } | null {
  const stems = words.map(stem);
  for (const [target, aliasId] of targets) {
    const parts = target.split(" ");
    for (let i = 0; i + parts.length <= stems.length; i++) {
      if (parts.every((p, j) => stems[i + j] === p)) return { word: words.slice(i, i + parts.length).join(" "), ...(aliasId ? { aliasId } : {}) };
    }
  }
  return null;
}

export function scoreCandidates(brief: MatchBrief, candidates: MatchCandidate[], aliases: Alias[], now: number): Scored[] {
  const terms = briefTerms(brief);
  const totalWeight = terms.reduce((sum, t) => sum + TERM_WEIGHT[t.kind], 0) || 1;
  const fields: Array<Contribution["field"]> = NEED_TYPES.includes(brief.opportunityType) ? ["capability", "claim", "need"] : ["capability", "claim"];
  const expanded = terms.map((t) => ({ ...t, targets: expansions(t.term, aliases) }));
  const out: Scored[] = [];

  for (const c of candidates) {
    if (isExcluded(c, brief)) continue;
    const contributions: Contribution[] = [];
    for (const t of expanded) {
      for (const e of c.evidence) {
        for (const field of fields) {
          const hit = findIn(fieldWords(e, field), t.targets);
          if (!hit) continue;
          const low = isLowSignal(t.term);
          const fresh = freshness(e.capturedAt, now);
          const points = TERM_WEIGHT[t.kind] * FIELD_WEIGHT[field] * (low ? LOW_SIGNAL_FACTOR : 1) * (hit.aliasId ? ALIAS_FACTOR : 1) * SOURCE_WEIGHT[e.sourceType] * e.confidence * fresh;
          contributions.push({ briefTerm: t.term, termKind: t.kind, matchedWord: hit.word, field, evidenceId: e.id, ...(hit.aliasId ? { aliasId: hit.aliasId } : {}), lowSignal: low, confidence: e.confidence, freshness: fresh, points: round(points), counted: false });
        }
      }
    }
    if (!contributions.length) continue;

    // Count only the strongest contribution per brief term.
    const best = new Map<string, Contribution>();
    for (const k of contributions) {
      const prior = best.get(k.briefTerm);
      if (!prior || k.points > prior.points || (k.points === prior.points && k.evidenceId < prior.evidenceId)) best.set(k.briefTerm, k);
    }
    for (const k of best.values()) k.counted = true;
    const evidenceScore = [...best.values()].reduce((sum, k) => sum + k.points, 0) / totalWeight;
    const score = round(evidenceScore + RELATIONSHIP_BONUS[c.relationshipState]);

    const explicit = terms.filter((t) => t.kind === "explicit");
    const strongTerms = [...best.values()].filter((k) => k.termKind === "explicit" && !k.lowSignal);
    const coverage = explicit.length ? strongTerms.length / explicit.length : 0;
    // Weak: no specific (non-generic) explicit topic is evidenced. Strong: at least half of them are,
    // with enough weight behind them. Low confidence lowers the score; it does not relabel the match.
    const strength: Scored["strength"] = strongTerms.length === 0 ? "weak" : coverage >= 0.5 && evidenceScore >= 0.35 ? "strong" : "moderate";

    // One reason per evidence record that counted, citing it and naming the terms and factors.
    const reasons: Reason[] = [];
    const byEvidence = new Map<string, Contribution[]>();
    for (const k of best.values()) byEvidence.set(k.evidenceId, [...(byEvidence.get(k.evidenceId) ?? []), k]);
    for (const [evidenceId, ks] of byEvidence) {
      const e = c.evidence.find((x) => x.id === evidenceId)!;
      const parts = ks.map((k) => `${k.briefTerm}${k.matchedWord !== k.briefTerm ? ` (as “${k.matchedWord}”${k.aliasId ? ", your alias" : ""})` : ""}${k.lowSignal ? " — generic" : ""}`);
      const age = e.capturedAt && freshness(e.capturedAt, now) < 1 ? ", older evidence" : "";
      reasons.push({ text: `${SOURCE_LABEL[e.sourceType]}: “${truncate(e.claim, 160)}” — matches ${parts.join(", ")} (confidence ${Math.round(e.confidence * 100)}%${age})`, evidenceIds: [evidenceId], kind: "evidence" });
    }
    if (c.relationshipEventId && c.relationshipState !== "unknown" && c.relationshipState !== "observed") {
      const text =
        c.relationshipState === "introducible" ? "They opted in to receive introduction requests on these topics." : c.relationshipState === "introduced" || c.relationshipState === "active" ? "You have already been introduced." : `You recorded that you are ${c.relationshipState === "known" ? "acquainted with" : "connected to"} them.`;
      reasons.push({ text, evidenceIds: [], kind: "relationship", relationshipEventIds: [c.relationshipEventId] });
    }

    const unknowns: string[] = [];
    const missing = explicit.filter((t) => !best.has(t.term)).map((t) => t.term);
    if (missing.length) unknowns.push(`No evidence for: ${missing.join(", ")}.`);
    if (strength === "weak") unknowns.push(`Weak match: only generic or incidental terms matched (${[...best.values()].map((k) => k.briefTerm).join(", ")}).`);
    if (c.relationshipState === "unknown" || c.relationshipState === "observed") unknowns.push("No relationship evidence: this is a discovery, not a connection. Do not imply you know them.");
    if (c.relationshipState !== "introducible") unknowns.push("Whether they are willing to help is unknown.");
    if (brief.geography && !c.evidence.some((e) => e.claim.toLowerCase().includes(brief.geography!.toLowerCase()))) unknowns.push(`Location (${brief.geography}) is not evidenced.`);
    for (const id of new Set([...best.values()].filter((k) => k.freshness < 1).map((k) => k.evidenceId))) {
      const e = c.evidence.find((x) => x.id === id)!;
      unknowns.push(`Evidence ${id} is ${now - e.capturedAt > STALE_AFTER_MS ? "more than a year" : "more than six months"} old and may be out of date.`);
    }

    out.push({ personId: c.personId, score, strength, contributions, reasons, unknowns, relationshipState: c.relationshipState });
  }
  return out.sort((a, b) => b.score - a.score || (a.personId < b.personId ? -1 : 1));
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
