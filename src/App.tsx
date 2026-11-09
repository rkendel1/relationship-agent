import { useEffect, useRef, useState, type FormEvent } from "react";
import { useConnectionState, useFeltKit, useSession, type FeltKitClientError } from "@feltdb/feltkit/react";
import { ThemeToggle } from "./theme";
import { Workspace } from "./Connector";

type Notice = { tone: "error" | "info"; text: string } | null;

export function describe(error: unknown): string {
  const e = error as FeltKitClientError;
  if (e?.code === "FORBIDDEN") return `Not allowed: ${e.message}`;
  if (e?.code === "UNAUTHORIZED") return "Sign in to continue.";
  if (e?.code === "CONFLICT") return e.message;
  return e?.message ?? String(error);
}

export function App() {
  const { session, signInAsDevUser, signIn, signUp, signOut } = useSession();
  const live = useConnectionState();
  const [notice, setNotice] = useState<Notice>(null);
  const principal = session?.principal ?? null;

  // In development, sign in as the first dev user so the app works on first load.
  const tried = useRef(false);
  useEffect(() => {
    if (session && !principal && session.devUsers.length && !tried.current) {
      tried.current = true;
      void signInAsDevUser(session.devUsers[0]!.id);
    }
  }, [session, principal, signInAsDevUser]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const report = (error: unknown) => setNotice({ tone: "error", text: describe(error) });

  // A link back into the app: a provider sign-in, a password reset, or an e-mail verification.
  const client = useFeltKit();
  const [resetToken, setResetToken] = useState<string | null>(null);
  useEffect(() => {
    void client.handleRedirect().then((r) => {
      if (r?.kind === "reset") setResetToken(r.token);
      else if (r?.kind === "verified") setNotice({ tone: "info", text: `${r.email} is verified.` });
      else if (r?.kind === "error" || r?.kind === "verify-failed") setNotice({ tone: "error", text: r.message });
    });
  }, [client]);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <img className="mark" src="/feltkit-mark.png" width="30" height="30" alt="" />
          <span className="brand-name">Boundry Connector</span>
          {session && !session.environment.production && <span className="env">{session.environment.name}</span>}
        </div>
        <div className="topbar-right">
          <span className={`live ${live ? "on" : ""}`} title={live ? "Live: changes from anyone appear here immediately" : "Connecting to the change stream…"}>
            <span className="dot" /> {live ? "Live" : "Connecting"}
          </span>
          {session && session.devUsers.length > 0 && (
            <label className="identity">
              <span className="sr-only">Signed in as</span>
              <select
                value={principal?.id ?? ""}
                onChange={(e) => (e.target.value ? signInAsDevUser(e.target.value).catch(report) : signOut())}
                aria-label="Signed in as"
              >
                <option value="">Signed out</option>
                {session.devUsers.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} · {u.roles.join(", ")}
                  </option>
                ))}
              </select>
            </label>
          )}
          {principal && !session?.devUsers.length && (
            <button className="ghost signout" onClick={() => void signOut().catch(report)} title={principal.displayName ?? principal.id}>
              Sign out
            </button>
          )}
          <ThemeToggle />
          {session?.dashboard && (
            <a className="dashboard-link" href={session.dashboard} target="_blank" rel="noreferrer">
              Dashboard ↗
            </a>
          )}
        </div>
      </header>

      {notice && (
        <div className={`notice ${notice.tone}`} role="status">
          {notice.text}
          <button className="ghost" onClick={() => setNotice(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      {!session ? (
        <div className="center muted">Connecting…</div>
      ) : resetToken ? (
        <div className="center">
          <div className="card narrow">
            <ResetForm token={resetToken} onDone={() => (setResetToken(null), setNotice({ tone: "info", text: "Your password is set. Other sessions were signed out." }))} />
          </div>
        </div>
      ) : !principal ? (
        <SignedOut
          devUsers={session.devUsers}
          accounts={session.accounts ?? null}
          onDevSignIn={(id) => signInAsDevUser(id).catch(report)}
          onSignIn={signIn}
          onSignUp={signUp}
        />
      ) : (
        <Workspace onError={report} onInfo={(text) => setNotice({ tone: "info", text })} />
      )}

      {session && !session.environment.production && (
        <footer className="footer">
          Every brief, person, piece of evidence, consent and introduction lives in this app’s FeltDB instance. Switch identity in the header to act as the other side of an introduction.
        </footer>
      )}
    </div>
  );
}

function SignedOut(props: {
  devUsers: Array<{ id: string; name: string; roles: string[] }>;
  accounts: { signUp: boolean; email?: boolean; providers?: Array<{ id: string; name: string }> } | null;
  onDevSignIn: (id: string) => void;
  onSignIn: (input: { email: string; password: string }) => Promise<void>;
  onSignUp: (input: { email: string; password: string; name?: string }) => Promise<void>;
}) {
  return (
    <div className="center">
      <div className="card narrow">
        {props.devUsers.length ? (
          <>
            <h1>Sign in</h1>
            <p className="muted">Development identities from feltkit/app.ts:</p>
            <div className="stack">
              {props.devUsers.map((u) => (
                <button key={u.id} className="secondary wide" onClick={() => props.onDevSignIn(u.id)}>
                  {u.name} <span className="muted">· {u.roles.join(", ")}</span>
                </button>
              ))}
            </div>
          </>
        ) : props.accounts ? (
          <AccountForm signUpOpen={props.accounts.signUp} email={Boolean(props.accounts.email)} providers={props.accounts.providers ?? []} onSignIn={props.onSignIn} onSignUp={props.onSignUp} />
        ) : (
          <SessionForm />
        )}
      </div>
    </div>
  );
}

/**
 * No dev users and no accounts: access is given by whoever operates the deployment (on AppBoundry,
 * `appboundry admin sessions issue --user <id>`). The session they hand over is pasted here; the
 * server decides whether it is valid, and what it may do.
 */
function SessionForm() {
  const client = useFeltKit();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      client.setToken(token.trim());
      const session = await client.session();
      if (!session.principal) {
        client.setToken(null);
        setError("That session isn't valid, or it has expired or been revoked. Ask your operator for a new one.");
      }
    } catch (err) {
      client.setToken(null);
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="stack" onSubmit={submit}>
      <h1>Sign in</h1>
      <p className="muted">Access to this app is given by its operator. Paste the session they issued you.</p>
      <label className="field">
        <span>Session</span>
        <input type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} placeholder="abs_…" required autoFocus />
      </label>
      {error && <p className="error-text" role="alert">{error}</p>}
      <button className="wide" type="submit" disabled={busy || !token.trim()}>{busy ? "Signing in…" : "Sign in"}</button>
    </form>
  );
}

/** Sign in to an existing account, or create one (auth.accounts in feltkit/app.ts). */
function AccountForm(props: {
  signUpOpen: boolean;
  /** The app sends account e-mail (auth.accounts.email): offer "forgot password". */
  email: boolean;
  providers: Array<{ id: string; name: string }>;
  onSignIn: (input: { email: string; password: string }) => Promise<void>;
  onSignUp: (input: { email: string; password: string; name?: string }) => Promise<void>;
}) {
  const client = useFeltKit();
  const [mode, setMode] = useState<"signin" | "signup" | "forgot">("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const creating = mode === "signup";
  const forgot = mode === "forgot";
  const go = (next: typeof mode) => (setMode(next), setError(null), setInfo(null));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      if (forgot) setInfo((await client.requestPasswordReset(email)).message);
      else if (creating) {
        await props.onSignUp({ email, password, ...(name.trim() ? { name: name.trim() } : {}) });
        if (!client.tokens.get()) setInfo("Check your e-mail: open the link we sent to verify your address, then sign in.");
      } else await props.onSignIn({ email, password });
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="stack" onSubmit={submit}>
      <h1>{forgot ? "Reset your password" : creating ? "Create your account" : "Sign in"}</h1>
      {!forgot &&
        props.providers.map((p) => (
          <button key={p.id} type="button" className="secondary wide" onClick={() => client.signInWith(p.id)}>
            Continue with {p.name}
          </button>
        ))}
      {!forgot && props.providers.length > 0 && <p className="muted small-text">or with your e-mail address</p>}
      {creating && <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" aria-label="Name" autoComplete="name" />}
      <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="E-mail" aria-label="E-mail" autoComplete="email" required />
      {!forgot && (
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={creating ? "Password (12+ characters)" : "Password"}
          aria-label="Password"
          autoComplete={creating ? "new-password" : "current-password"}
          minLength={creating ? 12 : undefined}
          required
        />
      )}
      {error && <p className="error-text">{error}</p>}
      {info && <p className="muted">{info}</p>}
      <button type="submit" disabled={busy || !email || (!forgot && !password)}>
        {busy ? "One moment…" : forgot ? "Send reset link" : creating ? "Create account" : "Sign in"}
      </button>
      {mode === "signin" && props.email && (
        <p className="muted small-text">
          <button type="button" className="link" onClick={() => go("forgot")}>
            Forgot your password?
          </button>
        </p>
      )}
      {(props.signUpOpen || forgot) && (
        <p className="muted small-text">
          {forgot ? "Remembered it? " : creating ? "Already have an account? " : "New here? "}
          <button type="button" className="link" onClick={() => go(creating || forgot ? "signin" : "signup")}>
            {creating || forgot ? "Sign in" : "Create an account"}
          </button>
        </p>
      )}
    </form>
  );
}

/** A password reset link opened: choose a new password. */
function ResetForm({ token, onDone }: { token: string; onDone: () => void }) {
  const client = useFeltKit();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await client.resetPassword(token, password);
      onDone();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="stack" onSubmit={submit}>
      <h1>Choose a new password</h1>
      <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="New password (12+ characters)" aria-label="New password" autoComplete="new-password" minLength={12} required />
      {error && <p className="error-text">{error}</p>}
      <button type="submit" disabled={busy || !password}>
        {busy ? "One moment…" : "Set password and sign in"}
      </button>
    </form>
  );
}
