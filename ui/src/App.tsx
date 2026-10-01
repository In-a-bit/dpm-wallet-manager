import { useCallback, useEffect, useMemo, useState } from "react";
import { api, setUnauthorizedHandler, type SessionDto } from "./api";
import { Layout } from "./components/Layout";
import { useToast } from "./components/Toasts";
import { AccountPage } from "./pages/Account";
import { ApiKeysPage } from "./pages/ApiKeys";
import { AuditPage } from "./pages/Audit";
import { LoginPage } from "./pages/Login";
import { OperationsPage } from "./pages/Operations";
import { OverviewPage } from "./pages/Overview";
import { UsersPage } from "./pages/Users";
import { WalletDetailPage } from "./pages/WalletDetail";
import { WalletsPage } from "./pages/Wallets";
import { match, usePath } from "./router";
import { SessionContext, useRole, type SessionCtx } from "./session";

type Boot = { state: "loading" } | { state: "anonymous"; expired: boolean } | { state: "signed-in"; session: SessionDto };

export function App() {
  const [boot, setBoot] = useState<Boot>({ state: "loading" });
  const toast = useToast();

  useEffect(() => {
    setUnauthorizedHandler(() => setBoot({ state: "anonymous", expired: true }));
    api
      .me()
      .then((session) => setBoot({ state: "signed-in", session }))
      .catch(() => setBoot({ state: "anonymous", expired: false }));
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // Already signed out or unreachable: the login screen is the right place either way.
    }
    setBoot({ state: "anonymous", expired: false });
  }, []);

  const ctx = useMemo<SessionCtx | null>(
    () => (boot.state === "signed-in" ? { session: boot.session, signOut } : null),
    [boot, signOut],
  );

  if (boot.state === "loading") return <p className="boot muted">Loading…</p>;
  if (boot.state === "anonymous" || !ctx)
    return (
      <LoginPage
        notice={boot.state === "anonymous" && boot.expired ? "Your session ended. Please sign in again." : undefined}
        onSignedIn={(session) => {
          setBoot({ state: "signed-in", session });
          toast.ok(`Signed in as ${session.user.username}.`);
        }}
      />
    );

  return (
    <SessionContext.Provider value={ctx}>
      <Layout>
        <Routes />
      </Layout>
    </SessionContext.Provider>
  );
}

function Routes() {
  const path = usePath();
  const isOwner = useRole() === "owner";
  if (path === "/") return <OverviewPage />;
  if (path === "/wallets") return <WalletsPage />;
  const wallet = match("/wallets/:id", path);
  if (wallet) return <WalletDetailPage id={wallet.id} />;
  if (path === "/operations") return <OperationsPage />;
  if (path === "/audit") return <AuditPage />;
  if (path === "/api-keys" && isOwner) return <ApiKeysPage />;
  if (path === "/users" && isOwner) return <UsersPage />;
  if (path === "/account") return <AccountPage />;
  return (
    <section className="panel">
      <h1>Page not found</h1>
      <p className="muted">There is nothing here, or your role cannot open this page.</p>
    </section>
  );
}
