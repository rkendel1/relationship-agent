/**
 * The brief interpreter. Deterministic rules (`rules@1`): the same text always gives the same brief,
 * and the user confirms or edits it before it is used. A model-backed interpreter can replace this
 * function later without changing the brief's shape or the workflow that consumes it.
 */
import type { OPPORTUNITY_TYPES } from "./app.js";
import { tokens } from "./_text.js";

export const INTERPRETER = "rules@1";

type OpportunityType = (typeof OPPORTUNITY_TYPES)[number];

export interface Interpretation {
  opportunityType: OpportunityType;
  target: string;
  topics: string[];
  geography?: string;
  timing?: string;
  successCondition?: string;
  confidential: boolean;
  excludedOrganizations: string[];
  questions: string[];
}

const TYPE_RULES: Array<[OpportunityType, RegExp]> = [
  ["design_partner", /\bdesign[- ]partners?\b/i],
  ["investor", /\b(investors?|investment|angels?|vcs?|venture|fundrais\w*|raise|raising|seed round|pre-seed)\b/i],
  ["job", /\b(new (job|role|position)|job search|my next (role|job)|career (move|change|opportunit\w*)|open to (new )?roles?|hiring managers? for me)\b/i],
  ["hire", /\b(hire|hiring|recruit\w*|candidates?|join (my|our) team)\b/i],
  ["customer", /\b(customers?|buyers?|pilot|prospects?|sell to|clients?)\b/i],
  ["collaborator", /\b(co-?founders?|collaborat\w*|partner with|build with)\b/i],
  ["expert", /\b(experts?|evaluate|evaluat\w*|review|advice|advis\w*|feedback|mentor|someone who knows|understands?)\b/i],
];

const TYPE_WORDS = /\b(design[- ]partners?|investors?|angels?|vcs?|customers?|buyers?|experts?|candidates?|collaborators?|co-?founders?|mentors?|advisors?)\b/gi;

export function interpretBrief(text: string): Interpretation {
  const clean = text.replace(/\s+/g, " ").trim();
  const opportunityType = TYPE_RULES.find(([, re]) => re.test(clean))?.[0] ?? "other";

  const excludedOrganizations = [
    ...clean.matchAll(/\b(?:not|exclude|excluding|except|avoid|nobody|no one|anyone but)\b(?:\s+(?:anyone|people|someone|folks))?\s+(?:at|from)\s+([A-Z][\w&.-]*(?:\s+[A-Z][\w&.-]*)*)/g),
  ].map((m) => m[1]!.replace(/[.,;]+$/, ""));

  const geography = /\b(?:based in|located in|near|in)\s+((?:[A-Z][a-zA-Z]+)(?:\s+[A-Z][a-zA-Z]+)?)/.exec(stripExclusions(clean))?.[1] ?? (/\bremote\b/i.test(clean) ? "Remote" : undefined);
  const timing = /\b(this week|next week|this month|next month|this quarter|next quarter|asap|by (?:the )?end of \w+|by [A-Z][a-z]+(?: \d{1,2})?|in \d+ (?:days?|weeks?|months?)|within \d+ (?:days?|weeks?|months?))\b/i.exec(clean)?.[1];
  const successCondition = /\b(?:so (?:that )?(?:I|we) can|in order to|goal is to|success (?:is|means|would be))\s+([^.;]+)/i.exec(clean)?.[1]?.trim();

  const confidential = opportunityType === "job" || /\b(confidential|quietly|discreet\w*|privately|don'?t tell|without (?:my|our) (?:employer|company|boss))\b/i.test(clean);

  // Topics: the content words, minus the words that only named the opportunity type, places,
  // organizations to exclude, and timing.
  const excludedWords = new Set([...excludedOrganizations, geography ?? "", timing ?? ""].flatMap((s) => tokens(s)));
  const topics = tokens(clean.replace(TYPE_WORDS, " ")).filter((t) => !excludedWords.has(t) && !GENERIC.has(t)).slice(0, 12);

  const target = targetPhrase(clean);

  const questions: string[] = [];
  if (topics.length === 0) questions.push("What subject, skill, or domain should this person know well?");
  if (opportunityType === "other") questions.push("What kind of connection is this: an expert, design partner, investor, customer, collaborator, hire, or job?");
  if (confidential && excludedOrganizations.length === 0) questions.push("This search is confidential. Which organizations or people must never see it (for example, your current employer)?");
  if ((opportunityType === "hire" || opportunityType === "customer") && !geography) questions.push("Does location matter for this search?");

  return { opportunityType, target, topics, ...(geography ? { geography } : {}), ...(timing ? { timing } : {}), ...(successCondition ? { successCondition } : {}), confidential, excludedOrganizations, questions };
}

const GENERIC = new Set(["evaluate", "evaluating", "evaluation", "review", "reviewing", "advice", "feedback", "project", "projects", "work", "working", "job", "role", "position", "career", "hire", "hiring", "invest", "investment", "fundraising", "raise", "raising", "pilot", "help", "helping", "understand", "understands", "knows", "experience", "experienced", "good", "great", "best", "right", "early", "stage"]);

function stripExclusions(text: string): string {
  return text.replace(/\b(?:not|exclude|excluding|except|avoid)\b[^.;,]*/gi, " ");
}

function targetPhrase(text: string): string {
  const m = /\b(?:find|need|looking for|want|introduce me to|connect me with|who can|someone who)\b\s*(?:me\s+)?(.*?)(?:[.;]|$)/i.exec(text);
  const phrase = (m?.[1] ?? text).trim();
  return phrase.length > 300 ? `${phrase.slice(0, 299)}…` : phrase || text.slice(0, 300);
}
