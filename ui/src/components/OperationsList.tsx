import { useState } from "react";
import { api, type Query } from "../api";
import { formatTime, shortId } from "../format";
import { useLoad } from "../hooks";
import { Link } from "./Layout";
import { Pagination } from "./Pagination";
import { Badge, LoadState, StatusBadge } from "./Status";

const PAGE = 50;

/** Paginated operations table. Remount (via key) when filters change to reset to page one. */
export function OperationsList({ filters, showWallet = true }: { filters: Query; showWallet?: boolean }) {
  const [offset, setOffset] = useState(0);
  const query = { ...filters, limit: PAGE, offset };
  const { data, error, loading, reload } = useLoad(() => api.listOperations(query), JSON.stringify(query));

  return (
    <>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Kind</th>
              {showWallet && <th>Wallet</th>}
              <th>Signer</th>
              <th>Mode</th>
              <th>Status</th>
              <th>Result</th>
              <th>Actor</th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((op) => (
              <tr key={op.id}>
                <td className="nowrap">{formatTime(op.createdAt)}</td>
                <td>
                  <Badge>{op.kind}</Badge>
                </td>
                {showWallet && (
                  <td>
                    <Link to={`/wallets/${encodeURIComponent(op.walletId)}`}>
                      <code title={op.walletId}>{shortId(op.walletId)}</code>
                    </Link>
                  </td>
                )}
                <td>
                  <code title={op.signerWalletId}>{shortId(op.signerWalletId)}</code>
                </td>
                <td>{op.mode}</td>
                <td>
                  <StatusBadge value={op.status} />
                </td>
                <td className="wrap">
                  {op.resultSummary ?? <span className="muted">—</span>}
                  <div className="muted small-text">
                    hash <code title={op.requestHash}>{shortId(op.requestHash)}</code>
                  </div>
                </td>
                <td className="small-text">
                  {op.uiUserId ? (
                    <>user <code title={op.uiUserId}>{shortId(op.uiUserId)}</code></>
                  ) : op.apiKeyId ? (
                    <>key <code title={op.apiKeyId}>{shortId(op.apiKeyId)}</code></>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <LoadState loading={loading && !data} error={error} empty={data?.items.length === 0} onRetry={reload} />
      {data && <Pagination total={data.total} limit={PAGE} offset={offset} onChange={setOffset} />}
    </>
  );
}
