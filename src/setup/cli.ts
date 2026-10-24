import readline from "node:readline/promises";
import { Writable } from "node:stream";

import { journeyItem } from "./catalog";
import { environmentForUrl, ENVIRONMENTS } from "./environments";
import { describeEntry, formatDuration } from "./journey";
import type { Journal, JournalEntry } from "./journal";
import { SetupError } from "./platform-config";
import type { PlatformInput, SetupService } from "./setup-service";
import { isComplete, progress } from "./steps";

const POLL_MS = 500;
const SUPPORT_HINT =
  'For help, run "./dpm-custody support" and send the file it writes to the platform team.';

/**
 * Setup without the dashboard, for when there is no terminal to draw it in (a script, CI, a log).
 * It asks the same questions as the dashboard through the same SetupService, then prints each
 * journal event as a line while the worker provisions.
 */
/**
 * Answers given before the terminal flow starts, by an installer that has already checked them.
 * Each is checked again here, from inside the install, and asked for if it does not pass.
 */
export type CliPresets = { platformUrl?: string; builderKey?: string };

export async function runCli(
  service: SetupService,
  readState: () => Parameters<typeof progress>[0],
  presets: CliPresets = {},
  journal?: Journal,
): Promise<void> {
  const io = readline.createInterface({
    input: process.stdin,
    output: terminal,
    terminal: Boolean(process.stdout.isTTY),
  });
  answers(io); // Listening from the start, so no piped line is lost.
  try {
    if (readState().running) {
      console.log("\nSetup is running; following it.\n");
    }
    const view = service.view();
    if (view.phase === "done" && view.ownerCreated && view.backupAcknowledged) {
      console.log("\n✓ Setup is already done.");
      printConnection(service);
      return;
    }
    if (view.phase === "new") await askAndStart(io, service, presets);
    else if (view.phase === "failed") service.retry();
    await followWorker(service, journal);
    await createOwnerLogin(io, service);
    await handOverBackupKit(io, service);
    printConnection(service);
  } catch (err) {
    console.error(`\n✕ ${err instanceof Error ? err.message : String(err)}`);
    console.error('  Fix the problem, then run "./dpm-custody setup" again to continue.\n');
    process.exitCode = 1;
  } finally {
    io.close();
  }
}

async function askAndStart(
  io: readline.Interface,
  service: SetupService,
  presets: CliPresets,
): Promise<void> {
  console.log("\nDPM Custody Setup\n");
  const platform = await askForPlatform(io, service, presets.platformUrl);
  const builderKey = await askForKey(io, service, platform, presets.builderKey);
  const mode = await askForMode(io);
  await service.start({ ...platform, builderKey, mode, confirmModeIsPermanent: true });
}

/** Asks until the chosen platform answers, so a wrong address is not mistaken for a wrong key. */
async function askForPlatform(
  io: readline.Interface,
  service: SetupService,
  preset: string | undefined,
): Promise<PlatformInput> {
  if (preset) {
    const platform = environmentForUrl(preset);
    if (await platformAnswers(service, platform)) return platform;
  }
  for (;;) {
    const environment = await choose(
      io,
      "Which platform are you joining?",
      ENVIRONMENTS.map((e) => [e.id, `${e.label} - ${e.description}`]),
    );
    const customUrl =
      environment === "custom"
        ? await ask(
            io,
            "Platform address (https://…, or http://localhost:8086 for one on this computer): ",
          )
        : undefined;
    if (await platformAnswers(service, { environment, customUrl })) {
      return { environment, customUrl };
    }
  }
}

async function platformAnswers(service: SetupService, platform: PlatformInput): Promise<boolean> {
  try {
    const url = await service.checkPlatform(platform);
    console.log(`✓ The platform at ${url} answers.\n`);
    return true;
  } catch (err) {
    if (!(err instanceof SetupError)) throw err;
    console.log(`✕ ${err.message}\n`);
    return false;
  }
}

async function askForKey(
  io: readline.Interface,
  service: SetupService,
  platform: PlatformInput,
  preset: string | undefined,
): Promise<string> {
  let builderKey = preset ?? (await askHidden(io, "Paste your builder private key (bld_sk_…): "));
  for (;;) {
    try {
      const checked = await service.checkKey({ ...platform, builderKey });
      console.log(`✓ Connecting as ${checked.platform.owner.name}.\n`);
      return builderKey;
    } catch (err) {
      if (!(err instanceof SetupError)) throw err;
      console.log(`✕ ${err.message}\n`);
    }
    builderKey = await askHidden(io, "Paste your builder private key (bld_sk_…): ");
  }
}

/** The mode is permanent, so it is taken only once it has been confirmed; otherwise asked again. */
async function askForMode(io: readline.Interface): Promise<string> {
  for (;;) {
    const mode = await choose(io, "How should your users' funds be held?", [
      ["segregated", "Each user holds their own funds (choose this if you are not sure)"],
      ["shared", "Your company's operations wallet pays for users' trades"],
    ]);
    const confirmed = await ask(
      io,
      `Type "yes" to confirm "${mode}" can never be changed later, or anything else to choose again: `,
    );
    if (confirmed.trim().toLowerCase() === "yes") {
      console.log(`✓ ${mode}\n`);
      return mode;
    }
    console.log("");
  }
}

async function choose(
  io: readline.Interface,
  question: string,
  options: string[][],
): Promise<string> {
  console.log(question);
  options.forEach(([, text], i) => console.log(`  ${i + 1}) ${text}`));
  for (;;) {
    const answer = Number((await ask(io, "Enter a number: ")).trim());
    const picked = options[answer - 1];
    if (picked) return picked[0] as string;
  }
}

/** Prints what the worker journals until provisioning is done, or stops at its first failure. */
async function followWorker(service: SetupService, journal: Journal | undefined): Promise<void> {
  let offset = journal ? journal.readFrom(0).offset : 0;
  for (;;) {
    if (journal) {
      const next = journal.readFrom(offset);
      offset = next.offset;
      next.entries.forEach(printEntry);
    }
    const state = service.state();
    if (isComplete(state)) return;
    if (state.lastError && !state.running && !service.retryPending()) {
      const failed = progress(state).find((step) => step.status === "failed");
      const fix = failed ? journeyItem(failed.id).fix : "";
      throw new SetupError(`${state.lastError}\n  What to try: ${fix}\n  ${SUPPORT_HINT}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

function printEntry(entry: JournalEntry): void {
  if (entry.type === "step.start") console.log(`▸ ${journeyItem(entry.step).title}`);
  else if (entry.type === "step.done") {
    console.log(`✓ ${journeyItem(entry.step).title} (${formatDuration(entry.ms)})`);
  } else if (entry.type === "step.fail") console.log(`✕ ${journeyItem(entry.step).title}`);
  else if (entry.type === "step.progress") console.log(`  ${describeEntry(entry)}`);
}

/** The admin UI's first owner, asked for here exactly as the page asks for it. */
async function createOwnerLogin(io: readline.Interface, service: SetupService): Promise<void> {
  await service.refreshOwnerStatus();
  if (service.view().ownerCreated) return;
  console.log("\nCreate your login for the admin dashboard.");
  for (;;) {
    const username = await ask(io, "Username: ");
    const password = await askHidden(io, "Password (at least 12 characters): ");
    if ((await askHidden(io, "Password again: ")) !== password) {
      console.log("✕ The two passwords are not the same.\n");
      continue;
    }
    try {
      await service.createOwner(username, password);
      console.log("✓ Login created.");
      return;
    } catch (err) {
      if (!(err instanceof SetupError)) throw err;
      console.log(`✕ ${err.message}\n`);
    }
  }
}

/**
 * Where readline writes: the terminal, with a switch that swallows readline's echo while a hidden
 * answer is typed. readline has no such switch of its own.
 */
class Terminal extends Writable {
  muted = false;

  get columns(): number | undefined {
    return process.stdout.columns;
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
    if (!this.muted) process.stdout.write(chunk);
    done();
  }
}

const terminal = new Terminal();

/**
 * Answers in arrival order. readline's own question() drops a line that arrives before it is
 * asked, which is every line when the answers are piped in at once, as a script does.
 */
const pending = new WeakMap<
  readline.Interface,
  { lines: string[]; closed: boolean; wake?: () => void }
>();

function answers(io: readline.Interface) {
  let queue = pending.get(io);
  if (!queue) {
    const created: { lines: string[]; closed: boolean; wake?: () => void } = {
      lines: [],
      closed: false,
    };
    io.on("line", (line) => {
      created.lines.push(line);
      created.wake?.();
    });
    io.on("close", () => {
      created.closed = true;
      created.wake?.();
    });
    pending.set(io, created);
    queue = created;
  }
  return queue;
}

async function ask(io: readline.Interface, prompt: string): Promise<string> {
  const queue = answers(io);
  if (prompt) process.stdout.write(prompt);
  for (;;) {
    const line = queue.lines.shift();
    if (line !== undefined) return line;
    if (queue.closed) throw new SetupError("No answer was given (the input ended).");
    await new Promise<void>((resolve) => (queue.wake = resolve));
  }
}

/** A question whose answer is not echoed: the prompt is written first, then the echo is muted. */
async function askHidden(io: readline.Interface, prompt: string): Promise<string> {
  process.stdout.write(prompt);
  terminal.muted = true;
  try {
    return await ask(io, "");
  } finally {
    terminal.muted = false;
    process.stdout.write("\n");
  }
}

async function handOverBackupKit(io: readline.Interface, service: SetupService): Promise<void> {
  if (service.view().backupAcknowledged) return;
  console.log(
    "\n──────── BACKUP KIT ─ copy everything between the lines somewhere safe ────────\n",
  );
  console.log(service.backupKit());
  console.log("───────────────────────────────────────────────────────────────────────────────");
  console.log(
    "(./dpm-custody backup-kit prints it again, except the backup recovery key: that is shown only now.)",
  );
  await ask(io, "\nPress Enter once you have saved it. ");
  service.acknowledgeBackup();
}

function printConnection(service: SetupService): void {
  const details = service.connectionDetails();
  if (!details) {
    console.log(
      "\nYour install is running. Reveal your backend key in the admin dashboard (API keys).",
    );
    return;
  }
  console.log("\nYour install is running. Give your backend:");
  console.log(`  Backend key: ${details.operatorKey}`);
  console.log("  Wallet manager address: see ./dpm-custody status");
  console.log("Admin dashboard: <wallet manager address>/admin, signed in with the login above.\n");
}
