import type { EntityManager } from "typeorm";

/**
 * Injection tokens for the collaborators that are not classes. Kept in one file so a provider and
 * its consumers cannot drift onto two different symbols.
 */
export const CONFIG = Symbol("CONFIG");
export const DB = Symbol("DB");
export const SECRETS = Symbol("SECRETS");
export const TRANSACTION = Symbol("TRANSACTION");

/** Runs `work` inside a transaction, handing it the manager every repository method accepts. */
export type Transaction = <T>(work: (manager: EntityManager) => Promise<T>) => Promise<T>;
