import { useState } from "react";
import { api, archiveDownloadUrl, errorMessage, type Archive } from "../api";
import { Confirm } from "./Confirm";
import { Field } from "./Field";
import { useToast } from "./Toasts";

export const isOpen = (a: Archive) => a.status === "pending" || a.status === "downloaded" || a.status === "deleting";

const DAY_MS = 86_400_000;
const toDateInput = (d: Date) => d.toISOString().slice(0, 10);
const NOTE = "Keep the file somewhere safe, off this machine.";

function Counts({ counts }: { counts: Record<string, number> }) {
  return (
    <ul>
      {Object.entries(counts).map(([t, n]) => (
        <li key={t}>
          <code>{t}</code>: {n} rows
        </li>
      ))}
    </ul>
  );
}

/** Start the browser download; the session cookie authenticates the plain navigation. */
function startDownload(id: string) {
  const a = document.createElement("a");
  a.href = archiveDownloadUrl(id);
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Preview, create and download an archive, then remove its records on confirmation. The open
 * archive (pending, downloaded or deleting) comes from the parent's polled list.
 */
export function ArchiveWizard({
  open,
  loaded,
  reminderDays,
  onChanged,
}: {
  open: Archive | null;
  loaded: boolean;
  reminderDays: number;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [date, setDate] = useState(() => toDateInput(new Date(Date.now() - reminderDays * DAY_MS)));
  const [edited, setEdited] = useState(false);
  const [preview, setPreview] = useState<Record<string, number> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [code, setCode] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // The reminder loads after first render; follow it until the owner picks a date.
  const shownDate = edited ? date : toDateInput(new Date(Date.now() - reminderDays * DAY_MS));
  const before = `${shownDate}T00:00:00.000Z`;
  const maxDate = toDateInput(new Date(Date.now() - 2 * DAY_MS));

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const doPreview = () =>
    run(async () => {
      setPreview((await api.previewArchive(before)).tables);
    });

  const doCreate = () =>
    run(async () => {
      const created = await api.createArchive(before);
      startDownload(created.id);
      setPreview(null);
      toast.ok(`Archive ${created.code} created. The download has started.`);
      onChanged();
    });

  const total = (c: Record<string, number>) => Object.values(c).reduce((x, y) => x + y, 0);

  const counts = open ? Object.fromEntries(Object.entries(open.scope).map(([t, v]) => [t, v.rows])) : {};

  const doDelete = async () => {
    if (!open) return;
    setDeleteError(null);
    try {
      await api.deleteArchive(open.id, code.trim());
      setConfirmDelete(false);
      setCode("");
      onChanged();
    } catch (e) {
      setDeleteError(
        `${errorMessage(e)}${/SCOPE_CHANGED|scope/i.test(errorMessage(e)) ? " Cancel this archive and create a new one." : ""}`,
      );
    }
  };

  const doCancel = async () => {
    if (!open) return;
    try {
      await api.cancelArchive(open.id);
      toast.ok("Archive cancelled. Nothing was deleted.");
    } catch (e) {
      toast.bad(errorMessage(e));
    } finally {
      setConfirmCancel(false);
      onChanged();
    }
  };

  return (
    <section style={{ display: "grid", gap: 12, maxWidth: 640 }}>
      <h2>Archive important records</h2>
      <p className="muted">
        Withdrawals and audit events that retention never trims can be saved to a file and then removed from the
        database. {NOTE}
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!loaded && <p className="muted">Loading…</p>}

      {loaded && !open && (
        <>
          <Field label="Archive records older than" hint={`Defaults to ${reminderDays} days ago. At least one day old.`}>
            <input
              type="date"
              value={shownDate}
              max={maxDate}
              onChange={(e) => {
                setDate(e.target.value);
                setEdited(true);
                setPreview(null);
              }}
            />
          </Field>
          <div className="row-actions">
            <button type="button" disabled={busy || !shownDate} onClick={doPreview}>
              Preview
            </button>
            {preview && (
              <button type="button" className="primary" disabled={busy || total(preview) === 0} onClick={doCreate}>
                Create and download
              </button>
            )}
          </div>
          {preview && (
            <div>
              <p>{total(preview) === 0 ? "Nothing to archive before this date." : "This archive would cover:"}</p>
              <Counts counts={preview} />
            </div>
          )}
        </>
      )}

      {open && (
        <div className="panel" style={{ display: "grid", gap: 8 }}>
          <p>
            Archive <strong>{open.code}</strong> for records before {open.before.slice(0, 10)} is{" "}
            <strong>{open.status}</strong>.
          </p>
          <Counts counts={counts} />
          {open.status === "pending" && (
            <>
              <p className="muted">Waiting for the download to finish. If it did not start or broke off, download it again.</p>
              <div className="row-actions">
                <button type="button" className="primary" onClick={() => startDownload(open.id)}>
                  Download again
                </button>
                <button type="button" onClick={() => setConfirmCancel(true)}>
                  Cancel archive
                </button>
              </div>
            </>
          )}
          {open.status === "downloaded" && (
            <div className="row-actions">
              <button type="button" className="danger" onClick={() => setConfirmDelete(true)}>
                Remove archived records from the database
              </button>
              <button type="button" onClick={() => startDownload(open.id)}>
                Download again
              </button>
              <button type="button" onClick={() => setConfirmCancel(true)}>
                Cancel archive
              </button>
            </div>
          )}
          {open.status === "deleting" && (
            <p role="status">
              Removing records… {open.deleted ? `${total(open.deleted)} of ${total(counts)} rows so far. ` : ""}
              This can take a few minutes; the status updates here.
            </p>
          )}
        </div>
      )}

      {confirmDelete && open && (
        <Confirm
          title="Remove archived records?"
          confirmLabel="Remove records"
          danger
          onConfirm={doDelete}
          onClose={() => {
            setConfirmDelete(false);
            setDeleteError(null);
          }}
        >
          <p>These rows will be deleted from the database:</p>
          <Counts counts={counts} />
          <p>Postgres reuses the freed space for new records; it does not return it to the disk.</p>
          <p>{NOTE}</p>
          <Field label="Code" hint="The 6 characters at the end of the downloaded file name, before .ndjson.gz.">
            <input value={code} maxLength={6} autoFocus onChange={(e) => setCode(e.target.value)} />
          </Field>
          {deleteError && (
            <p className="error" role="alert">
              {deleteError}
            </p>
          )}
        </Confirm>
      )}
      {confirmCancel && open && (
        <Confirm title="Cancel this archive?" confirmLabel="Cancel archive" onConfirm={doCancel} onClose={() => setConfirmCancel(false)}>
          <p>Nothing will be deleted. The archive stays in the history as cancelled and you can create a new one.</p>
        </Confirm>
      )}
    </section>
  );
}
