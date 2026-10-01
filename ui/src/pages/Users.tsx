import { useState, type FormEvent } from "react";
import { api, ApiError, errorMessage, type UiRole, type UiUserDto } from "../api";
import { Confirm } from "../components/Confirm";
import { Field } from "../components/Field";
import { Modal } from "../components/Modal";
import { Badge, LoadState, StatusBadge } from "../components/Status";
import { useToast } from "../components/Toasts";
import { formatTime } from "../format";
import { useLoad } from "../hooks";
import { MIN_PASSWORD, passwordProblem } from "../passwords";
import { ROLE_LABEL, useSession } from "../session";

const ROLES: UiRole[] = ["owner", "operator", "viewer"];

const ROLE_INFO: Record<UiRole, string> = {
  owner: "Everything, including API keys and users.",
  operator: "Day-to-day operations; cannot manage keys or users.",
  viewer: "Read-only.",
};

type Dialog = { kind: "create" } | { kind: "password"; user: UiUserDto } | { kind: "disable"; user: UiUserDto };

/** Turns server errors into text for this page; LAST_OWNER and USERNAME_TAKEN get extra clarity. */
function userError(e: unknown): string {
  if (e instanceof ApiError && e.code === "LAST_OWNER")
    return "This is the last active owner; add another owner first.";
  if (e instanceof ApiError && e.code === "USERNAME_TAKEN") return "That username is already taken.";
  return errorMessage(e);
}

function PasswordFields({ pw, setPw, confirm, setConfirm }: { pw: string; setPw: (v: string) => void; confirm: string; setConfirm: (v: string) => void }) {
  return (
    <>
      <Field label="Password" hint={`At least ${MIN_PASSWORD} characters.`}>
        <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" required />
      </Field>
      <Field label="Confirm password">
        <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
      </Field>
    </>
  );
}

function CreateUserModal({ onClose, onCreated }: { onClose: () => void; onCreated: (u: UiUserDto) => void }) {
  const [username, setUsername] = useState("");
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [role, setRole] = useState<UiRole>("viewer");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problem = passwordProblem(pw, confirm);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      onCreated(await api.createUser({ username: username.trim(), password: pw, role }));
    } catch (err) {
      setError(userError(err));
      setBusy(false);
    }
  };

  return (
    <Modal title="Create user" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label="Username">
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" required />
        </Field>
        <PasswordFields pw={pw} setPw={setPw} confirm={confirm} setConfirm={setConfirm} />
        <Field label="Role" hint={ROLE_INFO[role]}>
          <select value={role} onChange={(e) => setRole(e.target.value as UiRole)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        </Field>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || !username.trim()}>
            {busy ? "Creating…" : "Create user"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function SetPasswordModal({ user, onClose, onDone }: { user: UiUserDto; onClose: () => void; onDone: () => void }) {
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problem = passwordProblem(pw, confirm);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      await api.updateUser(user.id, { password: pw });
      onDone();
    } catch (err) {
      setError(userError(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={`New password for ${user.username}`} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <PasswordFields pw={pw} setPw={setPw} confirm={confirm} setConfirm={setConfirm} />
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "Saving…" : "Set password"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function UsersPage() {
  const toast = useToast();
  const me = useSession().session.user;
  const { data, error, loading, reload } = useLoad(() => api.listUsers(), "users");
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const close = () => setDialog(null);

  const update = async (user: UiUserDto, body: { role?: UiRole; status?: "active" | "disabled" }, done: string) => {
    setPending(user.id);
    setBanner(null);
    try {
      await api.updateUser(user.id, body);
      toast.ok(done);
      reload();
    } catch (err) {
      const msg = userError(err);
      setBanner(msg);
      toast.bad(msg);
    } finally {
      setPending(null);
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>Users</h1>
        <button type="button" className="primary" onClick={() => setDialog({ kind: "create" })}>
          Create user
        </button>
      </div>
      {banner && (
        <p className="banner-bad" role="alert">
          {banner}{" "}
          <button type="button" className="link" onClick={() => setBanner(null)}>
            Dismiss
          </button>
        </p>
      )}
      <div className="table-wrap panel">
        <table>
          <thead>
            <tr>
              <th>Username</th>
              <th>Role</th>
              <th>Status</th>
              <th>Last sign-in</th>
              <th>Created</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((u) => (
              <tr key={u.id} className={u.status === "disabled" ? "dim" : undefined}>
                <td>
                  {u.username}
                  {u.id === me.id && <> <Badge tone="accent">you</Badge></>}
                </td>
                <td>
                  <select
                    aria-label={`Role for ${u.username}`}
                    value={u.role}
                    disabled={pending === u.id}
                    onChange={(e) => {
                      const role = e.target.value as UiRole;
                      void update(u, { role }, `${u.username} is now ${ROLE_LABEL[role]}.`);
                    }}
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABEL[r]}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <StatusBadge value={u.status} />
                </td>
                <td className="nowrap">{formatTime(u.lastLoginAt)}</td>
                <td className="nowrap">{formatTime(u.createdAt)}</td>
                <td>
                  <div className="row-actions">
                    <button type="button" className="small" onClick={() => setDialog({ kind: "password", user: u })}>
                      Set password
                    </button>
                    {u.status === "active" ? (
                      <button
                        type="button"
                        className="small danger"
                        disabled={pending === u.id}
                        onClick={() => setDialog({ kind: "disable", user: u })}
                      >
                        Disable
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="small"
                        disabled={pending === u.id}
                        onClick={() => void update(u, { status: "active" }, `${u.username} enabled.`)}
                      >
                        Enable
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <LoadState loading={loading && !data} error={error} empty={data?.items.length === 0} onRetry={reload} />
      </div>

      {dialog?.kind === "create" && (
        <CreateUserModal
          onClose={close}
          onCreated={(u) => {
            toast.ok(`User ${u.username} created.`);
            close();
            reload();
          }}
        />
      )}
      {dialog?.kind === "password" && (
        <SetPasswordModal
          user={dialog.user}
          onClose={close}
          onDone={() => {
            toast.ok(`Password set for ${dialog.user.username}.`);
            close();
          }}
        />
      )}
      {dialog?.kind === "disable" && (
        <Confirm
          title={`Disable ${dialog.user.username}?`}
          confirmLabel="Disable user"
          danger
          onClose={close}
          onConfirm={async () => {
            close();
            await update(dialog.user, { status: "disabled" }, `${dialog.user.username} disabled.`);
          }}
        >
          <p>They will be signed out and cannot sign in until enabled again.</p>
        </Confirm>
      )}
    </>
  );
}
