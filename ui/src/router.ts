/**
 * A minimal history router: app paths are relative to the /admin base the server mounts us under,
 * so "/wallets/abc" lives at /admin/wallets/abc in the address bar.
 */
import { useSyncExternalStore } from "react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, ""); // "/admin"
const CHANGE = "dpmm:navigate";

function currentPath(): string {
  const p = window.location.pathname;
  const rel = p.startsWith(BASE) ? p.slice(BASE.length) : p;
  return rel === "" ? "/" : rel;
}

function subscribe(cb: () => void): () => void {
  window.addEventListener("popstate", cb);
  window.addEventListener(CHANGE, cb);
  return () => {
    window.removeEventListener("popstate", cb);
    window.removeEventListener(CHANGE, cb);
  };
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, currentPath);
}

export function href(path: string): string {
  return BASE + path;
}

export function navigate(path: string, replace = false): void {
  if (path === currentPath()) return;
  if (replace) window.history.replaceState(null, "", href(path));
  else window.history.pushState(null, "", href(path));
  window.dispatchEvent(new Event(CHANGE));
  window.scrollTo(0, 0);
}

/** Matches "/wallets/:id" style patterns; returns the params or null. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split("/").filter(Boolean);
  const b = path.split("/").filter(Boolean);
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(":")) params[a[i].slice(1)] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}
