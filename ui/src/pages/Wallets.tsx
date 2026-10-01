import { useState } from "react";
import { api, type WalletKind, type WalletStatus } from "../api";
import { Address } from "../components/Copy";
import { Field } from "../components/Field";
import { Pagination } from "../components/Pagination";
import { Badge, Dot, LoadState, StatusBadge } from "../components/Status";
import { formatTime } from "../format";
import { useDebounced, useLoad } from "../hooks";
import { navigate } from "../router";

const PAGE = 50;

export function WalletsPage() {
  const [kind, setKind] = useState<WalletKind | "">("");
  const [status, setStatus] = useState<WalletStatus | "">("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const q = useDebounced(search.trim());

  const query = { kind, status, q, limit: PAGE, offset };
  const { data, error, loading, reload } = useLoad(() => api.listWallets(query), JSON.stringify(query));

  const open = (id: string) => navigate(`/wallets/${encodeURIComponent(id)}`);
  // Every filter change starts again at page one.
  const reset = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setOffset(0);
  };

  return (
    <>
      <div className="page-head">
        <h1>Wallets</h1>
      </div>
      <div className="filters panel">
        <Field label="Kind">
          <select value={kind} onChange={(e) => reset(setKind)(e.target.value as WalletKind | "")}>
            <option value="">All</option>
            <option value="user">User</option>
            <option value="master">Master</option>
            <option value="operations">Operations</option>
          </select>
        </Field>
        <Field label="Status">
          <select value={status} onChange={(e) => reset(setStatus)(e.target.value as WalletStatus | "")}>
            <option value="">All</option>
            <option value="provisioning">Provisioning</option>
            <option value="active">Active</option>
            <option value="disabled">Disabled</option>
          </select>
        </Field>
        <Field label="Search">
          <input
            type="search"
            value={search}
            placeholder="Label, external id, address…"
            onChange={(e) => reset(setSearch)(e.target.value)}
          />
        </Field>
      </div>
      <div className="table-wrap panel">
        <table className="clickable">
          <thead>
            <tr>
              <th>Kind</th>
              <th>Label / external id</th>
              <th>EOA</th>
              <th>Proxy</th>
              <th>Status</th>
              <th>DPM</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((w) => (
              <tr
                key={w.id}
                tabIndex={0}
                onClick={() => open(w.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && e.target === e.currentTarget) open(w.id);
                }}
                aria-label={`Open wallet ${w.label ?? w.externalId ?? w.id}`}
              >
                <td>
                  <Badge tone={w.kind === "user" ? "neutral" : "accent"}>{w.kind}</Badge>
                </td>
                <td>
                  <div>{w.label ?? <span className="muted">No label</span>}</div>
                  {w.externalId && <div className="muted small-text">{w.externalId}</div>}
                </td>
                <td>
                  <Address value={w.address} />
                </td>
                <td>
                  <Address value={w.proxyAddress} />
                </td>
                <td>
                  <StatusBadge value={w.status} />
                </td>
                <td>
                  <Dot ok={w.dpmRegistered}>{w.dpmRegistered ? "Registered" : "No"}</Dot>
                </td>
                <td className="nowrap">{formatTime(w.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <LoadState loading={loading && !data} error={error} empty={data?.items.length === 0} onRetry={reload} />
        {data && <Pagination total={data.total} limit={PAGE} offset={offset} onChange={setOffset} />}
      </div>
    </>
  );
}
