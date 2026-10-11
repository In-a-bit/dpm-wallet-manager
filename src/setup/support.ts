import { describeEntry, formatDuration, journey } from "./journey";
import { mask, type Journal } from "./journal";
import type { HealthCheck } from "./live-status";
import type { SetupState } from "./state";

const MAX_JOURNAL_LINES = 1_000;

/**
 * The setup half of `./dpm-custody support`: what setup knows about this install, in words, with
 * every secret masked. The host half (Docker, containers, service logs) is added by dpm-custody.
 * It is meant to be emailed, so it must never contain anything that controls the install.
 */
export function supportReport(
  state: SetupState,
  journal: Journal,
  checks: readonly HealthCheck[],
  now: Date = new Date(),
): string {
  const entries = journal.readAll();
  const { rows, position, total, complete } = journey(state, entries, {});
  const lines = [
    "== Setup ==",
    `Generated:          ${now.toISOString()}`,
    `Install reference:  ${state.installId ?? "(setup not started)"}`,
    `Builder:            ${state.platform ? `${state.platform.owner.name} (#${state.platform.owner.id})` : "-"}`,
    `Platform:           ${state.answers ? `${state.answers.environment} (${state.answers.dpmApiUrl})` : "-"}`,
    `Chain:              ${state.platform?.chain_id ?? "-"}`,
    `Custody mode:       ${state.answers?.mode ?? "-"}`,
    `Progress:           ${complete ? "complete" : `step ${position} of ${total}`}${state.running ? " (running)" : ""}`,
    `Last error:         ${state.lastError ?? "-"}`,
    "",
    "== Checklist ==",
    ...rows.map((row) => {
      const time = row.ms !== undefined ? ` (${formatDuration(row.ms)})` : "";
      const result = row.result ? `: ${row.result}` : "";
      return `[${row.status.padEnd(7)}] ${row.title}${result}${time}${row.error ? `\n          ${row.error}` : ""}`;
    }),
    "",
    "== Services now ==",
    ...checks.map(
      (check) =>
        `${check.ok ? "ok  " : "FAIL"}  ${check.label}${check.detail ? `: ${check.detail}` : ""}`,
    ),
    "",
    `== Setup journal (last ${MAX_JOURNAL_LINES} events) ==`,
    ...entries.slice(-MAX_JOURNAL_LINES).map((entry) => {
      const step = "step" in entry && entry.step ? `[${entry.step}] ` : "";
      return `${entry.at.slice(0, 10)} ${step}${describeEntry(entry)}`;
    }),
    "",
  ];
  return mask(lines.join("\n"), knownSecrets(state));
}

/** Every secret setup holds, for masking anything that might echo one. */
export function knownSecrets(state: SetupState): string[] {
  return [
    ...Object.values(state.secrets ?? {}),
    state.answers?.builderKey,
    state.operatorKey,
  ].filter((secret): secret is string => typeof secret === "string" && secret.length > 0);
}
