# Boundry Connector

A personal relationship and opportunity agent. You describe an outcome ("find someone who can
evaluate a FeltKit project on durable databases"); the app turns it into a confirmed brief, finds
people in your own graph and in an opt-in network who have **evidence** for it, and runs a
**double-opt-in introduction** that discloses nothing until both sides agree. Every outbound
message is sent only after a person approves its exact content, and is called delivered only on
evidence.

The product is the durable state — people, evidence, relationship states, briefs, matches,
approvals, deliveries, consent, introductions and the audit trail — stored in one FeltDB instance.
The screens are review surfaces over that state. No model is required for any of it to work.

Built with [FeltKit](https://www.npmjs.com/package/@feltdb/feltkit) 0.3.18 (`npm create feltkit@latest`).

## Run it

```bash
npm install
```

```bash
npm run dev
```

Open <http://localhost:3000>. Development identities are in the header's switcher: **Ada**
(member, admin, `external_sender`), **Linus** and **Grace** (members). State lives in
`.feltkit/development/` (git-ignored); delete it to start over.

```bash
npm test
```

runs 43 tests, each against its own FeltDB instance (`tests/delivery.test.ts` also serves the app
over HTTP and calls AppPort exactly as a client does).

### Walkthrough

1. As **Linus**: *Profile* → name, e-mail, expertise "databases", tick **Open to introduction
   requests**, topics "durable databases, feltkit" → Save.
2. As **Ada**: *Profile* → name, headline, e-mail → Save. Under **Equivalent terms**, declare e.g.
   `databases` = `postgres`. *People* → **Import contacts** → paste a CSV
   (`name,email,organization,title,notes,topics`).
3. *Ask* → describe the outcome → **Interpret request** → inspect/edit → **Confirm and find matches**.
   Each candidate shows its strength (strong / moderate / weak), the reasons with the evidence each
   cites, what is *not* known, and **How the score was computed** (every term, field, alias,
   confidence, freshness and points).
4. **Draft introduction request** (Linus) → review exactly what he will see → choose the channel
   (*In the app*) → **Approve and send request**. The status goes **Queued** → **Sent** when the
   dispatcher delivers it; until then Linus sees nothing.
5. As **Linus**: *Requests* → **Accept**, choosing what to share. Both sides now see only what the
   other chose.
6. For someone who is not a member (Barbara): **Draft outreach** → choose *Send it myself* (always
   available) or *External provider* (see below) → **Approve this exact text**.
7. *Delivery* shows which channels you can use, whether the external provider is configured and
   reachable, and your delivery counts. *Privacy & audit* has sources, export, deletion and the
   audit trail, including every delivery outcome.

## The introduction and delivery workflow

```
draft ──approve(content hash, channel)──▶ approved ──▶ consent_requested ──▶ introduced ──▶ completed
                                            │  in_app: job "deliveries.dispatch"   (declined / expired / withdrawn)
                                            ├──▶ external_sent ──▶ completed      external: delivery.send (FeltKit integration)
                                            └──▶ manual_ready ──▶ manual_sent ──▶ completed   manual: you send it
```

**Approval** (`introductions:approve`) is a person's decision about one exact content for one
channel. The review screen shows a SHA-256 hash over the shared context, the message, the fields
the requester will disclose, the channel and the recipient (`user:<id>`, `email:<address>` or
`person:<id>`). Approval is refused if anything changed since that hash was shown. The approval
record keeps the content, recipient, channel, approver and an expiry (24 h). Only one approval is
in force; a new one supersedes the old.

**Delivery** records one attempt per approval, with an idempotency key, and its state is set only
from evidence:

| Status shown | Meaning | Decided by |
|---|---|---|
| `draft` | Being written | — |
| `approved` | Approved for the external provider; nothing sent yet | the person |
| `queued` | In-app: waiting for the dispatcher. External: prepared, no provider answer yet | the app |
| `sent` | In-app: the request became visible to the recipient in the same commit. External: the provider confirmed (response or verification). Manual: you recorded sending it | commit / FeltKit call record / person |
| `failed` | Not delivered; the reason says why (approval expired, recipient or content changed, provider refused, not configured, withdrawn first). A new approval is needed to try again | the app or the call record |
| `unknown` | The provider gave no definite answer; it may have been delivered. **Never resent**; settled only by verification | FeltKit call record |
| `manual_action_required` | Approved for manual sending; you must send it | the person |
| `declined`, `withdrawn`, `expired` | The request ended | recipient / owner / deadline |

**In-app delivery** (members): approval queues a delivery and an after-commit job
(`deliveries.dispatch`). The dispatcher re-checks the approval (not expired, not superseded or
used, same content hash, same recipient, still approved), then in one transaction records the
requester's consent grant, makes the request visible, and marks the delivery `sent`. The
notification is an after-commit effect with the delivery's idempotency key. Re-running the job or
re-approving the same content does nothing twice.

**External delivery** (non-members, optional): see the next section. **Manual delivery** is always
available: the app never claims it delivered something it did not.

### Optional external provider

`feltkit/app.ts` declares the integration `delivery` through FeltKit's integration contract. It is
provider-neutral: any HTTP service implementing these routes can deliver approved outreach (for
example an adapter in front of your e-mail or messaging API). **No provider ships with this app.**

| Route | Purpose | FeltKit declaration |
|---|---|---|
| `POST /messages` `{deliveryId, to, subject, body}` with `Idempotency-Key` → `{id, status: "accepted"}` | Send one approved message | `delivery.send`, consequential, idempotent, verifiable, `onOutcome: deliveries:onExternalOutcome` |
| `GET /messages/{deliveryId}` → `{id, status}` or 404 | The provider's record, used only to verify an unknown outcome | `delivery.status`, observation |
| `GET /health` → `{ok: true}` | Readiness | `delivery.health`, observation |

**Configure** (never in code or FeltDB):

- `DELIVERY_PROVIDER_URL`: the provider's base URL (HTTPS in production).
- The credential `credential-ref:delivery`: `FELTKIT_CREDENTIAL_DELIVERY`, or Studio →
  Integrations → Set key, or `npx feltkit credential set credential-ref:delivery`. FeltKit sends it
  as `Authorization: Bearer …`; it never reaches the app's data, logs or audit.
- Authority: the `external_sender` role (`delivery.send`). Members do not have it; an operator
  grants it (Ada has it in development).
- Browser sends: FeltKit accepts only explicit bearer credentials on `POST /appport`, never the
  session cookie. Build the frontend with `VITE_FELTKIT_SESSION=bearer` to send from the browser.
  This keeps the session token in `localStorage`, readable by any script on the page, so opt in only
  where you need it. The default cookie session cannot probe or send externally, and the Delivery
  screen says so.

**Behavior**:

1. Approve for *External provider* → `approved` (nothing sent).
2. **Send through provider** → `deliveries:prepareExternal` re-checks the approval and returns the
   exact approved payload and idempotency key → the browser calls `delivery.send` → FeltKit records
   the call before sending and runs `deliveries:onExternalOutcome` with the call record.
3. `succeeded` → `sent`; `failed` (4xx) → `failed` with the provider's status; `unknown` (timeout,
   5xx, dropped connection) → `unknown`. A replay of the same key is refused by FeltKit
   (`IDEMPOTENCY_OUTCOME_UNKNOWN`); the app also refuses a new approval of different content, a new
   send, a withdrawal, or a client claim of "not sent" while the outcome is unknown.
4. An unknown outcome is settled by FeltKit verification (`GET /messages/{deliveryId}`): an
   operator runs it from Studio → Integrations; it never re-sends. The same `onOutcome` hook then
   records the result.
5. Refusals before anything leaves (`NOT_CONFIGURED`, `FORBIDDEN`, …) are reported by the client
   through `deliveries:recordNotSent`. Only those codes are accepted, and never once FeltKit has a
   call record.

**Known weakness (FeltKit 0.3.18):** `feltkit({ authorize })` is not consulted for integration
capabilities (verified: a call whose body differed from the approval was sent). The app therefore
cannot refuse a tampered `delivery.send` before it leaves. Its mitigations:

- only `external_sender` holders can call it;
- the app hands them the exact approved payload;
- `onExternalOutcome` compares what was sent with the approval, marks a difference
  `contentMismatch`, and writes the audit event `delivery.content_mismatch`;
- a send the app never prepared is audited as `delivery.untracked_send`.

## Matching

Deterministic and pure (`feltkit/_match.ts`, tested in `tests/matching.test.ts`). A candidate's
score is the sum of **contributions**: one brief term found in one field of one evidence record:

```
points = termWeight × fieldWeight × signal × alias × sourceWeight × confidence × freshness
```

| Factor | Values |
|---|---|
| termWeight | explicit brief topics 1.0; other content words of "looking for" 0.4 |
| fieldWeight | capability terms (what the person offers) 1.0; claim text 0.6; stated needs 0.8 (customer, design-partner and collaborator searches only, and only if the participant made needs visible) |
| signal | 0.3 for low-signal words ("systems", "software", "platform", …); stop words never match |
| alias | 0.9 when matched only through a user-declared equivalent term |
| sourceWeight | interaction 1.0, participant statement 0.9, your note 0.85, public URL 0.7, contact import 0.6 |
| freshness | 1 up to 180 days, 0.75 up to a year, 0.4 after (and listed as an unknown) |

Only the strongest contribution per term counts.

```
score = Σ counted points ÷ total term weight + relationship bonus
```

**Strength:**
- *weak*: no specific (non-generic) explicit topic is evidenced. Weak matches are shown, labelled, never hidden.
- *strong*: at least half of the explicit topics are evidenced, with enough weight behind them.
- *moderate*: everything in between.

Every contribution and every reason cites an evidence id; a relationship reason cites the
relationship event that established the state. Nothing is inferred. "Postgres" matches "databases"
only if you declare it under **Equivalent terms**. Stems are a small deterministic rule, not a
language model.

## How it is built

| Path | Responsibility |
|---|---|
| `feltkit/app.ts` | Roles, collections, vocabulary, the `delivery` integration |
| `feltkit/_match.ts` | Matching (pure) |
| `feltkit/_delivery.ts` | Delivery policy (pure): content hash, approval checks, channel options, outcome mapping, display status |
| `feltkit/_rules.ts` | Relationship transitions, introduction state machine, outbound disclosure scan (pure) |
| `feltkit/_intent.ts` | Brief interpreter `rules@1` (deterministic; replaceable) |
| `feltkit/_access.ts`, `_flow.ts` | Ownership scoping, read-time evidence access, audit, relationship and introduction transitions |
| `feltkit/introductions.ts` | Draft, approve, manual send, withdraw, respond, consent, follow-up |
| `feltkit/deliveries.ts` | In-app dispatch, external prepare, `onOutcome` reconciliation, readiness |
| `feltkit/aliases.ts`, `people.ts`, `sources.ts`, `briefs.ts`, `matches.ts`, `profile.ts`, `privacy.ts` | Equivalent terms, people and evidence, sources, briefs and matching, decisions, profile, export/deletion/audit |
| `src/` | `Connector.tsx` (ask, people, requests, profile, privacy), `Delivery.tsx` (introductions, delivery readiness), `ui.tsx` |
| `tests/` | `rules`, `matching` (pure); `workflow`, `delivery`, `isolation` (end to end). `_provider.ts` is a **test double** of the provider contract used only by tests |

### Rules the code enforces (and tests prove)

- **Evidence or nothing.** Every match reason cites evidence; every score point traces to an
  evidence record; unknowns are listed.
- **Discovery is not a relationship.** Only the owner, as a person, attests *known*/*connected*;
  *introducible* comes from the participant's opt-in; *introduced* only from a completed double opt-in.
- **Access is checked at read time.** Revoked sources, retractions and corrections take effect at
  once; originals stay for export.
- **People approve exact content.** Approval binds content, recipient, channel and an expiry; it is
  refused on any change, re-checked at delivery, and checked against recipient blocks, a daily limit
  (10), confidential-brief exclusions and the outbound disclosure scan.
- **Agents advise; people decide.** The `agent` role can read, draft briefs and run matching. It
  cannot approve, dispatch, send, answer or attest. Approval and send mutations are
  `approval: "required"` and also refuse any non-person caller in code.
- **Double opt-in.** Contact fields are read only through two live consent grants. The recipient
  sees a request only once it is delivered.
- **Idempotent, audited side effects.** Each delivery has a unique key; duplicates are no-ops; every
  delivery state change and provider outcome (status, code, how determined) is an audit event. Audit
  events hold ids, action names and outcome codes, never message bodies, addresses or credentials.
- **Career mode** exclusions apply to matching, discovery, drafting and every channel.
- **Isolation.** Every owned record carries `ownerId`; one helper answers `NOT_FOUND` for anything else.

## FeltKit capabilities used

| Capability | Used for |
|---|---|
| Collections, schema enforcement, unique constraints, atomic mutations with conflict checks, `ctx.db.sequence` | All durable state; ordered audit, relationship and introduction events |
| Roles and `access`; `approval: "required"` | Authority: `member`, `agent`, `external_sender`; human-only approval and sending |
| `ctx.afterCommit.jobs.enqueue` + job handlers | In-app dispatch after the approval commits, with retries |
| `ctx.afterCommit.notifications.send` with idempotency keys | Notifying recipients only if the delivery committed |
| `app.integration` (consequential, `idempotencyHeader`, `verify`, `onOutcome`, `health`, credential reference) | Optional external delivery with call records, no blind retries, verification, and FeltKit-held credentials |
| AppPort `POST /appport` | Calling the integration from a bearer client (browser in bearer mode, tests) |
| Credential custody (`FELTKIT_CREDENTIAL_*`, vault) | The provider key, never in app data |
| `createTestApp`, `runServices`, `startServer`, `runtime.integrations.verify` | Tests against real FeltDB, the job worker, real HTTP and real verification |

## Not available, or not built (explicit gaps, not mocked)

- **Pre-send content binding for external sends.** FeltKit 0.3.18 does not run `feltkit({ authorize })`
  for integration capabilities, so a sender with `delivery.send` could send content that differs
  from the approval; the app detects and audits it afterwards (see above). Upstream ask: consult the
  authorize hook (or an input check) for integration capabilities.
- **Browser sends need bearer sessions.** FeltKit refuses cookie sessions on `/appport`; the
  default (safer) cookie session cannot probe or use the external provider.
- **External delivery data in FeltKit's call records.** FeltKit stores each integration call's input
  (recipient address and message body) in `_feltkit_integration_calls`. That is platform evidence the
  app cannot delete, so "delete my data" does not remove it.
- **An unconfigured optional provider fails readiness.** FeltKit has no way to mark an integration
  optional, so `feltkit readiness` reports `delivery` (URL and credential) as failing when you
  deliberately run without a provider. In-app and manual delivery are unaffected.
- **Unknown outcomes are settled by operators.** Verification is an operator action (Studio →
  Integrations); members have no API for it in FeltKit 0.3.18.
- **No model-backed interpretation or drafting.** FeltKit's model path chooses among app-built
  options (`ctx.agent.start({ decision })`); there is no structured-extraction call. The brief
  interpreter and drafts stay deterministic (`rules@1`).
- **No provider shipped.** No e-mail, contacts or calendar connector exists here; the external
  channel works only with a provider you run behind the documented contract.
- **Matching** is lexical: stems plus declared aliases. No synonyms, no phrases beyond declared
  aliases, no semantic similarity.
- **Privacy is enforced in application code** (`ownerId` scoping), not by database-level tenancy.
- **Not built:** scheduling/calendar, standing approval policies, delegated authority beyond roles,
  consent-spam detection, abuse review, time-based retention.
- **Not portable to AppBoundry:** approval gates and integrations need FeltKit's runtime
  (`npm run build` lists them).

## Deploying

`npm run deploy` builds a verified container artifact; see `npx feltkit docs path-to-production`.
Production has no dev identities: people create accounts (`auth.accounts` in `feltkit/app.ts`).
Set `DELIVERY_PROVIDER_URL` and `FELTKIT_CREDENTIAL_DELIVERY` only if you run a provider, and grant
`external_sender` only to people who should send externally. `npx feltkit readiness --env production`
reports the integration's configuration.
