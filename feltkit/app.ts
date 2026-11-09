/**
 * Boundry Connector: a personal relationship and opportunity agent.
 *
 * Everything here is stored in one FeltDB instance per environment. Records owned by a principal
 * carry `ownerId`; every function reads and writes through the helpers in `_access.ts`, which scope
 * by that field. The durable product is these collections — people, evidence, relationships,
 * briefs, matches, introductions, consent and audit — not any model output.
 */
import { feltkit, s } from "@feltdb/feltkit";

export const app = feltkit({
  name: "boundry-connector",
  description: "Personal relationship and opportunity agent: evidence-backed matches and double-opt-in introductions.",
  roles: {
    // A principal user: their own graph, briefs and introductions, and answering requests sent to them.
    member: ["connector.*", "notifications.*", "feltkit.agent.*"],
    // An agent working for a member may observe and advise; it may never approve a disclosure or
    // send anything (those mutations are `approval: "required"` and not granted here anyway).
    agent: ["connector.read", "connector.advise", "feltkit.agent.*"],
    admin: ["intelligence.*", "credential.*", "configuration.*", "apikeys.*", "webhooks.*", "jobs.*", "schedules.*", "feltkit.operations.*"],
  },
  auth: { accounts: { roles: ["member"] } },
  dev: {
    users: [
      { id: "ada", name: "Ada Lovelace", roles: ["member", "admin"] },
      { id: "linus", name: "Linus Pauling", roles: ["member"] },
      { id: "grace", name: "Grace Hopper", roles: ["member"] },
    ],
  },
  services: {
    notifications: { types: ["introduction.requested", "introduction.accepted", "introduction.declined"] },
    configuration: true,
    apiKeys: { roles: ["member"] },
    jobs: { handlers: { "introductions.expire-due": "introductions:expireDue" } },
    schedules: true,
    intelligence: true,
  },
});

// ---------------------------------------------------------------------------------------------
// Vocabulary (exported so functions, tests and the UI share one definition)

export const RELATIONSHIP_STATES = ["unknown", "observed", "known", "connected", "introducible", "introduced", "active"] as const;
export const EVIDENCE_SOURCE_TYPES = ["user_attested", "contact_import", "public_url", "participant_statement", "interaction"] as const;
export const SOURCE_KINDS = ["manual", "contacts_import", "public_url", "network"] as const;
export const OPPORTUNITY_TYPES = ["expert", "design_partner", "investor", "customer", "collaborator", "hire", "job", "other"] as const;
export const INTRO_STATES = ["draft", "consent_requested", "introduced", "completed", "declined", "withdrawn", "expired", "manual_ready", "manual_sent"] as const;
export const SHAREABLE_FIELDS = ["email", "headline"] as const;

// ---------------------------------------------------------------------------------------------
// Profile: what a person says about themselves. A participant's profile is what makes them
// discoverable to other members' briefs — only when `openToIntroductions` is true.

export const profiles = app.collection(
  "profiles",
  {
    ownerId: s.string(),
    displayName: s.string({ minLength: 1, maxLength: 120 }),
    headline: s.string({ maxLength: 200 }),
    email: s.optional(s.string({ maxLength: 200 })), // private; disclosed only through a consent grant
    projects: s.array(s.string({ maxLength: 200 }), { maxItems: 20 }),
    expertise: s.array(s.string({ maxLength: 80 }), { maxItems: 40 }),
    needs: s.array(s.string({ maxLength: 200 }), { maxItems: 20 }),
    boundaries: s.string({ maxLength: 1000 }),
    openToIntroductions: s.boolean(),
    introTopics: s.array(s.string({ maxLength: 80 }), { maxItems: 40 }),
    updatedAt: s.number(),
  },
  { unique: [["ownerId"]] },
);

// ConnectorAccount: every place evidence came from. Revoking one hides its evidence at read time.
export const sources = app.collection(
  "sources",
  {
    ownerId: s.string(),
    kind: s.enum(SOURCE_KINDS),
    label: s.string({ maxLength: 200 }),
    status: s.enum(["active", "revoked"] as const),
    createdAt: s.number(),
    revokedAt: s.optional(s.number()),
  },
  { indexes: [{ fields: ["ownerId"] }] },
);

export const people = app.collection(
  "people",
  {
    ownerId: s.string(),
    name: s.string({ minLength: 1, maxLength: 160 }),
    email: s.optional(s.string({ maxLength: 200 })), // private contact data: never in a match, draft or request
    organization: s.optional(s.string({ maxLength: 160 })),
    title: s.optional(s.string({ maxLength: 160 })),
    linkedUserId: s.optional(s.string()), // set when this person is a participating member
    sourceIds: s.array(s.string()),
    createdAt: s.number(),
  },
  { indexes: [{ fields: ["ownerId"] }] },
);

// Evidence is immutable. A correction is a new record with `supersedes`; nothing is edited in place.
export const evidence = app.collection(
  "evidence",
  {
    ownerId: s.string(),
    personId: s.string(),
    sourceId: s.string(),
    sourceType: s.enum(EVIDENCE_SOURCE_TYPES),
    sourceRef: s.string({ maxLength: 500 }), // URL, file name, "profile:<user>@<updatedAt>", introduction id
    claim: s.string({ minLength: 1, maxLength: 2000 }), // stored as data, never interpreted as instructions
    topics: s.array(s.string({ maxLength: 80 }), { maxItems: 40 }),
    confidence: s.number({ minimum: 0, maximum: 1 }),
    scope: s.enum(["private", "shareable"] as const),
    capturedAt: s.number(),
    supersedes: s.optional(s.string()),
    retracted: s.boolean(), // true only on a record whose purpose is to retract `supersedes`
  },
  { indexes: [{ fields: ["ownerId"] }, { fields: ["personId"] }] },
);

// The current state of an owner→person edge. The authoritative history is relationshipEvents.
export const relationships = app.collection(
  "relationships",
  {
    ownerId: s.string(),
    personId: s.string(),
    state: s.enum(RELATIONSHIP_STATES),
    updatedAt: s.number(),
  },
  { unique: [["ownerId", "personId"]] },
);

export const relationshipEvents = app.collection(
  "relationshipEvents",
  {
    ownerId: s.string(),
    personId: s.string(),
    from: s.enum(RELATIONSHIP_STATES),
    to: s.enum(RELATIONSHIP_STATES),
    actorId: s.string(),
    actorType: s.string(),
    cause: s.string({ maxLength: 80 }), // the rule that allowed it, e.g. "user.attest", "introduction.introduced"
    evidenceIds: s.array(s.string()),
    seq: s.number(),
    at: s.number(),
  },
  { indexes: [{ fields: ["ownerId", "personId"] }] },
);

export const briefs = app.collection(
  "briefs",
  {
    ownerId: s.string(),
    text: s.string({ minLength: 1, maxLength: 4000 }),
    opportunityType: s.enum(OPPORTUNITY_TYPES),
    target: s.string({ maxLength: 300 }),
    topics: s.array(s.string({ maxLength: 80 }), { maxItems: 30 }),
    geography: s.optional(s.string({ maxLength: 120 })),
    timing: s.optional(s.string({ maxLength: 120 })),
    successCondition: s.optional(s.string({ maxLength: 400 })),
    confidential: s.boolean(),
    excludedOrganizations: s.array(s.string({ maxLength: 160 }), { maxItems: 30 }),
    excludedPersonIds: s.array(s.string(), { maxItems: 200 }),
    questions: s.array(s.string({ maxLength: 300 })),
    interpretedBy: s.string(), // e.g. "rules@1": which interpreter produced the fields
    status: s.enum(["draft", "confirmed", "archived"] as const),
    createdAt: s.number(),
    confirmedAt: s.optional(s.number()),
    matchedAt: s.optional(s.number()),
  },
  { indexes: [{ fields: ["ownerId"] }] },
);

const MatchReason = s.object({
  text: s.string(),
  evidenceIds: s.array(s.string()),
  kind: s.enum(["evidence", "relationship", "inference"] as const),
});

export const matches = app.collection(
  "matches",
  {
    ownerId: s.string(),
    briefId: s.string(),
    personId: s.string(),
    score: s.number(),
    reasons: s.array(MatchReason),
    unknowns: s.array(s.string()),
    relationshipState: s.enum(RELATIONSHIP_STATES),
    decision: s.enum(["pending", "accepted", "rejected", "deferred"] as const),
    decisionNote: s.optional(s.string({ maxLength: 1000 })),
    createdAt: s.number(),
    decidedAt: s.optional(s.number()),
  },
  { unique: [["briefId", "personId"]], indexes: [{ fields: ["ownerId"] }] },
);

export const introductions = app.collection(
  "introductions",
  {
    ownerId: s.string(), // the requester
    briefId: s.string(),
    matchId: s.string(),
    personId: s.string(),
    recipientUserId: s.optional(s.string()), // participant path: answered in-app by this user
    path: s.enum(["participant", "manual"] as const),
    state: s.enum(INTRO_STATES),
    sharedContext: s.string({ maxLength: 2000 }), // exactly what the recipient sees
    requesterFields: s.array(s.enum(SHAREABLE_FIELDS)), // what the requester agrees to disclose on acceptance
    message: s.string({ maxLength: 4000 }),
    idempotencyKey: s.string(),
    requestedAt: s.optional(s.number()),
    expiresAt: s.optional(s.number()),
    followUpAt: s.optional(s.number()),
    outcomeNote: s.optional(s.string({ maxLength: 4000 })), // private to the requester
    createdAt: s.number(),
    updatedAt: s.number(),
  },
  { unique: [["idempotencyKey"]], indexes: [{ fields: ["ownerId"] }, { fields: ["recipientUserId"] }] },
);

export const introductionEvents = app.collection(
  "introductionEvents",
  {
    introductionId: s.string(),
    from: s.enum(INTRO_STATES),
    to: s.enum(INTRO_STATES),
    actorId: s.string(),
    seq: s.number(),
    at: s.number(),
  },
  { indexes: [{ fields: ["introductionId"] }] },
);

export const consentGrants = app.collection(
  "consentGrants",
  {
    grantorId: s.string(),
    granteeId: s.string(),
    introductionId: s.string(),
    purpose: s.string({ maxLength: 300 }),
    fields: s.array(s.enum(SHAREABLE_FIELDS)),
    channel: s.literal("in_app"),
    expiresAt: s.number(),
    revokedAt: s.optional(s.number()),
    createdAt: s.number(),
  },
  { indexes: [{ fields: ["introductionId"] }, { fields: ["grantorId"] }] },
);

// A recipient can refuse all future requests from a requester.
export const blocks = app.collection("blocks", { blockerId: s.string(), blockedId: s.string(), createdAt: s.number() }, { unique: [["blockerId", "blockedId"]] });

// Append-only. Holds ids and action names, never message bodies or contact details, so it can be
// retained after a deletion request.
export const auditEvents = app.collection(
  "auditEvents",
  {
    ownerId: s.string(),
    actorId: s.string(),
    actorType: s.string(),
    action: s.string({ maxLength: 80 }),
    subjectType: s.string({ maxLength: 40 }),
    subjectId: s.string(),
    detail: s.optional(s.record(s.union([s.string(), s.number(), s.boolean()]))),
    seq: s.number(),
    at: s.number(),
  },
  { indexes: [{ fields: ["ownerId"] }] },
);
