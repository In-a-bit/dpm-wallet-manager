import { useEffect, useState } from "react";
import { api, type Archive } from "../api";
import { ArchiveHistory } from "../components/ArchiveHistory";
import { ArchiveWizard, isOpen } from "../components/ArchiveWizard";
import { useLoad } from "../hooks";
import { useSession } from "../session";
import { LoadState } from "../components/Status";
import { RetentionSettingsForm } from "../components/RetentionSettings";
import { StorageOverview } from "../components/StorageOverview";
import { StorageSettingsForm } from "../components/StorageSettings";

type Tab = "overview" | "archives" | "settings";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "archives", label: "Archives" },
  { id: "settings", label: "Settings" },
];

const LIMIT = 20;
const POLL_MS = 3000;

/** The wizard (owners) above the paged history; one list load feeds both and polls while busy. */
function ArchivesTab() {
  const { session } = useSession();
  const isOwner = session.user.role === "owner";
  const [offset, setOffset] = useState(0);
  const first = useLoad(() => api.listArchives({ limit: 1, offset: 0 }), "archives-open");
  const page = useLoad(() => api.listArchives({ limit: LIMIT, offset }), `archives-${offset}`);
  const reminder = useLoad(() => api.getRetentionSettings(), "archives-retention");
  // At most one archive is open and it is the newest, so the first row is all the wizard needs.
  const open: Archive | null = first.data?.items[0] && isOpen(first.data.items[0]) ? first.data.items[0] : null;
  const polling = open?.status === "pending" || open?.status === "deleting";
  const { reload: reloadFirst } = first;
  const { reload: reloadPage } = page;
  const refresh = () => {
    reloadFirst();
    reloadPage();
  };
  useEffect(() => {
    if (!polling) return;
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
    // refresh only calls stable reload callbacks
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polling, reloadFirst, reloadPage]);

  return (
    <div style={{ display: "grid", gap: 24 }}>
      {isOwner && (
        <ArchiveWizard
          open={open}
          loaded={!!first.data}
          reminderDays={reminder.data?.archiveReminderDays ?? 90}
          onChanged={refresh}
        />
      )}
      <LoadState loading={page.loading && !page.data} error={page.error} onRetry={page.reload} />
      {page.data && <ArchiveHistory page={page.data} onOffset={setOffset} />}
    </div>
  );
}

/** Storage: how full the install is, the archives of important records, and the thresholds. */
export function StoragePage() {
  const [tab, setTab] = useState<Tab>("overview");
  return (
    <>
      <h1>Storage</h1>
      <div className="tabs" role="tablist" aria-label="Storage">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="panel" role="tabpanel">
        {tab === "overview" && <StorageOverview />}
        {tab === "archives" && <ArchivesTab />}
        {tab === "settings" && (
          <>
            <RetentionSettingsForm />
            <StorageSettingsForm />
          </>
        )}
      </div>
    </>
  );
}
