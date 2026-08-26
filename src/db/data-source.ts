import "dotenv/config";

import { DataSource } from "typeorm";

import { databaseOptions } from "./client";

/**
 * The data source the TypeORM CLI reads (`-d src/db/data-source.ts`).
 *
 * Only authoring and inspection go through here — `db:generate`, `db:migrate`, `db:revert`,
 * `db:check`. The service builds its own from `CONFIG`, and both come from `databaseOptions`,
 * so a migration cannot be generated against a different schema than the service runs.
 */
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to run the TypeORM CLI");
}

export default new DataSource(databaseOptions(databaseUrl));
