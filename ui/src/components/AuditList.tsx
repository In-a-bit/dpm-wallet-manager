import { Fragment, useState } from "react";
import { api, type AuditEvent, type Query } from "../api";
import { formatTime, shortId } from "../format";
import { useLoad } from "../hooks";
import { Link } from "./Layout";
import { Pagination } from "./Pagination";
import { LoadState, StatusBadge } from "./Status";

const PAGE = 50;

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

/** Paginated audit table with expandable JSON detail. Remount (via key) when filters change. */
export function AuditList({ filters, showWallet = true }: { filters: Query; showWallet?: boolean }) {
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<number | null>(null);
  const query = { ...filters, limit: PAGE, offset };
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
      {data && <Pagination total={data.total} limit={PAGE} offset={offset} onChange={setOffset} />}
    </>
  );
}
