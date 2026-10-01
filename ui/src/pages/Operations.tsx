import { useState } from "react";
import { OPERATION_KINDS } from "../api";
import { Field } from "../components/Field";
import { OperationsList } from "../components/OperationsList";
import { localInputToIso } from "../format";
import { useDebounced } from "../hooks";

export function OperationsPage() {
  const [kind, setKind] = useState("");
  const [walletId, setWalletId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const wallet = useDebounced(walletId.trim());

  const filters = { kind, walletId: wallet, from: localInputToIso(from), to: localInputToIso(to) };

  return (
    <>
      <div className="page-head">
        <h1>Operations</h1>
      </div>
      <p className="muted">Every order, cancel and on-chain action this service signed.</p>
      <div className="filters panel">
        <Field label="Kind">
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">All</option>
            {OPERATION_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Wallet id">
          <input value={walletId} onChange={(e) => setWalletId(e.target.value)} spellCheck={false} />
        </Field>
        <Field label="From">
          <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
      </div>
      <div className="panel">
        <OperationsList key={JSON.stringify(filters)} filters={filters} />
      </div>
    </>
  );
}
