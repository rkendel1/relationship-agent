/**
 * Boundry Connector's screens. Chat is not the product: these are durable review surfaces for
 * briefs, evidence-backed matches, the introduction workflow, consent, and the audit trail. The
 * server enforces every rule; nothing here grants or decides anything.
 */
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQueryState } from "@feltdb/feltkit/react";
import { api } from "../feltkit/_generated/api";

import { Badge, Empty, fmt, fmtDate, splitList, STATE_HELP, STATE_LABEL, useAction, type Props } from "./ui";
import { IntrosView, ReadinessView } from "./Delivery";

type View = "ask" | "people" | "intros" | "requests" | "delivery" | "profile" | "privacy";

export function Workspace(props: Props) {
  const [view, setView] = useState<View>("ask");
  const [focus, setFocus] = useState<{ intro?: string; person?: string }>({});
  const incoming = useQueryState(api.introductions.incoming);
  const profile = useQueryState(api.profile.get);
  const pending = (incoming.data ?? []).filter((r) => r.state === "consent_requested").length;
  const nav: Array<[View, string, ReactNode?]> = [
    ["ask", "Ask"],
    ["people", "People"],
    ["intros", "Introductions"],
    ["requests", "Requests", pending ? <span className="count pill">{pending}</span> : null],
    ["delivery", "Delivery"],
    ["profile", "Profile"],
    ["privacy", "Privacy & audit"],
  ];
  const go = (v: View, f: typeof focus = {}) => (setView(v), setFocus(f));
  return (
    <div className="workspace">
      <aside className="sidebar" aria-label="Sections">
        <nav>
          {nav.map(([v, label, extra]) => (
            <button key={v} className={`project ${view === v ? "active" : ""}`} onClick={() => go(v)}>
              <span className="project-name">{label}</span>
              {extra}
            </button>
          ))}
        </nav>
        {profile.data === null && (
          <p className="hint">
            Start with your <button className="link" onClick={() => go("profile")}>profile</button>: it is what others see when you ask for an introduction.
          </p>
        )}
      </aside>
      <main className="main">
        {view === "ask" && <AskView {...props} openIntro={(id) => go("intros", { intro: id })} openPerson={(id) => go("people", { person: id })} />}
        {view === "people" && <PeopleView {...props} initial={focus.person} />}
        {view === "intros" && <IntrosView {...props} initial={focus.intro} />}
        {view === "requests" && <RequestsView {...props} />}
        {view === "delivery" && <ReadinessView {...props} />}
        {view === "profile" && <ProfileView {...props} />}
        {view === "privacy" && <PrivacyView {...props} />}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Ask: brief → interpretation → confirm → matches

function AskView(props: Props & { openIntro: (id: string) => void; openPerson: (id: string) => void }) {
  const briefs = useQueryState(api.briefs.list);
  const create = useMutation(api.briefs.create);
  const [text, setText] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const { busy, run } = useAction(props.onError);
  const list = (briefs.data ?? []).filter((b) => b.status !== "archived");
  const current = list.find((b) => b.id === selected) ?? list[0] ?? null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const id = await run(() => create({ text }));
    if (id) setText(""), setSelected(id);
  };

  return (
    <div className="stack gap">
      <div>
        <h1>What outcome do you want?</h1>
        <p className="muted">Describe who you are looking for and why. Nothing is searched or sent until you confirm the brief, and nothing reaches anyone until you approve it.</p>
      </div>
      <form className="ask" onSubmit={submit}>
        <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Find me someone who can evaluate a Boundry/FeltKit project on durable databases, ideally this month." aria-label="Your request" />
        <div className="row-end">
          <button className="primary" disabled={busy || !text.trim()}>Interpret request</button>
        </div>
      </form>
      {list.length > 1 && (
        <div className="tabs" role="tablist" aria-label="Briefs">
          {list.map((b) => (
            <button key={b.id} role="tab" aria-selected={current?.id === b.id} className={`tab ${current?.id === b.id ? "on" : ""}`} onClick={() => setSelected(b.id)} title={b.text}>
              {b.target.slice(0, 40) || b.text.slice(0, 40)}
              <span className="muted"> · {b.status}</span>
            </button>
          ))}
        </div>
      )}
      {current && <BriefView key={current.id} brief={current} {...props} />}
    </div>
  );
}

type Brief = NonNullable<ReturnType<typeof useQueryState<typeof api.briefs.list>>["data"]>[number];
const TYPES = ["expert", "design_partner", "investor", "customer", "collaborator", "hire", "job", "other"] as const;

function BriefView({ brief, onError, onInfo, openIntro, openPerson }: Props & { brief: Brief; openIntro: (id: string) => void; openPerson: (id: string) => void }) {
  const update = useMutation(api.briefs.update);
  const confirm = useMutation(api.briefs.confirm);
  const match = useMutation(api.briefs.match);
  const archive = useMutation(api.briefs.archive);
  const { busy, run } = useAction(onError);
  const [form, setForm] = useState(() => ({
    opportunityType: brief.opportunityType,
    target: brief.target,
    topics: brief.topics.join(", "),
    geography: brief.geography ?? "",
    timing: brief.timing ?? "",
    successCondition: brief.successCondition ?? "",
    confidential: brief.confidential,
    excludedOrganizations: brief.excludedOrganizations.join(", "),
  }));
  const [editing, setEditing] = useState(brief.status === "draft");
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const save = () =>
    run(async () => {
      await update({
        id: brief.id,
        opportunityType: form.opportunityType,
        target: form.target,
        topics: splitList(form.topics),
        geography: form.geography,
        timing: form.timing,
        successCondition: form.successCondition,
        confidential: form.confidential,
        excludedOrganizations: splitList(form.excludedOrganizations),
        excludedPersonIds: brief.excludedPersonIds,
      });
    });
  const saveAndConfirm = async () => {
    await save();
    const ok = await run(() => confirm({ id: brief.id }));
    if (ok !== undefined) {
      setEditing(false);
      const r = await run(() => match({ id: brief.id }));
      if (r) onInfo(`Searched ${r.candidates} people in your graph and the network: ${r.matches} with matching evidence.`);
    }
  };

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <div className="eyebrow">
            Brief · {brief.status} · interpreted by {brief.interpretedBy}
            {brief.confidential && <span className="badge b-confidential">Confidential</span>}
          </div>
          <p className="quote">“{brief.text}”</p>
        </div>
        <div className="actions">
          {!editing && <button className="secondary" onClick={() => setEditing(true)}>Edit</button>}
          <button className="danger-link" onClick={() => run(() => archive({ id: brief.id }))}>Archive</button>
        </div>
      </div>
      {brief.questions.length > 0 && brief.status === "draft" && (
        <ul className="questions">
          {brief.questions.map((q) => (
            <li key={q}>{q}</li>
          ))}
        </ul>
      )}
      {editing ? (
        <div className="grid2">
          <label className="field">
            <span>Kind of connection</span>
            <select value={form.opportunityType} onChange={set("opportunityType") as never}>
              {TYPES.map((t) => (
                <option key={t} value={t}>{t.replace("_", " ")}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Looking for</span>
            <input value={form.target} onChange={set("target")} />
          </label>
          <label className="field">
            <span>Topics (what evidence must mention)</span>
            <input value={form.topics} onChange={set("topics")} placeholder="databases, feltkit" />
          </label>
          <label className="field">
            <span>Location</span>
            <input value={form.geography} onChange={set("geography")} />
          </label>
          <label className="field">
            <span>Timing</span>
            <input value={form.timing} onChange={set("timing")} />
          </label>
          <label className="field">
            <span>Success looks like</span>
            <input value={form.successCondition} onChange={set("successCondition")} />
          </label>
          <label className="field">
            <span>Never involve (organizations)</span>
            <input value={form.excludedOrganizations} onChange={set("excludedOrganizations")} placeholder="e.g. your current employer" />
          </label>
          <label className="check">
            <input type="checkbox" checked={form.confidential} onChange={(e) => setForm({ ...form, confidential: e.target.checked })} />
            <span>Confidential: share no details beyond the topic, and never reach the organizations above.</span>
          </label>
          <div className="row-end span2">
            <button className="secondary" disabled={busy} onClick={() => save().then(() => setEditing(false))}>Save draft</button>
            <button className="primary" disabled={busy || !splitList(form.topics).length} onClick={saveAndConfirm}>Confirm and find matches</button>
          </div>
        </div>
      ) : (
        <dl className="facts">
          <dt>Kind</dt>
          <dd>{brief.opportunityType.replace("_", " ")}</dd>
          <dt>Looking for</dt>
          <dd>{brief.target || "—"}</dd>
          <dt>Topics</dt>
          <dd>{brief.topics.join(", ") || "—"}</dd>
          {brief.geography && (<><dt>Location</dt><dd>{brief.geography}</dd></>)}
          {brief.timing && (<><dt>Timing</dt><dd>{brief.timing}</dd></>)}
          {brief.excludedOrganizations.length > 0 && (<><dt>Never involve</dt><dd>{brief.excludedOrganizations.join(", ")}</dd></>)}
        </dl>
      )}
      {brief.status === "confirmed" && (
        <div className="row-between">
          <span className="muted small-text">{brief.matchedAt ? `Last searched ${fmt(brief.matchedAt)}` : "Not searched yet"}</span>
          <button className="secondary" disabled={busy} onClick={() => run(() => match({ id: brief.id }))}>Search again</button>
        </div>
      )}
      {brief.status === "confirmed" && <MatchList briefId={brief.id} onError={onError} onInfo={onInfo} openIntro={openIntro} openPerson={openPerson} />}
    </section>
  );
}

function MatchList({ briefId, onError, onInfo, openIntro, openPerson }: Props & { briefId: string; openIntro: (id: string) => void; openPerson: (id: string) => void }) {
  const [showRejected, setShowRejected] = useState(false);
  const matches = useQueryState(api.matches.list, { briefId, includeRejected: showRejected });
  const decide = useMutation(api.matches.decide);
  const draft = useMutation(api.introductions.draft);
  const { busy, run } = useAction(onError);
  const list = matches.data ?? [];
  if (matches.isLoading && !matches.data) return <p className="muted">Loading matches…</p>;
  return (
    <div className="stack">
      <div className="row-between">
        <h2>Candidates</h2>
        <label className="check small-text">
          <input type="checkbox" checked={showRejected} onChange={(e) => setShowRejected(e.target.checked)} /> Show rejected
        </label>
      </div>
      {list.length === 0 && (
        <p className="muted">
          No one in your graph or the network has evidence for these topics yet. That is an honest answer, not a failure: import contacts, add people you know, or broaden the topics.
        </p>
      )}
      {list.map((m) => (
        <article key={m.id} className={`match ${m.decision}`}>
          <header className="row-between">
            <div>
              <button className="link strong" onClick={() => openPerson(m.personId)}>{m.name}</button>
              <span className="muted">{[m.title, m.organization].filter(Boolean).join(" · ")}</span>
              {m.participant && <span className="badge b-participant">Network member</span>}
              {m.strength && <span className={`badge m-${m.strength}`} title="Strong: most explicit topics are evidenced by specific terms. Weak: only generic or incidental terms matched.">{m.strength} match</span>}
            </div>
            <div className="row">
              <Badge state={m.relationshipState} />
              <span className="score" title="Evidence coverage and strength, plus relationship. Comparable within this brief only.">{m.score.toFixed(2)}</span>
            </div>
          </header>
          <ul className="reasons">
            {m.reasons.map((r, i) => (
              <li key={i} className={`reason ${r.kind}`}>
                {r.text}
                {r.evidenceIds.length > 0 && <span className="cite"> [{r.evidenceIds.map((id) => m.evidence.find((e) => e.id === id)?.sourceType.replace("_", " ") ?? id).join(", ")}]</span>}
              </li>
            ))}
          </ul>
          {m.unknowns.length > 0 && (
            <ul className="unknowns">
              {m.unknowns.map((u) => (
                <li key={u}>{u}</li>
              ))}
            </ul>
          )}
          {m.contributions.length > 0 && (
            <details>
              <summary className="small-text muted">How the score was computed</summary>
              <table className="table">
                <thead>
                  <tr><th>Brief term</th><th>Found as</th><th>Where</th><th>Evidence</th><th>Confidence</th><th>Freshness</th><th>Points</th></tr>
                </thead>
                <tbody>
                  {m.contributions.map((k, i) => (
                    <tr key={i} className={k.counted ? "" : "muted"}>
                      <td>{k.briefTerm}{k.termKind === "context" ? " (context)" : ""}{k.lowSignal ? " · generic" : ""}</td>
                      <td>{k.matchedWord}{k.aliasId ? " (alias)" : ""}</td>
                      <td>{k.field}</td>
                      <td>{m.evidence.find((e) => e.id === k.evidenceId)?.sourceType.replace("_", " ") ?? k.evidenceId}</td>
                      <td>{Math.round(k.confidence * 100)}%</td>
                      <td>{k.freshness}</td>
                      <td>{k.counted ? k.points.toFixed(3) : `(${k.points.toFixed(3)})`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="small-text muted">Only the strongest finding per term counts (others in parentheses). Score = counted points ÷ total term weight + relationship bonus.</p>
            </details>
          )}
          <details>
            <summary className="small-text muted">Evidence ({m.evidence.length})</summary>
            {m.evidence.map((e) => (
              <div key={e.id} className="evidence">
                <div className="small-text muted">
                  {e.sourceType.replace("_", " ")} · {e.sourceRef} · captured {fmtDate(e.capturedAt)} · confidence {Math.round(e.confidence * 100)}%
                </div>
                <div>{e.claim}</div>
              </div>
            ))}
          </details>
          <footer className="row-between">
            <div className="row">
              {(["accepted", "deferred", "rejected"] as const).map((d) => (
                <button key={d} className={`secondary small ${m.decision === d ? "on" : ""}`} disabled={busy} onClick={() => run(() => decide({ id: m.id, decision: m.decision === d ? "pending" : d }))}>
                  {d === "accepted" ? "Good match" : d === "deferred" ? "Later" : "Not right"}
                </button>
              ))}
            </div>
            {m.decision !== "rejected" && (
              <button
                className="primary small"
                disabled={busy}
                onClick={async () => {
                  const id = await run(() => draft({ matchId: m.id }));
                  if (id) onInfo("Draft created. Review exactly what will be shared before approving."), openIntro(id);
                }}
              >
                {m.participant ? "Draft introduction request" : "Draft outreach"}
              </button>
            )}
          </footer>
        </article>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Introductions (outgoing)

// ---------------------------------------------------------------------------------------------
// Requests (incoming)

function RequestsView({ onError, onInfo }: Props) {
  const incoming = useQueryState(api.introductions.incoming);
  const respond = useMutation(api.introductions.respond);
  const revoke = useMutation(api.introductions.revokeConsent);
  const { busy, run } = useAction(onError);
  const [fields, setFields] = useState<Record<string, Array<"email" | "headline">>>({});
  const list = incoming.data ?? [];
  return (
    <div className="stack gap">
      <div>
        <h1>Requests to you</h1>
        <p className="muted">People who asked to be introduced. You see only what they chose to share; they see nothing about you until you accept, and then only what you tick.</p>
      </div>
      {list.length === 0 && <Empty title="No requests">Turn on “open to introductions” in your profile to be discoverable for the topics you choose.</Empty>}
      {list.map((r) => {
        const chosen = fields[r.id] ?? ["headline"];
        return (
          <article key={r.id} className="card stack">
            <div className="row-between">
              <h2>{r.from}</h2>
              <Badge state={r.state} kind="intro" />
            </div>
            <p>{r.sharedContext}</p>
            <p className="pre muted">{r.message}</p>
            {Object.keys(r.disclosed).length > 0 && (
              <div className="disclosed">
                <div className="small-text muted">Shared with you by consent</div>
                {Object.entries(r.disclosed).map(([k, v]) => (
                  <div key={k}>
                    <strong>{k}:</strong> {v}
                  </div>
                ))}
              </div>
            )}
            {r.state === "consent_requested" && (
              <>
                <fieldset className="field">
                  <span>If you accept, share:</span>
                  {(["headline", "email"] as const).map((f) => (
                    <label key={f} className="check">
                      <input type="checkbox" checked={chosen.includes(f)} onChange={(e) => setFields({ ...fields, [r.id]: e.target.checked ? [...chosen, f] : chosen.filter((x) => x !== f) })} /> your {f}
                    </label>
                  ))}
                </fieldset>
                <div className="row-between">
                  <span className="muted small-text">{r.expiresAt ? `Expires ${fmtDate(r.expiresAt)}` : ""}</span>
                  <div className="row">
                    <button className="danger-link" disabled={busy} onClick={() => run(() => respond({ id: r.id, accept: false, fields: [], block: true }))}>Decline and block</button>
                    <button className="secondary" disabled={busy} onClick={() => run(() => respond({ id: r.id, accept: false, fields: [] }))}>Decline</button>
                    <button className="primary" disabled={busy} onClick={() => run(() => respond({ id: r.id, accept: true, fields: chosen })).then((x) => x && onInfo(x.state === "introduced" ? "Introduced. You can withdraw your consent at any time." : `This request has ${x.state}.`))}>Accept</button>
                  </div>
                </div>
              </>
            )}
            {r.myConsentActive && (
              <div className="row-end">
                <button className="danger-link" onClick={() => run(() => revoke({ introductionId: r.id }))}>Withdraw my consent</button>
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// People and evidence

function PeopleView(props: Props & { initial?: string }) {
  const people = useQueryState(api.people.list);
  const [selected, setSelected] = useState<string | undefined>(props.initial);
  const [mode, setMode] = useState<"none" | "add" | "import">("none");
  const [filter, setFilter] = useState("");
  const list = useMemo(() => (people.data ?? []).filter((p) => !filter || `${p.name} ${p.organization ?? ""}`.toLowerCase().includes(filter.toLowerCase())), [people.data, filter]);
  return (
    <div className="stack gap">
      <div className="row-between">
        <h1>People</h1>
        <div className="row">
          <button className="secondary" onClick={() => setMode(mode === "add" ? "none" : "add")}>Add person</button>
          <button className="secondary" onClick={() => setMode(mode === "import" ? "none" : "import")}>Import contacts</button>
        </div>
      </div>
      {mode === "add" && <AddPerson {...props} done={(id) => (setMode("none"), setSelected(id))} />}
      {mode === "import" && <ImportContacts {...props} done={() => setMode("none")} />}
      {(people.data ?? []).length === 0 ? (
        <Empty title="Your graph is empty">Import a contacts CSV or add someone you know. Each person keeps the evidence for every claim about them.</Empty>
      ) : (
        <div className="split">
          <div className="stack">
            <input className="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter" aria-label="Filter people" />
            <ul className="list">
              {list.map((p) => (
                <li key={p.id}>
                  <button className={`project ${selected === p.id ? "active" : ""}`} onClick={() => setSelected(p.id)}>
                    <span className="project-name">
                      {p.name}
                      {p.organization && <span className="muted"> · {p.organization}</span>}
                    </span>
                    <Badge state={p.state} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
          {selected && <PersonDetail key={selected} id={selected} {...props} />}
        </div>
      )}
    </div>
  );
}

function AddPerson({ onError, done }: Props & { done: (id: string) => void }) {
  const add = useMutation(api.people.add);
  const { busy, run } = useAction(onError);
  const [f, setF] = useState({ name: "", organization: "", title: "", email: "", note: "", topics: "" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const id = await run(() => add({ name: f.name, organization: f.organization, title: f.title, email: f.email, note: f.note, topics: splitList(f.topics) }));
    if (id) done(id);
  };
  return (
    <form className="card grid2" onSubmit={submit}>
      <label className="field"><span>Name</span><input value={f.name} onChange={set("name")} required /></label>
      <label className="field"><span>Organization</span><input value={f.organization} onChange={set("organization")} /></label>
      <label className="field"><span>Title</span><input value={f.title} onChange={set("title")} /></label>
      <label className="field"><span>E-mail (private, never shared)</span><input type="email" value={f.email} onChange={set("email")} /></label>
      <label className="field span2"><span>What do you know about them? (becomes evidence)</span><textarea rows={2} value={f.note} onChange={set("note")} /></label>
      <label className="field span2"><span>Topics</span><input value={f.topics} onChange={set("topics")} placeholder="databases, design systems" /></label>
      <div className="row-end span2"><button className="primary" disabled={busy || !f.name.trim()}>Add</button></div>
    </form>
  );
}

const SAMPLE_CSV = `name,email,organization,title,notes,topics
Barbara Liskov,barbara@example.org,MIT,Professor,Reviewed my database design last year,databases;distributed systems
`;

function ImportContacts({ onError, onInfo, done }: Props & { done: () => void }) {
  const importContacts = useMutation(api.people.importContacts);
  const { busy, run } = useAction(onError);
  const [label, setLabel] = useState("contacts.csv");
  const [csv, setCsv] = useState("");
  return (
    <div className="card stack">
      <p className="muted small-text">
        Columns: <code>name, email, organization, title, notes, topics</code> (topics separated by “;”). Each import is one source you can revoke later. People are merged only on an exact e-mail match. Imported text is stored as data, never followed as instructions.
      </p>
      <input
        type="file"
        accept=".csv,text/csv"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (file) setLabel(file.name), setCsv(await file.text());
        }}
      />
      <textarea rows={5} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={SAMPLE_CSV} aria-label="CSV" />
      <div className="row-end">
        <input value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Source label" />
        <button
          className="primary"
          disabled={busy || !csv.trim()}
          onClick={async () => {
            const r = await run(() => importContacts({ label, csv }));
            if (r) onInfo(`Imported: ${r.created} new, ${r.merged} merged by e-mail, ${r.skipped} skipped.`), done();
          }}
        >
          Import
        </button>
      </div>
    </div>
  );
}

function PersonDetail({ id, onError }: Props & { id: string }) {
  const q = useQueryState(api.people.get, { id });
  const addEvidence = useMutation(api.people.addEvidence);
  const correct = useMutation(api.people.correctEvidence);
  const attest = useMutation(api.people.attest);
  const { busy, run } = useAction(onError);
  const [ev, setEv] = useState({ kind: "user_attested" as "user_attested" | "public_url", claim: "", url: "", topics: "" });
  const [att, setAtt] = useState({ state: "known" as "known" | "connected", note: "" });
  const [correcting, setCorrecting] = useState<{ id: string; claim: string } | null>(null);
  if (q.error) return <p className="error-text">{q.error.message}</p>;
  const data = q.data;
  if (!data) return <p className="muted">Loading…</p>;
  const p = data.person as { name: string; organization?: string; title?: string; email?: string; linkedUserId?: string };
  return (
    <section className="card stack">
      <div className="row-between">
        <div>
          <h2>{p.name}</h2>
          <div className="muted">{[p.title, p.organization].filter(Boolean).join(" · ")}</div>
          {p.email && <div className="small-text muted">{p.email} · private</div>}
        </div>
        <Badge state={data.state} />
      </div>
      <p className="small-text muted">{STATE_HELP[data.state]}</p>

      {["unknown", "observed", "known"].includes(data.state) && (
        <form className="inline-form" onSubmit={(e) => (e.preventDefault(), run(() => attest({ personId: id, state: att.state, note: att.note })).then(() => setAtt({ ...att, note: "" })))}>
          <select value={att.state} onChange={(e) => setAtt({ ...att, state: e.target.value as "known" | "connected" })} aria-label="Relationship">
            <option value="known">I know them</option>
            <option value="connected">We are connected</option>
          </select>
          <input value={att.note} onChange={(e) => setAtt({ ...att, note: e.target.value })} placeholder="How? (required, becomes evidence)" aria-label="How you know them" />
          <button className="secondary" disabled={busy || !att.note.trim()}>Record</button>
        </form>
      )}

      <h3>Evidence</h3>
      {data.evidence.length === 0 && <p className="muted">No current evidence.</p>}
      {data.evidence.map((e) => (
        <div key={e.id} className="evidence">
          <div className="small-text muted">
            {e.sourceType.replace("_", " ")} · {e.sourceLabel} · {fmtDate(e.capturedAt)} · confidence {Math.round(e.confidence * 100)}% · {e.scope}
            {e.supersedes && " · correction"}
          </div>
          {correcting?.id === e.id ? (
            <div className="inline-form">
              <input value={correcting.claim} onChange={(x) => setCorrecting({ ...correcting, claim: x.target.value })} aria-label="Corrected claim" />
              <button className="secondary" disabled={busy || !correcting.claim.trim()} onClick={() => run(() => correct({ evidenceId: e.id, claim: correcting.claim, retract: false })).then(() => setCorrecting(null))}>Save</button>
              <button className="danger-link" onClick={() => run(() => correct({ evidenceId: e.id, retract: true })).then(() => setCorrecting(null))}>Retract</button>
            </div>
          ) : (
            <div className="row-between">
              <span>{e.claim}</span>
              {e.sourceType !== "participant_statement" && <button className="link small-text" onClick={() => setCorrecting({ id: e.id, claim: e.claim })}>Correct</button>}
            </div>
          )}
          {e.topics.length > 0 && <div className="small-text muted">topics: {e.topics.join(", ")}</div>}
        </div>
      ))}

      <form
        className="stack"
        onSubmit={(x) => {
          x.preventDefault();
          void run(() => addEvidence({ personId: id, kind: ev.kind, claim: ev.claim, url: ev.url || undefined, topics: splitList(ev.topics) })).then((r) => r && setEv({ ...ev, claim: "", url: "", topics: "" }));
        }}
      >
        <div className="inline-form">
          <select value={ev.kind} onChange={(e) => setEv({ ...ev, kind: e.target.value as typeof ev.kind })} aria-label="Evidence kind">
            <option value="user_attested">My note</option>
            <option value="public_url">Public source (URL)</option>
          </select>
          {ev.kind === "public_url" && <input value={ev.url} onChange={(e) => setEv({ ...ev, url: e.target.value })} placeholder="https://…" aria-label="URL" />}
        </div>
        <input value={ev.claim} onChange={(e) => setEv({ ...ev, claim: e.target.value })} placeholder="The claim, in your words" aria-label="Claim" />
        <div className="inline-form">
          <input value={ev.topics} onChange={(e) => setEv({ ...ev, topics: e.target.value })} placeholder="topics" aria-label="Topics" />
          <button className="secondary" disabled={busy || !ev.claim.trim()}>Add evidence</button>
        </div>
      </form>

      <details>
        <summary className="small-text muted">Relationship history</summary>
        <ol className="timeline">
          {data.events.map((e) => (
            <li key={e.id}>
              {fmt(e.at)} — {STATE_LABEL[e.from]} → {STATE_LABEL[e.to]} <span className="muted">({e.cause}, by {e.actorId})</span>
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Profile

function ProfileView({ onError, onInfo }: Props) {
  const q = useQueryState(api.profile.get);
  const save = useMutation(api.profile.save);
  const { busy, run } = useAction(onError);
  const [f, setF] = useState<null | { displayName: string; headline: string; email: string; projects: string; expertise: string; needs: string; boundaries: string; openToIntroductions: boolean; introTopics: string; needsVisible: boolean }>(null);
  useEffect(() => {
    if (q.isLoading || f) return;
    const p = q.data;
    setF({
      displayName: p?.displayName ?? "",
      headline: p?.headline ?? "",
      email: p?.email ?? "",
      projects: p?.projects.join("\n") ?? "",
      expertise: p?.expertise.join(", ") ?? "",
      needs: p?.needs.join("\n") ?? "",
      boundaries: p?.boundaries ?? "",
      openToIntroductions: p?.openToIntroductions ?? false,
      introTopics: p?.introTopics.join(", ") ?? "",
      needsVisible: p?.needsVisible ?? false,
    });
  }, [q.isLoading, q.data, f]);
  if (!f) return <p className="muted">Loading…</p>;
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <form
      className="stack gap"
      onSubmit={(e) => {
        e.preventDefault();
        void run(() =>
          save({ displayName: f.displayName, headline: f.headline, email: f.email, projects: splitList(f.projects), expertise: splitList(f.expertise), needs: splitList(f.needs), boundaries: f.boundaries, openToIntroductions: f.openToIntroductions, introTopics: splitList(f.introTopics), needsVisible: f.needsVisible }),
        ).then(() => onInfo("Profile saved."));
      }}
    >
      <h1>Your profile</h1>
      <div className="card grid2">
        <label className="field"><span>Name</span><input value={f.displayName} onChange={set("displayName")} required /></label>
        <label className="field"><span>Headline (shown in requests only if you choose)</span><input value={f.headline} onChange={set("headline")} /></label>
        <label className="field"><span>E-mail (disclosed only after both sides consent)</span><input type="email" value={f.email} onChange={set("email")} /></label>
        <label className="field"><span>Expertise</span><input value={f.expertise} onChange={set("expertise")} placeholder="databases, product strategy" /></label>
        <label className="field span2"><span>Projects (one per line)</span><textarea rows={2} value={f.projects} onChange={set("projects")} /></label>
        <label className="field span2"><span>What you need (one per line)</span><textarea rows={2} value={f.needs} onChange={set("needs")} /></label>
        <label className="field span2"><span>Boundaries (what you will not be introduced for)</span><textarea rows={2} value={f.boundaries} onChange={set("boundaries")} /></label>
      </div>
      <div className="card stack">
        <label className="check">
          <input type="checkbox" checked={f.openToIntroductions} onChange={(e) => setF({ ...f, openToIntroductions: e.target.checked })} />
          <span>
            <strong>Open to introduction requests</strong> from other members whose briefs match the topics below. They see your name, headline and topics; never your e-mail unless you accept a specific request.
          </span>
        </label>
        <label className="field"><span>Topics you will take requests about</span><input value={f.introTopics} onChange={set("introTopics")} disabled={!f.openToIntroductions} /></label>
        <label className="check">
          <input type="checkbox" checked={f.needsVisible} disabled={!f.openToIntroductions} onChange={(e) => setF({ ...f, needsVisible: e.target.checked })} />
          <span>Let customer, design-partner and collaborator searches match what you <em>need</em> (listed above). Off by default.</span>
        </label>
      </div>
      <AliasEditor onError={onError} />
      <div className="row-end"><button className="primary" disabled={busy}>Save profile</button></div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// Privacy: sources, export, deletion, audit

function PrivacyView({ onError, onInfo }: Props) {
  const sources = useQueryState(api.sources.list);
  const audit = useQueryState(api.privacy.auditLog, { limit: 200 });
  const [exporting, setExporting] = useState(false);
  const exported = useQueryState(api.privacy.exportAll, exporting ? {} : "skip");
  const revoke = useMutation(api.sources.revoke);
  const del = useMutation(api.privacy.deleteAll);
  const { busy, run } = useAction(onError);
  const [confirm, setConfirm] = useState("");

  useEffect(() => {
    if (!exporting || !exported.data) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(exported.data, null, 2)], { type: "application/json" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `boundry-connector-export-${new Date().toISOString().slice(0, 10)}.json` });
    a.click();
    URL.revokeObjectURL(url);
    setExporting(false);
  }, [exporting, exported.data]);

  return (
    <div className="stack gap">
      <h1>Privacy & audit</h1>
      <section className="card stack">
        <h2>Sources</h2>
        <p className="muted small-text">Everything the app knows came from one of these. Revoking a source stops its evidence being used at once; it stays in your export until you delete your data.</p>
        <table className="table">
          <thead>
            <tr><th>Source</th><th>Kind</th><th>Evidence</th><th>Added</th><th /></tr>
          </thead>
          <tbody>
            {(sources.data ?? []).map((s) => (
              <tr key={s.id} className={s.status}>
                <td>{s.label}</td>
                <td>{s.kind.replace("_", " ")}</td>
                <td>{s.evidenceCount}</td>
                <td>{fmtDate(s.createdAt)}</td>
                <td>{s.status === "active" ? <button className="danger-link" disabled={busy} onClick={() => run(() => revoke({ id: s.id }))}>Revoke</button> : <span className="muted">revoked {fmtDate(s.revokedAt)}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="card row-between">
        <div>
          <h2>Export</h2>
          <p className="muted small-text">One JSON file with your profile, graph, evidence, briefs, matches, introductions, consent and audit trail.</p>
        </div>
        <button className="secondary" disabled={exporting} onClick={() => setExporting(true)}>Download export</button>
      </section>
      <section className="card stack danger-zone">
        <h2>Delete my data</h2>
        <p className="muted small-text">Removes your profile, sources, people, evidence, relationships, briefs, matches and introductions, and withdraws every consent you gave. The audit trail is kept: it holds only ids and action names.</p>
        <div className="inline-form">
          <input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Type DELETE" aria-label="Type DELETE to confirm" />
          <button className="danger" disabled={busy || confirm !== "DELETE"} onClick={() => run(() => del({ confirm })).then((r) => r && (setConfirm(""), onInfo(`Deleted ${r.deleted} records.`)))}>Delete</button>
        </div>
      </section>
      <section className="card stack">
        <h2>Audit trail</h2>
        <ol className="timeline">
          {(audit.data ?? []).map((a) => (
            <li key={a.id}>
              <span className="muted">{fmt(a.at)}</span> {a.action} <span className="muted">{a.subjectType} {a.subjectId.slice(0, 8)} · by {a.actorId}{a.actorType !== "user" ? ` (${a.actorType})` : ""}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Aliases

/** Equivalent terms the matcher may use. Only what is declared here is treated as the same word. */
function AliasEditor({ onError }: { onError: (e: unknown) => void }) {
  const list = useQueryState(api.aliases.list);
  const set = useMutation(api.aliases.set);
  const remove = useMutation(api.aliases.remove);
  const { busy, run } = useAction(onError);
  const [term, setTerm] = useState("");
  const [equivalents, setEquivalents] = useState("");
  return (
    <div className="card stack">
      <h2>Equivalent terms</h2>
      <p className="small-text muted">Matching never guesses that two words mean the same. Declare it here, e.g. “databases” = “postgres, distributed storage”. Matches found through an alias count a little less and say so.</p>
      {(list.data ?? []).map((a) => (
        <div key={a.id} className="row-between">
          <span><strong>{a.term}</strong> = {a.equivalents.join(", ")}</span>
          <button type="button" className="danger-link" onClick={() => run(() => remove({ id: a.id }))}>Remove</button>
        </div>
      ))}
      <div className="inline-form">
        <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="term" aria-label="Term" />
        <input value={equivalents} onChange={(e) => setEquivalents(e.target.value)} placeholder="equivalents, comma separated" aria-label="Equivalent terms" />
        <button type="button" className="secondary" disabled={busy || !term.trim() || !splitList(equivalents).length} onClick={() => run(() => set({ term, equivalents: splitList(equivalents) })).then((id) => id && (setTerm(""), setEquivalents("")))}>Save</button>
      </div>
    </div>
  );
}
