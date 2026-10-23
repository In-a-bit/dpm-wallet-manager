export type UsedSample = { at: string; usedBytes: number };
export type StorageLevel = "ok" | "warning" | "critical";

const DAY_MS = 24 * 60 * 60_000;
/** How far back the slope looks, and the least history it needs before it says anything. */
export const GROWTH_WINDOW_DAYS = 7;
const MIN_SPAN_MS = DAY_MS;

/**
 * Bytes per day, from a least-squares line through the last 7 days of `usedBytes` (measured back
 * from the newest sample). Null with under 24 h of samples: a short window mostly measures noise.
 */
export function growthPerDay(samples: UsedSample[]): number | null {
  const points = samples
    .map((s) => ({ t: Date.parse(s.at), y: s.usedBytes }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.y))
    .sort((a, b) => a.t - b.t);
  if (points.length < 2) return null;
  const newest = points[points.length - 1]!.t;
  const window = points.filter((p) => p.t >= newest - GROWTH_WINDOW_DAYS * DAY_MS);
  if (window.length < 2 || newest - window[0]!.t < MIN_SPAN_MS) return null;

  const t0 = window[0]!.t;
  const xs = window.map((p) => (p.t - t0) / DAY_MS);
  const n = window.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = window.reduce((a, p) => a + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - mx) * (window[i]!.y - my);
    den += (xs[i]! - mx) ** 2;
  }
  if (den === 0) return null;
  // `+ 0` turns a negative zero into 0.
  return num / den + 0;
}

/** Days until the disk is full at the current growth; null when it is not growing or unknown. */
export function daysToFull(freeBytes: number | null, growth: number | null): number | null {
  if (freeBytes === null || growth === null || growth <= 0) return null;
  return freeBytes / growth;
}

export type LevelSettings = {
  warningPercent: number;
  warningDays: number;
  criticalPercent: number;
  criticalDays: number;
};

/** A level applies when either its percent or its days condition holds. Without a disk it is ok. */
export function levelFor(
  sample: { usedPercent: number | null; freeBytes: number | null },
  growth: number | null,
  settings: LevelSettings,
): StorageLevel {
  if (sample.usedPercent === null) return "ok";
  const days = daysToFull(sample.freeBytes, growth);
  if (
    sample.usedPercent >= settings.criticalPercent ||
    (days !== null && days <= settings.criticalDays)
  ) {
    return "critical";
  }
  if (
    sample.usedPercent >= settings.warningPercent ||
    (days !== null && days <= settings.warningDays)
  ) {
    return "warning";
  }
  return "ok";
}
