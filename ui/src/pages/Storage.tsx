import { useState } from "react";
import { RetentionSettingsForm } from "../components/RetentionSettings";
import { StorageSettingsForm } from "../components/StorageSettings";

type Tab = "overview" | "archives" | "settings";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "archives", label: "Archives" },
  { id: "settings", label: "Settings" },
];

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
        {tab === "overview" && <p className="muted">Coming in this release</p>}
        {tab === "archives" && <p className="muted">Coming in this release</p>}
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
