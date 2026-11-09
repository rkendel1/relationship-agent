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
    // delivery.read: probe whether the external delivery provider is configured (readiness).
    member: ["connector.*", "notifications.*", "feltkit.agent.*", "delivery.read"],
    // Explicit authority to send through the external delivery provider (the `delivery`
    // integration). Not part of member: an operator grants it to the people who may use it.
    external_sender: ["delivery.send", "delivery.read"],
    // An agent working for a member may observe and advise; it may never approve a disclosure or
    // send anything (those mutations are `approval: "required"` and not granted here anyway).
    agent: ["connector.read", "connector.advise", "feltkit.agent.*"],
    admin: ["intelligence.*", "credential.*", "configuration.*", "apikeys.*", "webhooks.*", "jobs.*", "schedules.*", "feltkit.operations.*"],
  },
  auth: { accounts: { roles: ["member"] } },
  dev: {
    users: [
      { id: "ada", name: "Ada Lovelace", roles: ["member", "admin", "external_sender"] },
      { id: "linus", name: "Linus Pauling", roles: ["member"] },
      { id: "grace", name: "Grace Hopper", roles: ["member"] },
    ],
  },
  services: {
    notifications: { types: ["introduction.requested", "introduction.accepted", "introduction.declined"] },
    // Configuration and credentials for the external provider live in FeltKit's custody, never here.
    configuration: true,
    apiKeys: { roles: ["member"] },
    jobs: { handlers: { "introductions.expire-due": "introductions:expireDue", "deliveries.dispatch": "deliveries:dispatch" } },
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
export const INTRO_STATES = ["draft", "approved", "consent_requested", "introduced", "completed", "declined", "withdrawn", "expired", "manual_ready", "manual_sent", "external_sent"] as const;
export const DELIVERY_CHANNELS = ["in_app", "external", "manual"] as const;
export const DELIVERY_STATES = ["queued", "sent", "failed", "unknown", "manual_action_required"] as const;
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
    // Whether other members' briefs may match against `needs` (e.g. a design partner search). Off by default.
    needsVisible: s.optional(s.boolean()),
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
    topics: s.array(s.string({ maxLength: 80 }), { maxItems: 40 }), // capability terms: what the person offers or knows
    needTopics: s.optional(s.array(s.string({ maxLength: 80 }), { maxItems: 40 })), // what the person says they seek
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
  // A relationship reason cites the append-only event that established the state.
  relationshipEventIds: s.optional(s.array(s.string())),
});

// One scored term: which brief term, which evidence field, through which alias, and every factor
// that produced its points. The score is the sum of the counted contributions (see _match.ts).
const MatchContribution = s.object({
  briefTerm: s.string(),
  termKind: s.enum(["explicit", "context"] as const),
  matchedWord: s.string(),
  field: s.enum(["capability", "claim", "need"] as const),
  evidenceId: s.string(),
  aliasId: s.optional(s.string()),
  lowSignal: s.boolean(),
  confidence: s.number(),
  freshness: s.number(),
  points: s.number(),
  counted: s.boolean(),
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
    strength: s.optional(s.enum(["strong", "moderate", "weak"] as const)),
    contributions: s.optional(s.array(MatchContribution)),
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
    channel: s.optional(s.enum(DELIVERY_CHANNELS)), // chosen at approval
    approvalId: s.optional(s.string()), // the approval currently in force
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

// A person's approval of one exact introduction: the reviewed content, the recipient, the channel,
// a hash over all of them, and an expiry. Immutable apart from being consumed (used for a
// delivery) or superseded (a newer approval replaced it).
export const approvals = app.collection(
  "approvals",
  {
    ownerId: s.string(),
    introductionId: s.string(),
    approverId: s.string(),
    approverType: s.string(),
    channel: s.enum(DELIVERY_CHANNELS),
    recipient: s.string({ maxLength: 300 }), // "user:<id>" or "email:<address>" or "person:<id>"
    sharedContext: s.string({ maxLength: 2000 }),
    message: s.string({ maxLength: 4000 }),
    requesterFields: s.array(s.enum(SHAREABLE_FIELDS)),
    contentHash: s.string(),
    approvedAt: s.number(),
    expiresAt: s.number(),
    consumedAt: s.optional(s.number()),
    supersededAt: s.optional(s.number()),
  },
  { indexes: [{ fields: ["ownerId"] }, { fields: ["introductionId"] }] },
);

// One attempt to deliver an approved introduction through one channel. Its state is set only from
// evidence: the commit that made an in-app request visible, or FeltKit's integration call record.
export const deliveries = app.collection(
  "deliveries",
  {
    ownerId: s.string(),
    introductionId: s.string(),
    approvalId: s.string(),
    channel: s.enum(DELIVERY_CHANNELS),
    provider: s.string(), // "in_app" | "integration:delivery" | "manual"
    state: s.enum(DELIVERY_STATES),
    idempotencyKey: s.string(),
    reason: s.optional(s.string({ maxLength: 500 })), // why it was not delivered, or what to do next
    providerCallId: s.optional(s.string()),
    providerStatus: s.optional(s.number()),
    providerCode: s.optional(s.string()),
    providerMessageId: s.optional(s.string()),
    determinedBy: s.optional(s.string()), // "commit" | "response" | "verification" | "person" | "refusal"
    contentMismatch: s.optional(s.boolean()),
    createdAt: s.number(),
    updatedAt: s.number(),
  },
  { unique: [["idempotencyKey"]], indexes: [{ fields: ["ownerId"] }, { fields: ["introductionId"] }] },
);

// User-declared equivalent terms ("postgres" ≡ "databases"). Matching uses only what is declared here.
export const aliases = app.collection(
  "aliases",
  {
    ownerId: s.string(),
    term: s.string({ minLength: 1, maxLength: 80 }),
    equivalents: s.array(s.string({ minLength: 1, maxLength: 80 }), { minItems: 1, maxItems: 20 }),
    createdAt: s.number(),
  },
  { unique: [["ownerId", "term"]] },
);

// ---------------------------------------------------------------------------------------------
// Optional external delivery provider, through FeltKit's integration contract.
//
// Provider-neutral: any HTTP service that implements these three routes can deliver approved
// outreach (an adapter in front of an e-mail or messaging API). Nothing is sent unless
// DELIVERY_PROVIDER_URL and the credential `credential-ref:delivery` are configured; until then
// every call answers NOT_CONFIGURED and the app offers the manual path.
export const delivery = app.integration("delivery", {
  description: "Delivers approved outreach to people who are not members. Optional.",
  baseUrl: { env: "DELIVERY_PROVIDER_URL" },
  credential: "credential-ref:delivery",
  timeoutMs: 10_000,
  health: { path: "/health" },
  operations: {
    send: {
      method: "POST",
      path: "/messages",
      description: "Send one approved message. Deduplicated by Idempotency-Key.",
      input: { deliveryId: s.string(), to: s.string({ maxLength: 200 }), subject: s.string({ maxLength: 200 }), body: s.string({ maxLength: 4000 }) },
      output: s.object({ id: s.string(), status: s.string() }, { additionalProperties: true }),
      effect: "consequential",
      access: "delivery.send",
      idempotencyHeader: "Idempotency-Key",
      verify: { operation: "status", input: { deliveryId: { $input: "/deliveryId" } }, expect: [{ at: "/status", equals: "accepted" }] },
      effects: ["message.sent"],
      onOutcome: "deliveries:onExternalOutcome",
    },
    status: {
      method: "GET",
      path: "/messages/{deliveryId}",
      description: "The provider's record of one delivery (used only to verify an unknown outcome).",
      input: { deliveryId: s.string() },
      output: s.object({ id: s.string(), status: s.string() }, { additionalProperties: true }),
      effect: "observation",
      access: "delivery.send",
    },
    health: {
      method: "GET",
      path: "/health",
      description: "Whether the provider is configured and reachable.",
      output: s.object({ ok: s.boolean() }, { additionalProperties: true }),
      effect: "observation",
      access: "delivery.read",
    },
  },
});
