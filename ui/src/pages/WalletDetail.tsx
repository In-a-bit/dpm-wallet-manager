import { useState } from "react";
import { api } from "../api";
import { AuditList } from "../components/AuditList";
import { Address, CopyButton } from "../components/Copy";
import { Link } from "../components/Layout";
import { OperationsList } from "../components/OperationsList";
import { Badge, Dot, LoadState, StatusBadge } from "../components/Status";
import { formatTime } from "../format";
import { useLoad } from "../hooks";

type Tab = "operations" | "audit";

export function WalletDetailPage({ id }: { id: string }) {
  const { data: w, error, loading, reload } = useLoad(() => api.getWallet(id), id);
  const [tab, setTab] = useState<Tab>("operations");

  return (
    <>
      <p>
        <Link to="/wallets">← All wallets</Link>
      </p>
      <div className="page-head">
        <h1>{w ? (w.label ?? w.externalId ?? "Wallet") : "Wallet"}</h1>
      </div>
      {!w && <LoadState loading={loading} error={error} onRetry={reload} />}
      {w && (
        <section className="panel">
          <dl className="kv">
            <dt>Id</dt>
            <dd>
              <code>{w.id}</code> <CopyButton value={w.id} />
            </dd>
            <dt>Kind</dt>
            <dd>
              <Badge tone={w.kind === "user" ? "neutral" : "accent"}>{w.kind}</Badge>
            </dd>
            <dt>Label</dt>
            <dd>{w.label ?? <span className="muted">—</span>}</dd>
            <dt>External id</dt>
            <dd>{w.externalId ?? <span className="muted">—</span>}</dd>
            <dt>Status</dt>
            <dd>
              <StatusBadge value={w.status} />
            </dd>
            <dt>EOA address</dt>
            <dd>
              <Address value={w.address} />
            </dd>
            <dt>Proxy address</dt>
            <dd>
              <Address value={w.proxyAddress} />
            </dd>
            <dt>DPM registered</dt>
            <dd>
              <Dot ok={w.dpmRegistered}>{w.dpmRegistered ? "Yes" : "No"}</Dot>
            </dd>
            <dt>Ref</dt>
            <dd>
              <code>{w.ref}</code>
            </dd>
            <dt>Created</dt>
            <dd>{formatTime(w.createdAt)}</dd>
            <dt>Updated</dt>
            <dd>{formatTime(w.updatedAt)}</dd>
          </dl>
        </section>
      )}
      <div className="tabs" role="tablist" aria-label="Wallet history">
        <button type="button" role="tab" aria-selected={tab === "operations"} onClick={() => setTab("operations")}>
          Operations
        </button>
        <button type="button" role="tab" aria-selected={tab === "audit"} onClick={() => setTab("audit")}>
          Audit events
        </button>
      </div>
      <div className="panel" role="tabpanel">
        {tab === "operations" ? (
          <OperationsList key={id} filters={{ walletId: id }} showWallet={false} />
        ) : (
          <AuditList key={id} filters={{ walletId: id }} showWallet={false} />
        )}
      </div>
    </>
  );
}
