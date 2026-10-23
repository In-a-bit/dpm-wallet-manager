import { api, type Wallet } from "../api";
import { BalanceFigure, RefreshBalances, useBalances, type Balances } from "../components/Balance";
import { Address } from "../components/Copy";
import { Link } from "../components/Layout";
import { Badge, Dot, LoadState, StatusBadge } from "../components/Status";
import { TreasuryTransfer } from "../components/TreasuryTransfer";
import { formatTime } from "../format";
import { useLoad } from "../hooks";
import { useSession } from "../session";

const MODE_TEXT = {
  segregated: "Each user holds their own funds: trades are paid from the user's own wallet.",
  shared: "The company's operations wallet pays for users' trades; user wallets receive what they buy.",
};

function WalletCard({ title, wallet, missing, balances }: { title: string; wallet: Wallet | null; missing: string; balances: Balances }) {
  return (
    <section className="panel card">
      <h2>{title}</h2>
      {wallet ? (
        <dl className="kv">
          <dt>Label</dt>
          <dd>
            <Link to={`/wallets/${encodeURIComponent(wallet.id)}`}>{wallet.label ?? wallet.id}</Link>
          </dd>
          <dt>Status</dt>
          <dd>
            <StatusBadge value={wallet.status} />
          </dd>
          <dt>Balance</dt>
          <dd>
            <BalanceFigure balances={balances} walletId={wallet.id} showBlock /> <RefreshBalances balances={balances} />
          </dd>
          <dt>EOA</dt>
          <dd>
            <Address value={wallet.address} />
          </dd>
          <dt>Proxy</dt>
          <dd>
            <Address value={wallet.proxyAddress} />
          </dd>
          <dt>DPM registered</dt>
          <dd>
            <Dot ok={wallet.dpmRegistered}>{wallet.dpmRegistered ? "Yes" : "No"}</Dot>
          </dd>
        </dl>
      ) : (
        <p className="muted">{missing}</p>
      )}
    </section>
  );
}

export function OverviewPage() {
  const { data, error, loading, reload } = useLoad(() => api.platform(), "platform");
  const { session } = useSession();
  const treasuryIds = [data?.masterWallet?.id, data?.operationsWallet?.id].filter((id): id is string => !!id);
  const balances = useBalances(treasuryIds);

  return (
    <>
      <div className="page-head">
        <h1>Overview</h1>
        <button type="button" className="small" onClick={reload} disabled={loading}>
          Refresh
        </button>
      </div>
      {!data && <LoadState loading={loading} error={error} onRetry={reload} />}
      {data && (
        <div className="grid">
          <section className="panel card">
            <h2>Custody mode</h2>
            <p>
              <Badge tone="accent">{data.mode}</Badge>
            </p>
            <p className="muted">{MODE_TEXT[data.mode]}</p>
            {data.modeBurnedAt && <p className="muted small-text">Fixed since {formatTime(data.modeBurnedAt)}.</p>}
          </section>
          <section className="panel card">
            <h2>Wallets</h2>
            <p className="big-number">{data.walletCount}</p>
            <Link to="/wallets">View all wallets</Link>
          </section>
          <section className="panel card">
            <h2>Upstream health</h2>
            <ul className="plain">
              <li>
                <Dot ok={data.upstream.reachable}>dpm-wallet {data.upstream.reachable ? "reachable" : "unreachable"}</Dot>
              </li>
              <li>
                <Dot ok={data.upstream.vault?.initialized === true}>
                  Vault {data.upstream.vault?.initialized ? "initialized" : "not initialized"}
                </Dot>
              </li>
              <li>
                <Dot ok={data.upstream.vault?.ready === true}>Vault {data.upstream.vault?.ready ? "ready" : "not ready"}</Dot>
              </li>
            </ul>
            {!data.upstream.vault && <p className="muted small-text">Vault status unknown (upstream did not report it).</p>}
          </section>
          <WalletCard title="Master wallet" wallet={data.masterWallet} missing="Missing: no master wallet has been created." balances={balances} />
          <WalletCard
            title="Operations wallet"
            wallet={data.operationsWallet}
            balances={balances}
            missing={
              data.mode === "segregated"
                ? "Missing: it funds users' wallets in segregated mode."
                : "Missing: shared mode needs an operations wallet to trade."
            }
          />
        </div>
      )}
      {data && session.actorRole !== "readonly" && (
        <TreasuryTransfer
          master={data.masterWallet}
          operations={data.operationsWallet}
          isAdmin={session.actorRole === "admin"}
          onSettled={balances.refresh}
        />
      )}
    </>
  );
}
