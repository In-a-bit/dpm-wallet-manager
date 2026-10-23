import { useEffect, useState, type FormEvent } from "react";
import { api, errorMessage, type RetentionPatch, type SettingSource } from "../api";
import { useLoad } from "../hooks";
import { useSession } from "../session";
import { Confirm } from "./Confirm";
import { Field } from "./Field";
import { LoadState } from "./Status";
import { useToast } from "./Toasts";

const SOURCE_LABEL: Record<SettingSource, string> = {
  default: "default",
  environment: "from environment",
  dashboard: "set here",
};

/** Where a value comes from, with a reset link when the dashboard is overriding it. */
export function SourceBadge({ source, onReset, disabled }: { source: SettingSource; onReset: () => void; disabled: boolean }) {
  return (
    <span className="row-actions">
      <span className={`badge${source === "dashboard" ? " badge-accent" : ""}`}>{SOURCE_LABEL[source]}</span>
      {source === "dashboard" && !disabled && (
        <button type="button" className="link" onClick={onReset}>
          reset
        </button>
      )}
    </span>
  );
}

type Key = "routineDays" | "routedOrderDays" | "archiveReminderDays";

const DAY_FIELDS: { key: Key; label: string; hint: string }[] = [
  { key: "routineDays", label: "Routine records, days", hint: "Routine records older than this are deleted." },
  { key: "routedOrderDays", label: "Routed orders, days", hint: "Not below the routine days." },
  { key: "archiveReminderDays", label: "Archive reminder, days", hint: "Important records older than this suggest an archive." },
];

/** Whether retention trimming is on and how long each kind of record is kept. Owners edit. */
export function RetentionSettingsForm() {
  const { session } = useSession();
  const canEdit = session.user.role === "owner";
  const toast = useToast();
  const load = useLoad(() => api.getRetentionSettings(), "retention-settings");
  const [form, setForm] = useState<Record<Key, string>>({ routineDays: "", routedOrderDays: "", archiveReminderDays: "" });
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<RetentionPatch | null>(null);
  const [busy, setBusy] = useState(false);

  const current = load.data;
  useEffect(() => {
    if (!current) return;
    setForm({
      routineDays: String(current.routineDays),
      routedOrderDays: String(current.routedOrderDays),
      archiveReminderDays: String(current.archiveReminderDays),
    });
    setEnabled(current.enabled);
  }, [current]);

  const save = async (patch: RetentionPatch) => {
    setBusy(true);
    setError(null);
    try {
      await api.updateRetentionSettings(patch);
      toast.ok("Retention settings saved.");
      load.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!current) return;
    const patch: RetentionPatch = {};
    if (enabled !== current.enabled) patch.enabled = enabled;
    for (const { key } of DAY_FIELDS) {
      const n = Number(form[key]);
      if (form[key].trim() === "" || !Number.isInteger(n)) {
        setError("Days must be whole numbers.");
        return;
      }
      if (n !== current[key]) patch[key] = n;
    }
    if (Object.keys(patch).length === 0) {
      toast.ok("Nothing to save.");
      return;
    }
    setError(null);
    if (patch.routineDays !== undefined && patch.routineDays !== null && patch.routineDays < current.routineDays) {
      setPending(patch);
      return;
    }
    void save(patch);
  };

  const resetKey = (key: Key | "enabled") => void save({ [key]: null });

  return (
    <form onSubmit={submit} className="settings-group" style={{ display: "grid", gap: 12, maxWidth: 520 }}>
      <h2>Retention</h2>
      <LoadState loading={load.loading && !current} error={load.error} onRetry={load.reload} />
      {current && (
        <fieldset disabled={!canEdit || busy} style={{ display: "grid", gap: 12 }}>
          <label className="field">
            <span className="field-label">Automatic trimming</span>
            <span className="row-actions">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled
              <SourceBadge source={current.sources.enabled} onReset={() => resetKey("enabled")} disabled={!canEdit} />
            </span>
          </label>
          {DAY_FIELDS.map(({ key, label, hint }) => (
            <Field key={key} label={label} hint={hint}>
              <input
                type="number"
                min={1}
                max={3650}
                step={1}
                value={form[key]}
                onChange={(e) => setForm({ ...form, [key]: e.target.value })}
              />
              <SourceBadge source={current.sources[key]} onReset={() => resetKey(key)} disabled={!canEdit} />
            </Field>
          ))}
          <dl className="muted">
            <dt>Idempotency records</dt>
            <dd>{current.fixed.idempotencyHours} hours (fixed)</dd>
            <dt>Container logs</dt>
            <dd>{current.fixed.logs} (fixed)</dd>
          </dl>
        </fieldset>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!canEdit && <p className="muted">Only owners can change these settings.</p>}
      {canEdit && current && (
        <div>
          <button type="submit" className="primary" disabled={busy}>
            Save retention
          </button>
        </div>
      )}
      {pending && current && (
        <Confirm
          title="Shorten routine retention?"
          confirmLabel="Shorten"
          danger
          onConfirm={() => save(pending)}
          onClose={() => setPending(null)}
        >
          <p>Records older than {pending.routineDays} days will be deleted within the hour.</p>
        </Confirm>
      )}
    </form>
  );
}
