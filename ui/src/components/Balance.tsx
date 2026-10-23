import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, errorMessage, type WalletBalance } from "../api";
import { formatUsdc } from "../format";

export interface Balances {
  /** Balance by wallet id; absent until loaded. */
  byId: Map<string, WalletBalance>;
  loading: boolean;
  /** True when the install has no data-api ("Balances unavailable"). */
  unavailable: boolean;
  error: string | null;
  refresh: () => void;
}

/** Loads balances for the given wallet ids in one call; reloads when the ids change or on refresh(). */
export function useBalances(ids: string[]): Balances {
  const key = ids.join(",");
  const [byId, setById] = useState<Map<string, WalletBalance>>(new Map());
  const [loading, setLoading] = useState(ids.length > 0);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const idsRef = useRef(ids);
  idsRef.current = ids;

  useEffect(() => {
    const list = idsRef.current;
    if (list.length === 0) {
      setById(new Map());
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    api
      .walletBalances(list)
      .then((rows) => {
        if (!live) return;
        setById(new Map(rows.map((r) => [r.walletId, r])));
        setUnavailable(false);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!live) return;
        if (e instanceof ApiError && e.code === "BALANCES_UNAVAILABLE") {
          setUnavailable(true);
          setError(null);
        } else {
          setError(errorMessage(e));
        }
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [key, tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { byId, loading, unavailable, error, refresh };
}

/** The figure for one wallet: amount, plus "as of block N" when `showBlock`. */
export function BalanceFigure({
  balances,
  walletId,
  showBlock = false,
}: {
  balances: Balances;
  walletId: string;
  showBlock?: boolean;
}) {
  if (balances.unavailable) return <span className="muted">Balances unavailable</span>;
  if (balances.error) return <span className="error">{balances.error}</span>;
  const row = balances.byId.get(walletId);
  if (!row) return <span className="muted">{balances.loading ? "Loading…" : "—"}</span>;
  return (
    <span>
      <span>{formatUsdc(row.balanceMicro)}</span>
      {showBlock && row.blockNumber !== null && <span className="muted small-text"> · as of block {row.blockNumber}</span>}
    </span>
  );
}

export function RefreshBalances({ balances }: { balances: Balances }) {
  return (
    <button type="button" className="small" onClick={balances.refresh} disabled={balances.loading}>
      {balances.loading ? "Refreshing…" : "Refresh balance"}
    </button>
  );
}
