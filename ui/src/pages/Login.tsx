import { useState, type FormEvent } from "react";
import { api, ApiError, errorMessage, type SessionDto } from "../api";
import { Field } from "../components/Field";

interface Props {
  notice?: string;
  onSignedIn: (s: SessionDto) => void;
}

export function LoginPage({ notice, onSignedIn }: Props) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await api.login(username.trim(), password));
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? "Wrong username or password." : errorMessage(err));
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="panel login" onSubmit={submit}>
        <h1>DPM Wallet Manager</h1>
        <p className="muted">Sign in to the admin console.</p>
        {notice && !error && <p className="notice">{notice}</p>}
        <Field label="Username">
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required autoFocus />
        </Field>
        <Field label="Password">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </Field>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary wide" disabled={busy || !username || !password}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
