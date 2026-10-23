import { Fragment, useState } from "react";
import { api, type AuditEvent, type Query } from "../api";
import { formatTime, shortId } from "../format";
import { useLoad } from "../hooks";
import { Link } from "./Layout";
import { CursorPager } from "./CursorPager";
import { LoadState, StatusBadge } from "./Status";

const PAGE = 50;
const FIRST_PAGE = "first";

function Actor({ ev }: { ev: AuditEvent }) {
  if (ev.actorUsername || ev.actorUserId)
    return (
      <span title={ev.actorUserId ?? undefined}>
        {ev.actorUsername ?? shortId(ev.actorUserId)}
        {ev.actorRole && <span className="muted"> ({ev.actorRole})</span>}
      </span>
    );
  if (ev.actorKeyId)
    return (
      <span>
        key <code title={ev.actorKeyId}>{shortId(ev.actorKeyId)}</code>
        {ev.actorRole && <span className="muted"> ({ev.actorRole})</span>}
      </span>
    );
  return <span className="muted">—</span>;
}

/** Paginated audit table with expandable JSON detail. Remount (via key) when filters change: that resets the cursor stack to the first page. */
export function AuditList({ filters, showWallet = true }: { filters: Query; showWallet?: boolean }) {
  // Cursors of the pages visited, newest first; the last one is the page on screen. The server
  // takes the literal "first" for the top page, which keeps even that request free of a COUNT.
  const [cursors, setCursors] = useState<string[]>([FIRST_PAGE]);
  const [open, setOpen] = useState<number | null>(null);
  const query = { ...filters, limit: PAGE, cursor: cursors[cursors.length - 1] };
  const { data, error, loading, reload } = useLoad(() => api.listAudit(query), JSON.stringify(query));
  const cols = showWallet ? 7 : 6;

  return (
    <>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Action</th>
              <th>Outcome</th>
              <th>Actor</th>
              {showWallet && <th>Wallet</th>}
              <th>IP</th>
              <th>
                <span className="sr-only">Detail</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((ev) => (
              <Fragment key={ev.id}>
                <tr>
                  <td className="nowrap">{formatTime(ev.createdAt)}</td>
                  <td>
                    <code>{ev.action}</code>
                  </td>
                  <td>
                    <StatusBadge value={ev.outcome} />
                  </td>
                  <td>
                    <Actor ev={ev} />
                  </td>
                  {showWallet && (
                    <td>
                      {ev.walletId ? (
                        <Link to={`/wallets/${encodeURIComponent(ev.walletId)}`}>
                          <code title={ev.walletId}>{shortId(ev.walletId)}</code>
                        </Link>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  )}
                  <td>{ev.ip ?? <span className="muted">—</span>}</td>
                  <td>
                    <button
                      type="button"
                      className="small"
                      aria-expanded={open === ev.id}
                      onClick={() => setOpen(open === ev.id ? null : ev.id)}
                    >
                      {open === ev.id ? "Hide" : "Details"}
                    </button>
                  </td>
                </tr>
                {open === ev.id && (
                  <tr className="detail-row">
                    <td colSpan={cols}>
                      <dl className="kv compact">
                        <dt>Event id</dt>
                        <dd>{ev.id}</dd>
                        <dt>Request id</dt>
                        <dd>{ev.requestId ?? "—"}</dd>
                        <dt>Actor key</dt>
                        <dd>{ev.actorKeyId ?? "—"}</dd>
                        <dt>Actor user</dt>
                        <dd>{ev.actorUserId ?? "—"}</dd>
                        <dt>Wallet</dt>
                        <dd>{ev.walletId ?? "—"}</dd>
                      </dl>
                      <pre className="json">{ev.detail ? JSON.stringify(ev.detail, null, 2) : "No detail."}</pre>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <LoadState loading={loading && !data} error={error} empty={data?.items.length === 0} onRetry={reload} />
      {data && (
        <CursorPager
          hasNewer={cursors.length > 1}
          hasOlder={data.nextCursor !== null}
          onNewer={() => setCursors((c) => c.slice(0, -1))}
          onOlder={() => data.nextCursor && setCursors((c) => [...c, data.nextCursor as string])}
        />
      )}
    </>
  );
}
