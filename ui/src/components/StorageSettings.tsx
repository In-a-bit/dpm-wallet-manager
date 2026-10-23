import { useEffect, useState, type FormEvent } from "react";
import { api, errorMessage, type StoragePatch } from "../api";
import { useLoad } from "../hooks";
import { useSession } from "../session";
import { Field } from "./Field";
import { SourceBadge } from "./RetentionSettings";
import { LoadState } from "./Status";
import { useToast } from "./Toasts";

type NumKey = "warningPercent" | "warningDays" | "criticalPercent" | "criticalDays";

const NUM_FIELDS: { key: NumKey; label: string; hint: string }[] = [
  { key: "warningPercent", label: "Warning at disk used, %", hint: "1 to 99, below the critical percent." },
  { key: "criticalPercent", label: "Critical at disk used, %", hint: "1 to 99." },
  { key: "warningDays", label: "Warning at days of disk left", hint: "1 to 365, above the critical days." },
  { key: "criticalDays", label: "Critical at days of disk left", hint: "1 to 365." },
];

/** Disk thresholds and the alert webhook. Owners edit. */
export function StorageSettingsForm() {
  const { session } = useSession();
  const canEdit = session.user.role === "owner";
  const toast = useToast();
  const load = useLoad(() => api.getStorageSettings(), "storage-settings");
  const [form, setForm] = useState<Record<NumKey, string>>({ warningPercent: "", warningDays: "", criticalPercent: "", criticalDays: "" });
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const current = load.data;
  useEffect(() => {
    if (!current) return;
    setForm({
      warningPercent: String(current.warningPercent),
      warningDays: String(current.warningDays),
      criticalPercent: String(current.criticalPercent),
      criticalDays: String(current.criticalDays),
    });
    setUrl(current.alertWebhookUrl ?? "");
  }, [current]);

  const dirty =
    !!current &&
    (NUM_FIELDS.some(({ key }) => form[key] !== String(current[key])) || url.trim() !== (current.alertWebhookUrl ?? ""));

  const save = async (patch: StoragePatch) => {
    setBusy(true);
    setError(null);
    try {
      await api.updateStorageSettings(patch);
      toast.ok("Storage settings saved.");
      load.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!current) return;
    const patch: StoragePatch = {};
    for (const { key } of NUM_FIELDS) {
      const n = Number(form[key]);
      if (form[key].trim() === "" || !Number.isInteger(n)) {
        setError("Thresholds must be whole numbers.");
        return;
      }
      if (n !== current[key]) patch[key] = n;
    }
    const trimmed = url.trim();
    if (trimmed !== (current.alertWebhookUrl ?? "")) patch.alertWebhookUrl = trimmed === "" ? null : trimmed;
    if (Object.keys(patch).length === 0) {
      toast.ok("Nothing to save.");
      return;
    }
    void save(patch);
  };

  return (
    <form onSubmit={submit} style={{ display: "grid", gap: 12, maxWidth: 520, marginTop: 24 }}>
      <h2>Storage alerts</h2>
      <LoadState loading={load.loading && !current} error={load.error} onRetry={load.reload} />
      {current && (
        <fieldset disabled={!canEdit || busy} style={{ display: "grid", gap: 12 }}>
          {NUM_FIELDS.map(({ key, label, hint }) => (
            <Field key={key} label={label} hint={hint}>
              <input
                type="number"
                step={1}
                value={form[key]}
                onChange={(e) => setForm({ ...form, [key]: e.target.value })}
              />
              <SourceBadge source={current.sources[key]} onReset={() => void save({ [key]: null })} disabled={!canEdit || dirty} />
            </Field>
          ))}
          <Field label="Alert webhook URL" hint={canEdit ? "An http or https URL; leave empty for none." : "Shown masked; only owners see the full URL."}>
            <input type={canEdit ? "url" : "text"} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />
            <SourceBadge source={current.sources.alertWebhookUrl} onReset={() => void save({ alertWebhookUrl: null })} disabled={!canEdit || dirty} />
          </Field>
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
            Save storage settings
          </button>
        </div>
      )}
    </form>
  );
}
