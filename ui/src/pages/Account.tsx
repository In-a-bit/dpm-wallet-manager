import { useState, type FormEvent } from "react";
import { api, ApiError, errorMessage } from "../api";
import { Field } from "../components/Field";
import { useToast } from "../components/Toasts";
import { formatTime } from "../format";
import { MIN_PASSWORD, passwordProblem } from "../passwords";
import { ROLE_LABEL, useSession } from "../session";

export function AccountPage() {
  const { session, signOut } = useSession();
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problem = passwordProblem(next, confirm);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      await api.changePassword(current, next);
      toast.ok("Password changed.");
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? "Your current password is wrong." : errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>My account</h1>
      </div>
      <div className="grid">
        <section className="panel card">
          <h2>Profile</h2>
          <dl className="kv">
            <dt>Username</dt>
            <dd>{session.user.username}</dd>
            <dt>Role</dt>
            <dd>
              {ROLE_LABEL[session.user.role]} <span className="muted">(API role {session.actorRole})</span>
            </dd>
            <dt>Session expires</dt>
            <dd>{formatTime(session.expiresAt)}</dd>
          </dl>
          <button type="button" onClick={() => void signOut()}>
            Sign out
          </button>
        </section>
        <section className="panel card">
          <h2>Change password</h2>
          <form className="stack" onSubmit={submit}>
            <Field label="Current password">
              <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
            </Field>
            <Field label="New password" hint={`At least ${MIN_PASSWORD} characters.`}>
              <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required />
            </Field>
            <Field label="Confirm new password">
              <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
            </Field>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div>
              <button type="submit" className="primary" disabled={busy}>
                {busy ? "Saving…" : "Change password"}
              </button>
            </div>
          </form>
        </section>
      </div>
    </>
  );
}
