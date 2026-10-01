import { useState, type MouseEvent } from "react";
import { shortAddress } from "../format";

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async (e: MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked (non-secure context); the value is still selectable on screen.
    }
  };
  return (
    <button type="button" className="small" onClick={copy} aria-label={`${label} ${value}`}>
      {copied ? "Copied" : label}
    </button>
  );
}

/** Shortened 0x1234…abcd with the full value in the tooltip and a copy button. */
export function Address({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="muted">—</span>;
  return (
    <span className="addr">
      <code title={value}>{shortAddress(value)}</code>
      <CopyButton value={value} />
    </span>
  );
}
