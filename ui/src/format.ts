export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  // Minutes, not seconds: tables stay narrow enough for their action buttons.
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function shortAddress(addr: string | null | undefined): string {
  if (!addr) return "—";
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

export function shortId(id: string | null | undefined): string {
  if (!id) return "—";
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

/** datetime-local value (local time, no zone) to ISO, or undefined when blank. */
export function localInputToIso(v: string): string | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Micro-USDC integer string to "1,234.50 USDC" using string/bigint math only (no floats). */
export function formatUsdc(micro: string | null | undefined): string {
  if (micro === null || micro === undefined || !/^\d+$/.test(micro)) return "—";
  const n = BigInt(micro);
  const whole = (n / 1_000_000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const cents = ((n % 1_000_000n) / 10_000n).toString().padStart(2, "0");
  return `${whole}.${cents} USDC`;
}

/** Bytes as "12.3 GB" (decimal units, like the disk reports them). */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.abs(bytes);
  let i = 0;
  while (value >= 1000 && i < units.length - 1) {
    value /= 1000;
    i++;
  }
  return `${bytes < 0 ? "-" : ""}${i === 0 ? value : value.toFixed(value < 10 ? 2 : 1)} ${units[i]}`;
}
