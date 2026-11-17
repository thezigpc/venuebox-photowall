// The sign-in in front of the staff pages (/host and /admin). Staff who come from the venue
// box's admin are signed in by the box (staffSignIn); otherwise the box's admin password works,
// or standalone the app's own password (first-run setup sets it).

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { staffSignIn } from "@bargames/gamekit/client";
import { basePath } from "@bargames/sdk/client";
import { api, ApiError, getToken, setToken, type AuthStatus } from "./api";

type Phase = { kind: "loading" } | { kind: "auth"; status: AuthStatus } | { kind: "ready" } | { kind: "offline"; message: string };

function AuthForm({ title, status, onDone }: { title: string; status: AuthStatus; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [wantSetup, setWantSetup] = useState(false);
  const setup = status.venueLogin ? wantSetup && status.setupAllowed : status.setupNeeded;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (setup && password !== confirm) return setError("The passwords don't match.");
    setBusy(true);
    try {
      const r = setup ? await api.setup(password) : await api.login(password);
      setToken(r.token);
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && status.venueLogin) setError("That isn't the venue box's admin password.");
      else setError(err instanceof Error ? err.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  };

  if (status.broken && !status.venueLogin) {
    return (
      <div className="auth card">
        <h1>{title}</h1>
        <p className="error">The admin password file on the server is damaged. Ask whoever runs the server to fix or delete admin.json in the data folder.</p>
      </div>
    );
  }
  return (
    <form className="auth card" onSubmit={submit}>
      <h1>{title}</h1>
      <p className="muted">
        {setup
          ? status.venueLogin
            ? `Choose a separate staff password for the photo wall (the box's admin password keeps working too). At least ${status.minPasswordLength} characters.`
            : `Choose the staff password. Whoever sets it first runs the photo wall, so do this now. At least ${status.minPasswordLength} characters.`
          : status.venueLogin
            ? `Staff only. Sign in with the venue box's admin password${status.configured ? " (or the photo wall's own)" : ""}.`
            : "Staff only. Sign in to look after the photo wall."}
      </p>
      <label>
        Password
        <input type="password" maxLength={200} autoComplete={setup ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} autoFocus required />
      </label>
      {setup && (
        <label>
          Password again
          <input type="password" maxLength={200} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </label>
      )}
      {error && <p className="error">{error}</p>}
      <button className="primary" disabled={busy || !password}>
        {setup ? "Set password" : "Sign in"}
      </button>
      {status.venueLogin && status.setupAllowed && (
        <button
          type="button"
          className="link"
          onClick={() => {
            setWantSetup((v) => !v);
            setError("");
          }}
        >
          {wantSetup ? "Sign in with the box's password instead" : "Set a separate photo wall password"}
        </button>
      )}
    </form>
  );
}

export interface Staff {
  /** Call on a 401: back to the sign-in. */
  expired: () => void;
  signOut: () => Promise<void>;
}

export function StaffGate({ title, children }: { title: string; children: (staff: Staff) => ReactNode }) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  const check = useCallback(async () => {
    try {
      const status = await api.status();
      if (status.authenticated && getToken()) return void setPhase({ kind: "ready" });
      // Staff who opened this page from the venue box's admin don't need a password.
      // Resolves undefined standalone (and for everyone else), so the form shows.
      const staffToken = await staffSignIn(basePath());
      if (staffToken) {
        setToken(staffToken);
        return void setPhase({ kind: "ready" });
      }
      setToken("");
      setPhase({ kind: "auth", status });
    } catch (err) {
      setPhase({ kind: "offline", message: err instanceof Error ? err.message : "Can't reach the server." });
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  const staff = useMemo<Staff>(
    () => ({
      expired: () => void check(),
      signOut: async () => {
        await api.logout().catch(() => undefined);
        setToken("");
        void check();
      },
    }),
    [check],
  );

  if (phase.kind === "loading") return <p className="muted center">Loading…</p>;
  if (phase.kind === "offline")
    return (
      <div className="auth card">
        <h1>{title}</h1>
        <p className="error">{phase.message}</p>
        <button onClick={() => void check()}>Try again</button>
      </div>
    );
  if (phase.kind === "auth") return <AuthForm title={title} status={phase.status} onDone={() => void check()} />;
  return <>{children(staff)}</>;
}
