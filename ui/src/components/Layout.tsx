import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { api, type StorageStatus } from "../api";
import { href, navigate, usePath } from "../router";
import { ROLE_LABEL, useSession } from "../session";

interface NavItem {
  path: string;
  label: string;
  ownerOnly?: boolean;
}

const NAV: NavItem[] = [
  { path: "/", label: "Overview" },
  { path: "/wallets", label: "Wallets" },
  { path: "/operations", label: "Operations" },
  { path: "/audit", label: "Audit log" },
  { path: "/storage", label: "Storage" },
  { path: "/api-keys", label: "API keys", ownerOnly: true },
  { path: "/users", label: "Users", ownerOnly: true },
  { path: "/account", label: "My account" },
];

/** In-app link: plain <a href> (so open-in-new-tab works) that navigates client-side on a normal click. */
export function Link({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a href={href(to)} onClick={onClick} className={className}>
      {children}
    </a>
  );
}

function isActive(item: string, path: string): boolean {
  return item === "/" ? path === "/" : path === item || path.startsWith(item + "/");
}

const BANNER_POLL_MS = 5 * 60_000;

/**
 * Disk pressure and archive reminders, on every page. Fetched on mount, on each navigation and
 * every 5 minutes; a failed fetch just shows nothing (the banner is advice, not a gate).
 */
function StorageBanner({ path }: { path: string }) {
  const [status, setStatus] = useState<StorageStatus | null>(null);
  useEffect(() => {
    let live = true;
    const fetchStatus = () =>
      api
        .getStorage()
        .then((s) => live && setStatus(s))
        .catch(() => undefined);
    void fetchStatus();
    const timer = setInterval(fetchStatus, BANNER_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [path]);

  if (!status) return null;
  const left = status.daysToFull === null ? "" : `, about ${Math.round(status.daysToFull)} days to full`;
  const used = status.disk ? `${Math.round(status.disk.usedPercent)}% used${left}` : "";
  return (
    <>
      {status.level !== "ok" && (
        <div className={`storage-banner ${status.level === "critical" ? "critical" : "warning"}`} role="alert">
          <strong>{status.level === "critical" ? "Disk space is critically low" : "Disk space is running low"}</strong>
          {used && ` (${used})`}. Enlarge the disk or Docker volume, <Link to="/storage">archive old records</Link>, or free
          Docker space (<code>docker system df</code>).
          {status.tightened &&
            ` Routine records are now kept for ${status.tightened.routineDays} days instead of the configured time.`}{" "}
          <Link to="/storage">Open Storage</Link>
        </div>
      )}
      {status.archiveSuggested && (
        <div className="storage-banner notice">
          Some important records are older than the archive reminder. <Link to="/storage">Consider archiving them</Link> to keep the
          database small.
        </div>
      )}
    </>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { session, signOut } = useSession();
  const path = usePath();
  const [menuOpen, setMenuOpen] = useState(false);
  const isOwner = session.user.role === "owner";

  return (
    <div className="shell">
      <aside className={`sidebar${menuOpen ? " open" : ""}`}>
        <div className="brand">DPM Wallet Manager</div>
        <nav aria-label="Main">
          <ul onClick={() => setMenuOpen(false)}>
            {NAV.filter((n) => !n.ownerOnly || isOwner).map((n) => (
              <li key={n.path}>
                <Link to={n.path} className={isActive(n.path, path) ? "active" : undefined}>
                  {n.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </aside>
      <div className="main">
        <header className="topbar">
          <button
            type="button"
            className="menu-toggle small"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
          >
            Menu
          </button>
          <span className="spacer" />
          <span className="who">
            <strong>{session.user.username}</strong>{" "}
            <span className="muted">· {ROLE_LABEL[session.user.role]}</span>
          </span>
          <button type="button" className="small" onClick={() => void signOut()}>
            Sign out
          </button>
        </header>
        <main className="content">
          <StorageBanner path={path} />
          {children}
        </main>
      </div>
    </div>
  );
}
