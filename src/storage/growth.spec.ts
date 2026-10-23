import { daysToFull, growthPerDay, levelFor } from "./growth";

const GB = 1e9;
const t0 = Date.parse("2026-10-01T00:00:00Z");
const series = (hours: number, step: number, bytesPerDay: (h: number) => number) =>
  Array.from({ length: Math.floor(hours / step) + 1 }, (_, i) => ({
    at: new Date(t0 + i * step * 3_600_000).toISOString(),
    usedBytes: 50 * GB + bytesPerDay(i * step),
  }));

describe("growthPerDay", () => {
  it("measures a linear 1 GB/day series", () => {
    const g = growthPerDay(series(72, 1, (h) => (h / 24) * GB));
    expect(g).toBeGreaterThan(0.99 * GB);
    expect(g).toBeLessThan(1.01 * GB);
  });

  it("gives 0 for a flat series, and no days to full", () => {
    const g = growthPerDay(series(72, 1, () => 0));
    expect(g).toBe(0);
    expect(daysToFull(10 * GB, g)).toBeNull();
  });

  it("gives null with under 24 h of samples", () => {
    expect(growthPerDay(series(12, 1, (h) => h * GB))).toBeNull();
  });

  it("only looks at the last 7 days", () => {
    // 20 days of steep growth, then 8 days flat: the window sees only the flat part.
    const steep = series(24 * 20, 6, (h) => (h / 24) * 5 * GB);
    const base = steep[steep.length - 1]!;
    const flat = Array.from({ length: 33 }, (_, i) => ({
      at: new Date(Date.parse(base.at) + (i + 1) * 6 * 3_600_000).toISOString(),
      usedBytes: base.usedBytes,
    }));
    expect(growthPerDay([...steep, ...flat])).toBe(0);
  });
});

describe("levelFor", () => {
  const settings = { warningPercent: 75, warningDays: 30, criticalPercent: 90, criticalDays: 7 };
  const total = 100 * GB;
  const sample = (usedPercent: number) => ({
    usedPercent,
    freeBytes: total * (1 - usedPercent / 100),
  });

  it("80% is a warning", () => expect(levelFor(sample(80), null, settings)).toBe("warning"));
  it("50% with 20 days to full is a warning", () => {
    const growth = sample(50).freeBytes / 20;
    expect(levelFor(sample(50), growth, settings)).toBe("warning");
  });
  it("50% with 5 days to full is critical", () => {
    const growth = sample(50).freeBytes / 5;
    expect(levelFor(sample(50), growth, settings)).toBe("critical");
  });
  it("91% is critical", () => expect(levelFor(sample(91), 0, settings)).toBe("critical"));
  it("50% and flat is ok", () => expect(levelFor(sample(50), 0, settings)).toBe("ok"));
  it("without a disk it is ok", () =>
    expect(levelFor({ usedPercent: null, freeBytes: null }, null, settings)).toBe("ok"));
});
