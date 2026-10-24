import { Select } from "@inkjs/ui";
import { render, useApp, useInput, useStdout, useWindowSize } from "ink";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { journeyItem } from "../catalog";
import { environmentForUrl, ENVIRONMENTS } from "../environments";
import { describeEntry, journey, stepDetails, type Session } from "../journey";
import type { JournalEntry } from "../journal";
import type { PlatformInput } from "../setup-service";
import { isComplete } from "../steps";
import type { DashboardOptions } from "./options";
import {
  DonePanel,
  FailurePanel,
  Frame,
  kitText,
  LineInput,
  type Depth,
  type Notice,
  QuestionPanel,
  StepPanel,
  useSpinnerFrame,
} from "./view";

const POLL_MS = 400;
const MAX_WIDTH = 92;

type Stage =
  | "starting"
  | "platform"
  | "platform-url"
  | "key"
  | "mode"
  | "confirm-mode"
  | "watch"
  | "owner-name"
  | "owner-password"
  | "owner-repeat"
  | "backup"
  | "done";

export async function runDashboard(options: DashboardOptions): Promise<void> {
  const outcome: { finished: boolean } = { finished: false };
  const instance = render(<App {...options} outcome={outcome} />, { exitOnCtrlC: false });
  await instance.waitUntilExit();
  if (!outcome.finished) {
    process.exitCode = 1;
    process.stdout.write(
      "\nSetup carries on in the background. Pick it up again any time:  ./dpm-custody setup\n\n",
    );
  }
}

function App(props: DashboardOptions & { outcome: { finished: boolean } }) {
  const { service, journal, presets, installSeconds, managerPublicUrl, outcome } = props;
  const { exit } = useApp();
  const { write } = useStdout();
  const { columns } = useWindowSize();
  const width = Math.max(Math.min(columns, MAX_WIDTH), 60);

  const [state, setState] = useState(() => service.state());
  const [entries, setEntries] = useState<JournalEntry[]>(() => journal.readAll());
  const offset = useRef(journal.readFrom(0).offset);
  const [stage, setStage] = useState<Stage>("starting");
  const [session, setSession] = useState<Session>({ installSeconds });
  const [platform, setPlatform] = useState<PlatformInput>();
  const [builderKey, setBuilderKey] = useState<string>();
  const [mode, setMode] = useState<string>();
  const [notice, setNotice] = useState<Notice>();
  const [inputKey, setInputKey] = useState(0);
  const [selected, setSelected] = useState<string>();
  const [depth, setDepth] = useState<Depth>("short");
  const ownerName = useRef("");
  const ownerPassword = useRef("");
  const started = useRef(Date.now());
  const [now, setNow] = useState(Date.now());

  // Everything on screen comes from the state file and the journal, which the worker writes.
  useEffect(() => {
    const timer = setInterval(() => {
      setState(service.state());
      const next = journal.readFrom(offset.current);
      offset.current = next.offset;
      if (next.entries.length) setEntries((old) => [...old, ...next.entries]);
      setNow(Date.now());
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [service, journal]);

  const view = useMemo(
    () => journey(state, entries, { ...session, asking: askingFor(stage) }),
    [state, entries, session, stage],
  );
  const failed = view.rows.find((row) => row.status === "failed");
  const failure = failed && !state.running && !service.retryPending() ? failed : undefined;
  const moving = stage === "watch" || notice?.kind === "busy" || stage === "starting";
  const frame = useSpinnerFrame(moving);

  const reset = (next: Stage, message?: Notice) => {
    setNotice(message);
    setInputKey((key) => key + 1);
    setStage(next);
  };

  /** Records a question's outcome in the journal, so the support report has it too. */
  const record = useCallback(
    (step: string, startedAt: number, outcome: { result?: string; error?: string }) => {
      journal.append({ type: "step.start", step });
      const ms = Date.now() - startedAt;
      if (outcome.error) journal.append({ type: "step.fail", step, ms, error: outcome.error });
      else journal.append({ type: "step.done", step, ms, result: outcome.result });
    },
    [journal],
  );

  const checkPlatform = useCallback(
    async (input: PlatformInput): Promise<boolean> => {
      setNotice({ kind: "busy", text: "Checking the platform answers…" });
      const at = Date.now();
      try {
        const url = await service.checkPlatform(input);
        record("platform", at, { result: url });
        setPlatform(input);
        setSession((old) => ({ ...old, platformUrl: url }));
        reset("key", { kind: "ok", text: `The platform at ${url} answers.` });
        return true;
      } catch (err) {
        const error = message(err);
        record("platform", at, { error });
        reset(input.environment === "custom" ? "platform-url" : "platform", {
          kind: "error",
          text: error,
        });
        return false;
      }
    },
    [service, record],
  );

  const checkKey = useCallback(
    async (input: PlatformInput, key: string): Promise<boolean> => {
      setNotice({ kind: "busy", text: "Asking the platform whether it knows this key…" });
      const at = Date.now();
      try {
        const checked = await service.checkKey({ ...input, builderKey: key });
        const builder = `${checked.platform.owner.name} (#${checked.platform.owner.id})`;
        record("key", at, { result: builder });
        setBuilderKey(key);
        setSession((old) => ({ ...old, builder }));
        reset("mode", { kind: "ok", text: `Connecting as ${checked.platform.owner.name}.` });
        return true;
      } catch (err) {
        const error = message(err);
        record("key", at, { error });
        reset("key", { kind: "error", text: error });
        return false;
      }
    },
    [service, record],
  );

  // Where to begin: a fresh install asks (using the presets when they pass), anything else shows
  // where it stands.
  useEffect(() => {
    void (async () => {
      const current = service.view();
      if (current.phase !== "new") {
        if (current.phase === "failed") service.retry();
        return setStage(nextAfterProvisioning(current));
      }
      if (!presets.platformUrl) return setStage("platform");
      const preset = environmentForUrl(presets.platformUrl);
      if (!(await checkPlatform(preset))) return;
      if (presets.builderKey) await checkKey(preset, presets.builderKey);
    })();
    // Runs once, on start.
  }, []);

  // Provisioning finished: on to the login and the backup kit.
  useEffect(() => {
    if (stage === "watch" && isComplete(state)) {
      void service.refreshOwnerStatus().then(() => setStage(nextAfterProvisioning(service.view())));
    }
  }, [stage, state, service]);

  // The kit is written once, above the dashboard, when it is its turn.
  const kitWritten = useRef(false);
  useEffect(() => {
    if (stage !== "backup" || kitWritten.current) return;
    kitWritten.current = true;
    write(kitText(service.backupKit()));
  }, [stage, service, write]);

  // The final frame stays on screen after exit; the summary is in it.
  useEffect(() => {
    if (stage !== "done") return;
    outcome.finished = true;
    setState(service.state());
    const timer = setTimeout(exit, 500);
    return () => clearTimeout(timer);
  }, [stage, exit, outcome, service]);

  const watching = stage === "watch" || stage === "done";
  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") return exit();
      if (!watching) return;
      if (input === "q") return exit();
      if (key.escape) return setSelected(undefined);
      if (input === "r" && failure) {
        service.retry();
        return;
      }
      if (input === "?") return setDepth((old) => (old === "long" ? "short" : "long"));
      if (input === "d") return setDepth((old) => (old === "details" ? "short" : "details"));
      if (key.upArrow || key.downArrow) {
        const ids = view.rows.filter((row) => row.status !== "skipped").map((row) => row.id);
        const at = ids.indexOf(selected ?? focusRow(view.rows));
        const next = Math.min(Math.max(at + (key.upArrow ? -1 : 1), 0), ids.length - 1);
        setSelected(ids[next]);
      }
    },
    { isActive: true },
  );

  const focus = selected ?? (watching ? focusRow(view.rows) : questionRow(stage));
  const focusedRow = view.rows.find((row) => row.id === focus) ?? view.rows[0];
  const details = stepDetails(entries, focus ?? "")
    .slice(-8)
    .map(describeEntry);

  let panel: ReactNode;
  switch (stage) {
    case "starting":
      panel = (
        <QuestionPanel
          item={journeyItem("installed")}
          notice={{ kind: "busy", text: "Reading where setup stands…" }}
          frame={frame}
        >
          {null}
        </QuestionPanel>
      );
      break;
    case "platform":
      panel = (
        <QuestionPanel
          item={journeyItem("platform")}
          notice={notice}
          frame={frame}
          hint="Use ↑ ↓ and Enter. If you are not sure, ask the platform team."
        >
          <Select
            key={inputKey}
            isDisabled={notice?.kind === "busy"}
            options={ENVIRONMENTS.map((env) => ({
              value: env.id,
              label: `${env.label} · ${env.description}`,
            }))}
            onChange={(value) => {
              if (value === "custom") return reset("platform-url");
              void checkPlatform({ environment: value });
            }}
          />
        </QuestionPanel>
      );
      break;
    case "platform-url":
      panel = (
        <QuestionPanel
          item={journeyItem("platform")}
          notice={notice}
          frame={frame}
          hint="Type the platform's address and press Enter."
        >
          <LineInput
            key={inputKey}
            isDisabled={notice?.kind === "busy"}
            placeholder="https://… (or http://localhost:8086 for one on this computer)"
            onSubmit={(value) => void checkPlatform({ environment: "custom", customUrl: value })}
          />
        </QuestionPanel>
      );
      break;
    case "key":
      panel = (
        <QuestionPanel
          item={journeyItem("key")}
          notice={notice}
          frame={frame}
          hint="Paste it and press Enter. It is hidden as you paste."
        >
          <LineInput
            hidden
            key={inputKey}
            isDisabled={notice?.kind === "busy"}
            placeholder="bld_sk_…"
            onSubmit={(value) => platform && void checkKey(platform, value.trim())}
          />
        </QuestionPanel>
      );
      break;
    case "mode":
      panel = (
        <QuestionPanel
          item={journeyItem("mode")}
          notice={notice}
          frame={frame}
          hint="Use ↑ ↓ and Enter. This can never be changed later."
        >
          <Select
            key={inputKey}
            options={[
              {
                value: "segregated",
                label: "Segregated · each user holds their own funds (if you are not sure)",
              },
              { value: "shared", label: "Shared · your operations wallet pays for users' trades" },
            ]}
            onChange={(value) => {
              setMode(value);
              reset("confirm-mode");
            }}
          />
        </QuestionPanel>
      );
      break;
    case "confirm-mode":
      panel = (
        <QuestionPanel
          item={journeyItem("mode")}
          notice={notice}
          frame={frame}
          hint={`Type yes to confirm "${mode}" for good, or anything else to choose again.`}
        >
          <LineInput
            key={inputKey}
            isDisabled={notice?.kind === "busy"}
            placeholder="yes"
            onSubmit={(value) => {
              if (value.trim().toLowerCase() !== "yes") return reset("mode");
              if (!platform || !builderKey || !mode) return reset("platform");
              setNotice({ kind: "busy", text: "Saving your answers…" });
              const at = Date.now();
              service
                .start({ ...platform, builderKey, mode, confirmModeIsPermanent: true })
                .then(() => {
                  record("mode", at, { result: mode });
                  setSession((old) => ({ ...old, mode }));
                  reset("watch");
                })
                .catch((err: unknown) => reset("mode", { kind: "error", text: message(err) }));
            }}
          />
        </QuestionPanel>
      );
      break;
    case "owner-name":
    case "owner-password":
    case "owner-repeat":
      panel = (
        <QuestionPanel
          item={journeyItem("owner")}
          notice={notice}
          frame={frame}
          hint={
            stage === "owner-name"
              ? "Choose a username and press Enter."
              : stage === "owner-password"
                ? `Password for ${ownerName.current} (at least 12 characters).`
                : "The same password again."
          }
        >
          {stage === "owner-name" ? (
            <LineInput
              key={inputKey}
              placeholder="username"
              onSubmit={(value) => {
                ownerName.current = value.trim();
                reset("owner-password");
              }}
            />
          ) : (
            <LineInput
              hidden
              key={inputKey}
              isDisabled={notice?.kind === "busy"}
              onSubmit={(value) => {
                if (stage === "owner-password") {
                  ownerPassword.current = value;
                  return reset("owner-repeat");
                }
                if (value !== ownerPassword.current) {
                  return reset("owner-password", {
                    kind: "error",
                    text: "The two passwords are not the same.",
                  });
                }
                setNotice({ kind: "busy", text: "Creating your login…" });
                const at = Date.now();
                service
                  .createOwner(ownerName.current, ownerPassword.current)
                  .then(() => {
                    record("owner", at, { result: ownerName.current });
                    reset(service.view().backupAcknowledged ? "done" : "backup");
                  })
                  .catch((err: unknown) => {
                    record("owner", at, { error: message(err) });
                    reset("owner-name", { kind: "error", text: message(err) });
                  });
              }}
            />
          )}
        </QuestionPanel>
      );
      break;
    case "backup":
      panel = (
        <QuestionPanel
          item={journeyItem("backup")}
          notice={notice}
          frame={frame}
          hint="It is printed above this box. Copy all of it into a password manager, then type saved and press Enter. Never send it to anyone."
        >
          <LineInput
            key={inputKey}
            placeholder="saved"
            onSubmit={(value) => {
              if (value.trim().toLowerCase() !== "saved") {
                return reset("backup", {
                  kind: "error",
                  text: 'Type "saved" once the kit is stored safely.',
                });
              }
              service.acknowledgeBackup();
              record("backup", Date.now(), { result: "saved" });
              reset("done");
            }}
          />
        </QuestionPanel>
      );
      break;
    case "watch":
      panel =
        failure && !selected ? (
          <FailurePanel row={failure} reference={reference(state.installId, failure.id, entries)} />
        ) : focusedRow ? (
          <StepPanel row={focusedRow} depth={depth} details={details} />
        ) : null;
      break;
    case "done": {
      const operatorKey =
        service.connectionDetails()?.operatorKey ?? "(reveal it in the admin dashboard)";
      panel = (
        <DonePanel
          lines={[
            ["Wallet manager address", managerPublicUrl],
            ["Backend key", operatorKey],
            ["Admin dashboard", `${managerPublicUrl}/admin`],
            ["Install reference", state.installId ?? "-"],
          ]}
        />
      );
      break;
    }
  }

  return (
    <Frame
      journey={view}
      selectedId={focus}
      elapsedMs={now - started.current}
      width={width}
      frame={frame}
      keys={keysFor(stage, Boolean(failure))}
    >
      {panel}
    </Frame>
  );
}

function askingFor(stage: Stage): Session["asking"] {
  if (stage === "platform" || stage === "platform-url") return "platform";
  if (stage === "key" || stage === "mode") return stage;
  if (stage === "confirm-mode") return "mode";
  if (stage.startsWith("owner")) return "owner";
  if (stage === "backup") return "backup";
  return undefined;
}

function questionRow(stage: Stage): string | undefined {
  return askingFor(stage) ?? undefined;
}

/** The row the panel follows when nobody chose one: the one that is moving, or the next. */
function focusRow(rows: ReturnType<typeof journey>["rows"]): string {
  const live = rows.find(
    (row) => row.status === "failed" || row.status === "running" || row.status === "asking",
  );
  return (
    (live ?? rows.find((row) => row.status === "pending") ?? rows[rows.length - 1])?.id ??
    "installed"
  );
}

function nextAfterProvisioning(view: {
  phase: string;
  ownerCreated: boolean;
  backupAcknowledged: boolean;
}): Stage {
  if (view.phase !== "done") return "watch";
  if (!view.ownerCreated) return "owner-name";
  if (!view.backupAcknowledged) return "backup";
  return "done";
}

function keysFor(stage: Stage, failed: boolean): string {
  if (stage === "watch") {
    return [
      "↑↓ steps",
      "? explain",
      "d details",
      ...(failed ? ["r try again", "esc back"] : []),
      "q leave (setup carries on)",
    ].join(" · ");
  }
  if (stage === "done") return "Setup is complete.";
  return "Enter to answer · Ctrl+C to leave and come back later";
}

/** What support needs to find this failure in the report: the install, the step, the moment. */
function reference(installId: string | undefined, step: string, entries: JournalEntry[]): string {
  const failure = [...entries]
    .reverse()
    .find((entry) => entry.type === "step.fail" && entry.step === step);
  const at = (failure?.at ?? new Date().toISOString()).slice(0, 19).replace("T", " ");
  return `${installId ?? "new"} · ${step} · ${at} UTC`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
