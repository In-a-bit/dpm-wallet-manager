import { useState, type FormEvent } from "react";
import { api, errorMessage, type ApiKey, type ApiRole, type MintedApiKey } from "../api";
import { Confirm } from "../components/Confirm";
import { Field } from "../components/Field";
import { Modal } from "../components/Modal";
import { SecretModal } from "../components/SecretModal";
import { Badge, LoadState, StatusBadge } from "../components/Status";
import { useToast } from "../components/Toasts";
import { formatTime, shortId } from "../format";
import { useLoad } from "../hooks";

const ROLE_INFO: Record<ApiRole, string> = {
  admin: "Full control: manages keys and platform setup, and can do everything an operator can.",
  operator: "For your backend: creates wallets, signs orders and on-chain actions.",
  readonly: "Can look but not touch: reads wallets, operations and audit events.",
};

const GRACE_OPTIONS: { label: string; seconds: number }[] = [
  { label: "Immediately", seconds: 0 },
  { label: "After 1 hour", seconds: 3600 },
  { label: "After 1 day", seconds: 86400 },
  { label: "After 7 days", seconds: 604800 },
];

type Dialog =
  | { kind: "create" }
  | { kind: "secret"; title: string; minted: MintedApiKey }
  | { kind: "reveal" | "rotate" | "revoke"; key: ApiKey };

function CreateKeyModal({ onClose, onCreated }: { onClose: () => void; onCreated: (m: MintedApiKey) => void }) {
  const [role, setRole] = useState<ApiRole>("operator");
  const [name, setName] = useState("");
  const [expires, setExpires] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // A date picks the end of that day in local time.
      const expiresAt = expires ? new Date(`${expires}T23:59:59`).toISOString() : undefined;
      onCreated(await api.createKey({ role, name: name.trim(), expiresAt }));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Modal title="Create API key" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <fieldset>
          <legend>Role</legend>
          {(Object.keys(ROLE_INFO) as ApiRole[]).map((r) => (
            <label key={r} className="choice">
              <input type="radio" name="role" value={r} checked={role === r} onChange={() => setRole(r)} />
              <span>
                <strong>{r}</strong>
                <span className="muted small-text"> — {ROLE_INFO[r]}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <Field label="Name" hint="Something that says who uses it, e.g. “backend-prod”.">
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
        </Field>
        <Field label="Expires (optional)" hint="Leave blank for a key that does not expire.">
          <input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
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
          <button type="submit" className="primary" disabled={busy || !name.trim()}>
            {busy ? "Creating…" : "Create key"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RotateModal({ apiKey, onClose, onRotated }: { apiKey: ApiKey; onClose: () => void; onRotated: (m: MintedApiKey) => void }) {
  const [grace, setGrace] = useState(604800);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      onRotated((await api.rotateKey(apiKey.id, grace)).created);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Rotate “${apiKey.name}”`}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary" disabled={busy} onClick={run}>
            {busy ? "Rotating…" : "Rotate key"}
          </button>
        </>
      }
    >
      <p>A new key with the same role is created. The old key keeps working for the grace period, then stops.</p>
      <Field label="Old key stops working">
        <select value={grace} onChange={(e) => setGrace(Number(e.target.value))}>
          {GRACE_OPTIONS.map((g) => (
            <option key={g.seconds} value={g.seconds}>
              {g.label}
            </option>
          ))}
        </select>
      </Field>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}

export function ApiKeysPage() {
  const toast = useToast();
  const { data, error, loading, reload } = useLoad(() => api.listKeys(), "keys");
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const close = () => setDialog(null);

  const showSecret = (title: string, minted: MintedApiKey) => {
    setDialog({ kind: "secret", title, minted });
    reload();
  };

  return (
    <>
      <div className="page-head">
        <h1>API keys</h1>
        <button type="button" className="primary" onClick={() => setDialog({ kind: "create" })}>
          Create key
        </button>
      </div>
      <div className="table-wrap panel">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
              <th>Prefix</th>
              <th>Status</th>
              <th>Expires</th>
              <th>Last used</th>
              <th>Created</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((k) => {
              const revoked = k.status === "revoked";
              return (
                <tr key={k.id} className={revoked ? "dim" : undefined}>
                  <td>
                    <div>{k.name}</div>
                    {k.rotatedFromId && (
                      <div className="muted small-text">
                        rotated from <code title={k.rotatedFromId}>{shortId(k.rotatedFromId)}</code>
                      </div>
                    )}
                  </td>
                  <td>
                    <Badge tone={k.role === "admin" ? "accent" : "neutral"}>{k.role}</Badge>
                  </td>
                  <td>
                    <code>{k.prefix}</code>
                  </td>
                  <td className="nowrap">
                    <StatusBadge value={k.status} />
                    {revoked && <div className="muted small-text">{formatTime(k.revokedAt)}</div>}
                  </td>
                  <td className="nowrap">{k.expiresAt ? formatTime(k.expiresAt) : "Never"}</td>
                  <td className="nowrap">{formatTime(k.lastUsedAt)}</td>
                  <td className="nowrap">{formatTime(k.createdAt)}</td>
                  <td>
                    {!revoked && (
                      <div className="row-actions">
                        <button type="button" className="small" onClick={() => setDialog({ kind: "reveal", key: k })}>
                          Reveal
                        </button>
                        <button type="button" className="small" onClick={() => setDialog({ kind: "rotate", key: k })}>
                          Rotate
                        </button>
                        <button type="button" className="small danger" onClick={() => setDialog({ kind: "revoke", key: k })}>
                          Revoke
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <LoadState loading={loading && !data} error={error} empty={data?.items.length === 0} onRetry={reload} />
      </div>

      {dialog?.kind === "create" && <CreateKeyModal onClose={close} onCreated={(m) => showSecret("Your new API key", m)} />}
      {dialog?.kind === "secret" && <SecretModal title={dialog.title} minted={dialog.minted} onClose={close} />}
      {dialog?.kind === "rotate" && (
        <RotateModal apiKey={dialog.key} onClose={close} onRotated={(m) => showSecret("Your replacement API key", m)} />
      )}
      {dialog?.kind === "reveal" && (
        <Confirm
          title={`Reveal “${dialog.key.name}”?`}
          confirmLabel="Reveal key"
          onClose={close}
          onConfirm={async () => {
            try {
              showSecret("API key", await api.revealKey(dialog.key.id));
            } catch (err) {
              toast.bad(errorMessage(err));
            }
          }}
        >
          <p>The full key will be shown on screen. Reveals are recorded in the audit log and rate-limited.</p>
        </Confirm>
      )}
      {dialog?.kind === "revoke" && (
        <Confirm
          title={`Revoke “${dialog.key.name}”?`}
          confirmLabel="Revoke key"
          danger
          onClose={close}
          onConfirm={async () => {
            try {
              await api.revokeKey(dialog.key.id);
              toast.ok(`Key “${dialog.key.name}” revoked.`);
              close();
              reload();
            } catch (err) {
              toast.bad(errorMessage(err));
            }
          }}
        >
          <p>Anything using this key stops working immediately. This cannot be undone.</p>
        </Confirm>
      )}
    </>
  );
}
