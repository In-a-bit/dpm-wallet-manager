import type { ReactNode } from "react";

export function Badge({ tone = "neutral", children }: { tone?: "neutral" | "ok" | "bad" | "warn" | "accent"; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Dot({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <span className={`dot ${ok ? "dot-ok" : "dot-bad"}`}>
      <span aria-hidden="true" className="dot-mark" />
      {children}
      <span className="sr-only">{ok ? " (ok)" : " (problem)"}</span>
    </span>
  );
}

const STATUS_TONE: Record<string, "ok" | "bad" | "warn" | "neutral"> = {
  active: "ok",
  success: "ok",
  revoked: "bad",
  disabled: "bad",
  denied: "warn",
  failure: "bad",
  provisioning: "warn",
};

export function StatusBadge({ value }: { value: string }) {
  return <Badge tone={STATUS_TONE[value] ?? "neutral"}>{value}</Badge>;
}

/** Loading / error / empty placeholder used under tables and cards. */
export function LoadState({ loading, error, empty, onRetry }: { loading: boolean; error: string | null; empty?: boolean; onRetry?: () => void }) {
  if (error)
    return (
      <p className="error" role="alert">
        {error}{" "}
        {onRetry && (
          <button type="button" className="link" onClick={onRetry}>
            Retry
          </button>
        )}
      </p>
    );
  if (loading) return <p className="muted">Loading…</p>;
  if (empty) return <p className="muted">Nothing to show.</p>;
  return null;
}
