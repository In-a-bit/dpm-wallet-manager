import "dotenv/config";

import { NestFactory } from "@nestjs/core";

// stdout is the key and nothing else, so `KEY=$(npm run --silent keys:bootstrap)` works. The
// service's ordinary info logging — opening and closing the pool — would otherwise interleave
// with it, and the pool closes *after* the key is written.
process.env.LOG_LEVEL = "error";

import { AppModule } from "../app.module";
import { logError } from "../observability/log";
import { ApiKeyService } from "./api-key.service";

/**
 * Mints the first admin key, as its own process.
 *
 * A separate command rather than something the service does at boot: a container that seeds a
 * credential on startup has to print it somewhere, and "somewhere" is the log aggregator. Run
 * once, by a person, with the output going to the terminal they are sitting at.
 *
 * The whole application context is created — not just the repository — so the key is written by
 * exactly the code path the running service verifies against.
 */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const { key, created } = await app.get(ApiKeyService).bootstrap(process.argv[2] ?? "bootstrap");
    if (!created) {
      process.stderr.write(
        `API keys already exist; nothing was minted. The active admin key is ${key.prefix}… — ` +
          "reveal it through the API rather than re-bootstrapping.\n",
      );
      return;
    }
    process.stderr.write("Admin API key minted. It is shown once and is not recoverable here:\n");
    process.stdout.write(`${key.key}\n`);
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  logError("keys.bootstrap_failed", { err });
  process.exit(1);
});
