import { api } from "../api";
import { formatBytes, formatTime } from "../format";
import { useLoad } from "../hooks";
import { Badge, LoadState } from "./Status";

const LEVEL_TONE = { ok: "ok", warning: "warn", critical: "bad" } as const;

/** Storage Overview: the disk gauge, database and table sizes, growth and days to full. */
export function StorageOverview() {
  const load = useLoad(() => api.getStorage(), "storage");
  const s = load.data;
  return (
    <>
      <p>
        <button type="button" onClick={load.reload} disabled={load.loading}>
          Refresh
        </button>
      </p>
      <LoadState loading={load.loading && !s} error={load.error} onRetry={load.reload} />
      {s && (
        <>
          <h2>
            Disk <Badge tone={LEVEL_TONE[s.level]}>{s.level}</Badge>
          </h2>
          {s.disk ? (
            <>
              <div
                className={`gauge ${s.level}`}
                role="meter"
                aria-label="Disk used"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(s.disk.usedPercent)}
              >
                <span style={{ width: `${Math.min(100, Math.max(0, s.disk.usedPercent))}%` }} />
              </div>
              <p className="muted small-text">
                {s.disk.usedPercent.toFixed(1)}% used · {formatBytes(s.disk.totalBytes - s.disk.freeBytes)} of{" "}
                {formatBytes(s.disk.totalBytes)} · {formatBytes(s.disk.freeBytes)} free
              </p>
            </>
          ) : (
            <p className="muted">The disk could not be read (the Postgres volume is not mounted here).</p>
          )}
          <dl className="kv">
            <dt>Growth per day</dt>
            <dd>{s.growthBytesPerDay === null ? "Not enough history yet (needs 24 hours)" : formatBytes(s.growthBytesPerDay)}</dd>
            <dt>Days to full</dt>
            <dd>{s.daysToFull === null ? "—" : `about ${Math.round(s.daysToFull)}`}</dd>
            <dt>Routine retention</dt>
            <dd>
              {s.tightened
                ? `Shortened to ${s.tightened.routineDays} days since ${formatTime(s.tightened.since)}`
                : "As configured"}
            </dd>
            <dt>Oldest important record</dt>
            <dd>
              {formatTime(s.oldestImportantAt)}
              <div className="muted">The wallet manager's records only; dpm-wallet's are not counted here.</div>
            </dd>
            <dt>Sampled</dt>
            <dd>{formatTime(s.at)}</dd>
          </dl>

          <h2>Databases</h2>
          <dl className="kv">
            <dt>Wallet manager</dt>
            <dd>{formatBytes(s.databases.manager)}</dd>
            <dt>dpm-wallet</dt>
            <dd>{formatBytes(s.databases.wallet)}</dd>
          </dl>

          <h2>Wallet manager tables</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Table</th>
                  <th>Size</th>
                  <th>Rows (estimate)</th>
                </tr>
              </thead>
              <tbody>
                {s.tables.map((t) => (
                  <tr key={`${t.db}.${t.name}`}>
                    <td>{t.name}</td>
                    <td>{formatBytes(t.bytes)}</td>
                    <td>{t.estRows.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small-text">dpm-wallet's own tables are in another database and are not listed.</p>
        </>
      )}
    </>
  );
}
