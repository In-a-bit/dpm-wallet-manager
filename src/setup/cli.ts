import readline from "node:readline/promises";

import { ENVIRONMENTS } from "./environments";
import { SetupError } from "./platform-config";
import type { SetupService } from "./setup-service";
import { progress } from "./steps";

/**
 * The same flow as the page, in a terminal, for a server with no screen. It asks the same
 * questions in the same order and calls the same SetupService, so the two cannot drift apart.
 */
export async function runCli(
  service: SetupService,
  readState: () => Parameters<typeof progress>[0],
): Promise<void> {
  const io = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (readState().running) {
      throw new SetupError("Setup is already running from the browser page. Follow it there.");
    }
    if (service.view().phase === "new") await askAndStart(io, service);
    else console.log("\nSetup was already started; resuming.\n");
    await runWithProgress(service, readState);
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

async function askAndStart(io: readline.Interface, service: SetupService): Promise<void> {
  console.log("\nDPM Custody Setup\n");
  const environment = await choose(
    io,
    "Which platform are you joining?",
    ENVIRONMENTS.map((e) => [e.id, `${e.label} - ${e.description}`]),
  );
  const customUrl =
    environment === "custom"
      ? await io.question(
          "Platform address (https://…, or http://localhost:8086 for one on this computer): ",
        )
      : undefined;
  const builderKey = await askForKey(io, service, environment, customUrl);
  const mode = await choose(io, "How should your users' funds be held?", [
    ["segregated", "Each user holds their own funds (choose this if you are not sure)"],
    ["shared", "Your company's operations wallet pays for users' trades"],
  ]);
  const confirmed = await io.question(
    `Type "yes" to confirm "${mode}" can never be changed later: `,
  );
  await service.start({
    environment,
    customUrl,
    builderKey,
    mode,
    confirmModeIsPermanent: confirmed.trim().toLowerCase() === "yes",
  });
}

async function askForKey(
  io: readline.Interface,
  service: SetupService,
  environment: string,
  customUrl: string | undefined,
): Promise<string> {
  for (;;) {
    const builderKey = await io.question("Paste your builder private key (bld_sk_…): ");
    try {
      const checked = await service.checkKey({ environment, customUrl, builderKey });
      console.log(`✓ Connecting as ${checked.platform.owner.name}.\n`);
      return builderKey;
    } catch (err) {
      if (!(err instanceof SetupError)) throw err;
      console.log(`✕ ${err.message}\n`);
    }
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
    const answer = Number((await io.question("Enter a number: ")).trim());
    const picked = options[answer - 1];
    if (picked) return picked[0] as string;
  }
}

async function runWithProgress(
  service: SetupService,
  readState: () => Parameters<typeof progress>[0],
): Promise<void> {
  const printed = new Set<string>();
  const timer = setInterval(() => printNewlyDone(readState(), printed), 1000);
  try {
    await service.runToCompletion();
  } finally {
    clearInterval(timer);
    printNewlyDone(readState(), printed);
  }
}

function printNewlyDone(state: Parameters<typeof progress>[0], printed: Set<string>): void {
  for (const step of progress(state)) {
    if (step.status !== "done" || printed.has(step.id)) continue;
    printed.add(step.id);
    console.log(`✓ ${step.label}`);
  }
}

/** The admin UI's first owner, asked for here exactly as the page asks for it. */
async function createOwnerLogin(io: readline.Interface, service: SetupService): Promise<void> {
  await service.refreshOwnerStatus();
  if (service.view().ownerCreated) return;
  console.log("\nCreate your login for the admin dashboard.");
  for (;;) {
    const username = await io.question("Username: ");
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
 * A question whose answer is not echoed. readline has no switch for this, so the prompt is
 * written first and every echo of the answer is then swallowed until Enter.
 */
async function askHidden(io: readline.Interface, prompt: string): Promise<string> {
  const echo = io as unknown as { _writeToOutput: (text: string) => void };
  const original = echo._writeToOutput.bind(io);
  process.stdout.write(prompt);
  echo._writeToOutput = () => undefined;
  try {
    return await io.question("");
  } finally {
    echo._writeToOutput = original;
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
    "(It is also kept in this install's config volume; ./dpm-custody backup-kit prints it again.)",
  );
  await io.question("\nPress Enter once you have saved it. ");
  service.acknowledgeBackup();
}

function printConnection(service: SetupService): void {
  const details = service.connectionDetails();
  if (!details) return;
  console.log("\nYour install is running. Give your backend:");
  console.log(`  Backend key: ${details.operatorKey}`);
  console.log("  Wallet manager address: see ./dpm-custody status");
  console.log("Admin dashboard: <wallet manager address>/admin, signed in with the login above.\n");
}
