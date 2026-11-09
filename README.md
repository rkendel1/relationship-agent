# Boundry Connector

A personal relationship and opportunity agent. You describe an outcome ("find someone who can
evaluate a FeltKit project on durable databases"); the app turns it into a confirmed brief, finds
people in your own graph and in an opt-in network who have **evidence** for it, and runs a
**double-opt-in introduction** that discloses nothing until both sides agree.

The product is the durable state — people, evidence, relationship states, briefs, matches,
consent, introductions and the audit trail — stored in one FeltDB instance. The screens are review
surfaces over that state. No model is required for any of it to work.

Built with [FeltKit](https://www.npmjs.com/package/@feltdb/feltkit) 0.3.18 (`npm create feltkit@latest`).

## Run it

```bash
npm install
```

```bash
npm run dev
```

Open <http://localhost:3000>. Three development identities are in the header's switcher:
**Ada** (the requester in the walkthrough below), **Linus** and **Grace** (other members).
State lives in `.feltkit/development/` (git-ignored); delete it to start over.

```bash
npm test
```

runs 21 tests, each against its own FeltDB instance.

### Walkthrough (the first vertical slice)

1. As **Linus**: *Profile* → fill in name, e-mail, expertise "databases", tick **Open to
   introduction requests**, topics "durable databases, feltkit" → Save.
2. As **Ada**: *Profile* → name, headline, e-mail → Save. *People* → **Import contacts** → paste
   a CSV (`name,email,organization,title,notes,topics`) → Import.
3. *Ask* → "Find me someone who can evaluate a Boundry/FeltKit project on durable databases" →
   **Interpret request**. Inspect and edit the interpretation → **Confirm and find matches**.
4. Each candidate shows its relationship state, the reasons with the evidence each cites, and what
   is *not* known. Mark candidates good / later / not right (persisted).
5. **Draft introduction request** on Linus → review exactly what he will see, choose what you
   will share if he accepts → **Approve and send request**.
6. As **Linus**: *Requests* → read it (no e-mail, no evidence, no brief) → choose what to share →
   **Accept**. Both sides now see only what the other chose.
7. As **Ada**: *Introductions* → set a follow-up date → **Record outcome**. Linus is now *Active*
   in your graph, with the outcome as interaction evidence.
8. *Privacy & audit*: revoke a source, download the export, read the audit trail, delete your data.

## How it is built

| Path | Responsibility |
|---|---|
| `feltkit/app.ts` | Roles, collections, vocabulary (relationship states, evidence types, introduction states) |
| `feltkit/_rules.ts` | Pure policy: relationship transitions, introduction state machine, match scoring, outbound disclosure scan |
| `feltkit/_intent.ts` | Brief interpreter `rules@1` (deterministic; replaceable) |
| `feltkit/_access.ts` | Ownership scoping, read-time evidence access, audit, relationship transitions |
| `feltkit/profile.ts`, `people.ts`, `sources.ts` | Profile, people, evidence (immutable; corrections supersede), contact import, sources and revocation |
| `feltkit/briefs.ts`, `matches.ts` | Brief lifecycle, network discovery of opted-in participants, matching, decisions |
| `feltkit/introductions.ts` | Draft → approve → consent request → accept/decline → introduced → completed; withdraw, expire, revoke consent |
| `feltkit/privacy.ts` | Export, deletion, audit log |
| `src/Connector.tsx` | The screens |
| `tests/` | `rules` (pure policy), `workflow` (the slice and its failure paths), `isolation` (cross-member access, export, deletion) |

### Rules the code enforces (and tests prove)

- **Evidence or nothing.** A candidate appears only if at least one evidence record shares a topic
  with the brief; every reason cites evidence ids. Unknowns (missing topics, no relationship,
  unknown willingness, location, stale evidence) are listed, not hidden.
- **Discovery is not a relationship.** Imported or public evidence makes a person *observed*. Only
  the owner, as a person, can attest *known*/*connected* (with a note that becomes evidence).
  *Introducible* comes only from the participant's own opt-in; *introduced* only from a completed
  double opt-in. Every change is an append-only `relationshipEvents` record.
- **Access is checked at read time.** Revoking a source, retracting or correcting a claim removes
  it from people, matching and match explanations immediately; the original stays for export.
- **Nothing leaves without approval of the exact preview.** `approve` takes the draft's version;
  if the text changed after review it is refused. It then checks recipient blocks, a daily request
  limit (10), confidential-brief exclusions, and scans the outbound text for e-mail addresses and
  phone numbers not chosen for disclosure, and for excluded organizations.
- **Double opt-in.** Contact fields are read only through two live consent grants (the requester's,
  created at approval; the recipient's, created on acceptance). Revoking either stops disclosure.
- **Idempotent, audited side effects.** Each introduction has a unique idempotency key; repeated
  approvals/answers are no-ops; notifications carry the key. Every transition writes an
  `introductionEvents` record and an audit event. Audit events hold ids and action names only.
- **Agents advise; people decide.** The `agent` role can read and draft briefs/run matching. It
  cannot attest relationships, approve, send or answer: those mutations are not granted to it and
  are `approval: "required"` (FeltKit refuses them from agents/API keys except as proposals a person
  approves).
- **Career mode.** Confidential briefs (automatic for job searches) exclude people and network
  participants tied to excluded organizations from matching *and* discovery, share only the topic,
  and refuse outbound text that mentions an excluded organization.
- **Isolation.** Every owned record carries `ownerId`; one helper (`owned`) answers `NOT_FOUND` for
  anything else. A mutation test confirms the isolation test fails if that check is removed.

## Capability audit (Milestone 0) — what the platform actually provides

Checked against the installed `@feltdb/feltkit` 0.3.18 docs and types, not assumed:

| Spec component | What exists and is used | Gap |
|---|---|---|
| FeltDB | Atomic mutations with read-set conflict checks, schema enforcement, unique constraints, per-stream sequences (used to order audit/relationship/introduction events), restart durability | Isolation is application-level (`ownerId`), not FeltDB tenancy; FeltKit tenancy is workspace-shaped and did not fit cross-member introductions |
| AppPort | `briefs.create` and `briefs.match` published as capabilities; MCP endpoint at `/mcp`; approval-required mutations | No e-mail, contacts or calendar AppPorts exist in this project |
| AppPort Services | Notifications (in-app introduction requests/answers, with idempotency keys), jobs (`introductions.expire-due`) | No outbound e-mail delivery configured |
| Intent / agent | Approval-required mutations; `ctx.afterCommit` for effects | FeltKit's model path is `ctx.agent.start({ decision })` — choosing among app-built options. There is no structured text-extraction call, so the brief interpreter is deterministic rules |
| Resolver | Model references for agent decisions | Not used: no model call is on the critical path |
| AuthBoundry | Roles, dev identities, built-in accounts for production | No field-level authorization primitive; field disclosure is enforced in code via consent grants |

## Not built yet (explicit gaps, not mocked)

- **Outbound delivery to non-members.** No connector exists, so outreach to someone who is not a
  member is a *manual* path: the app approves the text, you send it yourself and record that you
  did. The app never claims delivery.
- **Scheduling / calendar** (Milestone 4) and **contact/mail connectors**. CSV import, hand entry
  and user-supplied public URLs are the authorized sources today.
- **Model-assisted interpretation and drafting.** The seam is `interpretBrief` (and the draft
  template); outputs are already labelled with their interpreter (`interpretedBy`).
- **Delegated authority grants** for agents beyond proposals, standing approval policies,
  consent-spam detection, and abuse review tooling.
- **Matching quality** is keyword/stem overlap with source weights; it does not understand
  synonyms ("Postgres" ≠ "databases") or phrases. Generic words can produce weak matches, shown
  with low scores and explicit unknowns.
- **Retention periods** are not time-based yet: deletion is on request, and raw imported text is
  kept until then.
- Not portable to an AppBoundry artifact: approval-required mutations need FeltKit's runtime
  (`npm run build` reports this).

## Deploying

`npm run deploy` builds a verified container artifact; see `npx feltkit docs path-to-production`.
Production has no dev identities: people create accounts (`auth.accounts` in `feltkit/app.ts`).
