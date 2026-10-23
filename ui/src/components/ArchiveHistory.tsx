import type { Archive, Page } from "../api";
import { formatBytes, formatTime, shortId } from "../format";
import { CopyButton } from "./Copy";
import { Pagination } from "./Pagination";
import { Badge } from "./Status";

const TONE: Record<Archive["status"], "ok" | "warn" | "neutral" | "accent"> = {
  pending: "warn",
  downloaded: "accent",
  deleting: "warn",
  done: "ok",
  cancelled: "neutral",
};

function who(a: Archive): string {
  if (a.createdByUserId) return `user ${shortId(a.createdByUserId)}`;
  if (a.createdByKeyId) return `key ${shortId(a.createdByKeyId)}`;
  return "—";
}

/** Every archive, newest first: when, by whom, cutoff, rows, SHA-256 and status. */
export function ArchiveHistory({ page, onOffset }: { page: Page<Archive>; onOffset: (offset: number) => void }) {
  return (
    <section>
      <h2>Archive history</h2>
      {page.items.length === 0 ? (
        <p className="muted">No archives yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Created</th>
                <th>By</th>
                <th>Records before</th>
                <th>Rows</th>
                <th>SHA-256</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((a) => (
                <tr key={a.id}>
                  <td>{formatTime(a.createdAt)}</td>
                  <td>{who(a)}</td>
                  <td>{formatTime(a.before)}</td>
                  <td>
                    {a.rowCount ?? "—"}
                    {a.byteSize != null && <span className="muted"> ({formatBytes(a.byteSize)})</span>}
                  </td>
                  <td>
                    {a.sha256 ? (
                      <span className="addr">
                        <code title={a.sha256}>{a.sha256.slice(0, 12)}…</code>
                        <CopyButton value={a.sha256} />
                      </span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>
                    <Badge tone={TONE[a.status]}>{a.status}</Badge>
                    {a.deleted && (
                      <div className="muted">
                        removed {Object.values(a.deleted).reduce((x, y) => x + y, 0)} rows
                        {a.deletedAt ? ` · ${formatTime(a.deletedAt)}` : ""}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination total={page.total} limit={page.limit} offset={page.offset} onChange={onOffset} />
    </section>
  );
}
