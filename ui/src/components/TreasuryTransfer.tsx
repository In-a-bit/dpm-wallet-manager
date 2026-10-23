import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, errorMessage, type TransferResult, type Wallet } from "../api";
import { Confirm } from "./Confirm";
import { Field } from "./Field";
import { Badge } from "./Status";
import { useToast } from "./Toasts";

type Direction = "toOperations" | "toMaster" | "external";

const MINED = ["STATE_MINED", "STATE_CONFIRMED"];
const FAILED = ["STATE_FAILED", "STATE_INVALID"];
const POLL_MS = 4000;
/** data-api indexes a little behind the chain, so a mined transfer is re-read once more after this. */
const LATE_REFRESH_MS = 6000;

const AMOUNT_RE = /^\d+(\.\d{1,6})?$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

type Progress = { phase: "submitted" } | { phase: "mined"; hash: string | null } | { phase: "failed"; state: string };

/**
 * A v4 UUID. `crypto.randomUUID` exists only in a secure context, and an install's admin UI may be
 * served over plain HTTP on a LAN address, so fall back to building one from getRandomValues.
 */
function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

interface Props {
  master: Wallet | null;
  operations: Wallet | null;
  isAdmin: boolean;
  /** Called after a transfer settles, so balances can refresh. */
  onSettled: () => void;
}

export function TreasuryTransfer({ master, operations, isAdmin, onSettled }: Props) {
  const toast = useToast();
  const [direction, setDirection] = useState<Direction>("toOperations");
  const [amount, setAmount] = useState("");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lateRefresh = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // One key per form payload, kept until a submission of it succeeds. A retry after a lost
  // response (network error, UPSTREAM_UNAVAILABLE) then replays the first attempt server-side
  // instead of signing and relaying the same transfer a second time.
  const pending = useRef<{ payload: string; key: string } | null>(null);
  const settled = useRef(onSettled);
  settled.current = onSettled;
  // A newer submission supersedes the polling of an older one.
  const run = useRef(0);

  useEffect(
    () => () => {
      run.current++;
      clearTimeout(timer.current);
      clearTimeout(lateRefresh.current);
    },
    [],
  );

  const from = direction === "toMaster" ? operations : master;
  const to = direction === "toOperations" ? operations : direction === "toMaster" ? master : null;
  const amountOk = AMOUNT_RE.test(amount) && Number(amount) > 0;
  const addressOk = direction !== "external" || ADDRESS_RE.test(address.trim());
  const ready = !!from && (direction === "external" || !!to) && amountOk && addressOk && !busy;

  const poll = (id: string, mine: number) => {
    timer.current = setTimeout(async () => {
      if (run.current !== mine) return;
      try {
        const s = await api.transferStatus(id);
        if (run.current !== mine) return;
        if (s.state && MINED.includes(s.state)) {
          setProgress({ phase: "mined", hash: s.transactionHash });
          settled.current();
          clearTimeout(lateRefresh.current);
          lateRefresh.current = setTimeout(() => settled.current(), LATE_REFRESH_MS);
          return;
        }
        if (s.state && FAILED.includes(s.state)) {
          setProgress({ phase: "failed", state: s.state });
          settled.current();
          return;
        }
      } catch {
        // Transient lookup failure: keep polling.
      }
      poll(id, mine);
    }, POLL_MS);
  };

  const submit = async () => {
    if (!from) return;
    const body = {
      amountDecimal: amount,
      ...(direction === "external" ? { recipient: address.trim() } : { recipientWalletId: to!.id }),
    };
    const payload = JSON.stringify([direction, from.id, body]);
    if (pending.current?.payload !== payload) pending.current = { payload, key: newIdempotencyKey() };
    const mine = ++run.current;
    clearTimeout(timer.current);
    setBusy(true);
    setProgress(null);
    try {
      const r: TransferResult = await api.createTransfer(from.id, body, pending.current.key);
      pending.current = null;
      setProgress({ phase: "submitted" });
      setAmount("");
      setAddress("");
      setConfirming(false);
      poll(r.relayerTransactionId, mine);
    } catch (err) {
      toast.bad(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    if (direction === "external") setConfirming(true);
    else void submit();
  };

  if (!master) return null;

  return (
    <section className="panel">
      <h2>Transfer</h2>
      <form className="transfer-form" onSubmit={onSubmit}>
        <Field label="Direction">
          <select value={direction} onChange={(e) => setDirection(e.target.value as Direction)}>
            <option value="toOperations">Master → operations</option>
            <option value="toMaster">Operations → master</option>
            {isAdmin && <option value="external">Master → external address</option>}
          </select>
        </Field>
        <Field label="Amount (USDC)" hint="Up to 6 decimals.">
          <input inputMode="decimal" value={amount} placeholder="0.00" onChange={(e) => setAmount(e.target.value.trim())} />
        </Field>
        {direction === "external" && (
          <Field label="Recipient address">
            <input value={address} placeholder="0x…" spellCheck={false} onChange={(e) => setAddress(e.target.value)} />
          </Field>
        )}
        <div>
          <button type="submit" className="primary" disabled={!ready}>
            {busy ? "Submitting…" : "Send"}
          </button>
        </div>
      </form>
      {direction !== "external" && !operations && (
        <p className="muted small-text">No operations wallet exists yet, so there is nowhere to transfer to or from.</p>
      )}
      {progress?.phase === "submitted" && (
        <p role="status">
          <Badge tone="warn">Submitted</Badge> <span className="muted small-text">Waiting for the transfer to be mined…</span>
        </p>
      )}
      {progress?.phase === "mined" && (
        <p role="status">
          <Badge tone="ok">Mined</Badge>{" "}
          {progress.hash && <code className="small-text">{progress.hash}</code>}
        </p>
      )}
      {progress?.phase === "failed" && (
        <p role="status">
          <Badge tone="bad">Failed</Badge> <span className="small-text">{progress.state}</span>
        </p>
      )}
      {confirming && (
        <Confirm
          title="Send to an external address?"
          confirmLabel="Send funds"
          danger
          onClose={() => setConfirming(false)}
          onConfirm={submit}
        >
          <p>This sends funds out of the platform and cannot be undone. Check both values.</p>
          <dl className="kv">
            <dt>Amount</dt>
            <dd>{amount} USDC</dd>
            <dt>Address</dt>
            <dd>
              <code>{address.trim()}</code>
            </dd>
          </dl>
        </Confirm>
      )}
    </section>
  );
}
