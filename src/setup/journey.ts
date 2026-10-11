import { JOURNEY, type JourneyItem } from "./catalog";
import type { JournalEntry } from "./journal";
import type { SetupState } from "./state";
import { progress } from "./steps";

/**
 * The checklist as a person sees it, derived from what setup has stored and journalled. Pure, so
 * the dashboard and the plain output cannot disagree about where setup is.
 */
export type RowStatus = "done" | "running" | "asking" | "failed" | "pending" | "skipped";

export type JourneyRow = JourneyItem & {
  status: RowStatus;
  /** What the step produced, in a few words: the builder's name, the chosen mode. */
  result?: string;
  ms?: number;
  /** What a running step is doing right now. */
  live?: string;
  error?: string;
};

/** What only the terminal knows: answers given in this session, and what it is asking now. */
export type Session = {
  asking?: "platform" | "key" | "mode" | "owner" | "backup";
  platformUrl?: string;
  builder?: string;
  mode?: string;
  /** How long the installer took to download and start the services, when it said. */
  installSeconds?: number;
};

export type Journey = { rows: JourneyRow[]; position: number; total: number; complete: boolean };

export function journey(
  state: SetupState,
  entries: readonly JournalEntry[],
  session: Session,
): Journey {
  const steps = new Map(progress(state).map((step) => [step.id, step.status]));
  const current = progress(state).find(
    (step) => step.status !== "done" && step.status !== "skipped",
  );
  const mode = state.answers?.mode ?? session.mode;
  const rows = JOURNEY.map((item): JourneyRow => {
    const row: JourneyRow = { ...item, status: "pending" };
    const timing = lastDuration(entries, item.id);
    if (timing !== undefined) row.ms = timing;
    switch (item.id) {
      case "installed":
        row.status = "done";
        if (session.installSeconds) row.ms = session.installSeconds * 1000;
        return row;
      case "platform":
        return answered(row, session.asking === "platform", platformHost(state, session));
      case "key":
        return answered(row, session.asking === "key", builderName(state, session));
      case "mode":
        return answered(row, session.asking === "mode", mode);
      case "owner":
        return flag(row, state.ownerCreated, session.asking === "owner");
      case "backup":
        return flag(row, state.backupAcknowledged, session.asking === "backup");
    }
    const status = steps.get(item.id);
    if (status === "done") row.status = "done";
    else if (status === "skipped") row.status = mode ? "skipped" : "pending";
    else if (state.answers && item.id === current?.id) {
      row.status = state.lastError ? "failed" : "running";
      if (state.lastError) row.error = state.lastError;
      else row.live = liveMessage(entries, item.id) ?? "Starting…";
    }
    return row;
  });
  const counted = rows.filter((row) => row.status !== "skipped");
  const at = counted.findIndex((row) => row.status !== "done");
  return {
    rows,
    position: at === -1 ? counted.length : at + 1,
    total: counted.length,
    complete: at === -1,
  };
}

function answered(row: JourneyRow, asking: boolean, result: string | undefined): JourneyRow {
  if (result) return { ...row, status: "done", result };
  return { ...row, status: asking ? "asking" : "pending" };
}

function flag(row: JourneyRow, done: boolean, asking: boolean): JourneyRow {
  return { ...row, status: done ? "done" : asking ? "asking" : "pending" };
}

function platformHost(state: SetupState, session: Session): string | undefined {
  const url = state.answers?.dpmApiUrl ?? session.platformUrl;
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function builderName(state: SetupState, session: Session): string | undefined {
  const owner = state.platform?.owner;
  return owner ? `${owner.name} (#${owner.id})` : session.builder;
}

function lastDuration(entries: readonly JournalEntry[], step: string): number | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as JournalEntry;
    if (entry.type === "step.done" && entry.step === step) return entry.ms;
    if (entry.type === "step.start" && entry.step === step) return undefined;
  }
  return undefined;
}

function liveMessage(entries: readonly JournalEntry[], step: string): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as JournalEntry;
    if (entry.type === "step.progress" && entry.step === step) return entry.message;
    if (entry.type === "step.start" && entry.step === step) return undefined;
  }
  return undefined;
}

/**
 * The journal lines about one step, for the details view and support: everything from its last
 * start, including the requests made while it ran.
 */
export function stepDetails(entries: readonly JournalEntry[], step: string): JournalEntry[] {
  let start = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as JournalEntry;
    if (entry.type === "step.start" && entry.step === step) {
      start = i;
      break;
    }
  }
  const own = entries.filter((entry) => "step" in entry && entry.step === step);
  if (start === -1) return own;
  const details: JournalEntry[] = [];
  for (const entry of entries.slice(start)) {
    const other = "step" in entry && entry.step !== undefined && entry.step !== step;
    if (other && entry.type === "step.start") break;
    if (!other) details.push(entry);
  }
  return details;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** One journal line in words, for the details view, the plain output and the report. */
export function describeEntry(entry: JournalEntry): string {
  const time = entry.at.slice(11, 19);
  switch (entry.type) {
    case "step.start":
      return `${time}  started`;
    case "step.progress":
      return `${time}  ${entry.message}`;
    case "step.done":
      return `${time}  done in ${formatDuration(entry.ms)}${entry.result ? `: ${entry.result}` : ""}`;
    case "step.fail":
      return `${time}  failed after ${formatDuration(entry.ms)}: ${entry.error}`;
    case "http": {
      const outcome = entry.status !== undefined ? `${entry.status}` : `no answer (${entry.error})`;
      return `${time}  ${entry.method} ${entry.url} → ${outcome} in ${entry.ms}ms`;
    }
    case "note":
      return `${time}  ${entry.message}`;
  }
}
