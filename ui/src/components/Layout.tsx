import { useState, type MouseEvent, type ReactNode } from "react";
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
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
