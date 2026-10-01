import { useState } from "react";
import { AUDIT_ACTIONS, type AuditOutcome } from "../api";
import { AuditList } from "../components/AuditList";
import { Field } from "../components/Field";
import { localInputToIso } from "../format";
import { useDebounced } from "../hooks";

export function AuditPage() {
  const [action, setAction] = useState("");
  const [outcome, setOutcome] = useState<AuditOutcome | "">("");
  const [walletId, setWalletId] = useState("");
  const [actorKeyId, setActorKeyId] = useState("");
  const [actorUserId, setActorUserId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const wallet = useDebounced(walletId.trim());
  const keyId = useDebounced(actorKeyId.trim());
  const userId = useDebounced(actorUserId.trim());

  const filters = {
    action,
    outcome,
    walletId: wallet,
    actorKeyId: keyId,
    actorUserId: userId,
    from: localInputToIso(from),
    to: localInputToIso(to),
  };

  return (
    <>
      <div className="page-head">
        <h1>Audit log</h1>
      </div>
      <div className="filters panel">
        <Field label="Action">
          <select value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">All</option>
            {AUDIT_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Outcome">
          <select value={outcome} onChange={(e) => setOutcome(e.target.value as AuditOutcome | "")}>
            <option value="">All</option>
            <option value="success">Success</option>
            <option value="denied">Denied</option>
            <option value="failure">Failure</option>
          </select>
        </Field>
        <Field label="Wallet id">
          <input value={walletId} onChange={(e) => setWalletId(e.target.value)} spellCheck={false} />
        </Field>
        <Field label="Actor key id">
          <input value={actorKeyId} onChange={(e) => setActorKeyId(e.target.value)} spellCheck={false} />
        </Field>
        <Field label="Actor user id">
          <input value={actorUserId} onChange={(e) => setActorUserId(e.target.value)} spellCheck={false} />
        </Field>
        <Field label="From">
          <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
      </div>
      <div className="panel">
        <AuditList key={JSON.stringify(filters)} filters={filters} />
      </div>
    </>
  );
}
