import { useState } from "react";
import { api, type Query } from "../api";
import { formatTime, shortId } from "../format";
import { useLoad } from "../hooks";
import { Address } from "./Copy";
import { Link } from "./Layout";
import { CursorPager } from "./CursorPager";
import { Badge, LoadState, StatusBadge } from "./Status";

const PAGE = 50;
const FIRST_PAGE = "first";

/** Paginated operations table. Remount (via key) when filters change: that resets the cursor stack to the first page. */
export function OperationsList({ filters, showWallet = true }: { filters: Query; showWallet?: boolean }) {
  // Cursors of the pages visited, newest first; the last one is the page on screen. The server
  // takes the literal "first" for the top page, which keeps even that request free of a COUNT.
  const [cursors, setCursors] = useState<string[]>([FIRST_PAGE]);
  const query = { ...filters, limit: PAGE, cursor: cursors[cursors.length - 1] };
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
                  {/* An order hash or a from:nonce pair: shortened, with the full value one click away. */}
                  <Address value={op.resultSummary} />
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
