import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { ApiKeyService } from "../api-keys/api-key.service";
import type { Actor } from "../common/actor";
import { AppModule } from "../app.module";
import { configureApp } from "../app.setup";
import { API_KEY_HEADER } from "../common/guards/api-key.guard";
import { loadConfig } from "../config";
import type { Db } from "../db/client";
import { runMigrations } from "../db/migrate";
import { ApiKeyRepository } from "../db/repositories/api-key.repo";
import { AuditRepository } from "../db/repositories/audit.repo";
import { OperationRepository } from "../db/repositories/operation.repo";
import { PlatformSettingsRepository } from "../db/repositories/platform-settings.repo";
import { WalletRepository } from "../db/repositories/wallet.repo";
import { AuditLog } from "../observability/audit";
import { CONFIG, DB } from "../tokens";
import { FAKE_UPSTREAM_API_KEY, FakeDpmWallet } from "./fake-dpm-wallet";
import { createTestDatabase } from "./pg-test-db";
import { testEnv } from "./env";

export type RequestOptions = {
  body?: unknown;
  /** `null` sends no key at all, which is how the unauthenticated cases are written. */
  apiKey?: string | null;
  idempotencyKey?: string;
  query?: Record<string, string | number>;
};

export type HttpResult<T = any> = { status: number; body: T };

export type Harness = {
  app: INestApplication;
  db: Db;
  /** The stand-in dpm-wallet this boot is pointed at; assert on `upstream.requests`. */
  upstream: FakeDpmWallet;
  /** Resolved out of the container, so a test asserts against the instance the app is using. */
  wallets: WalletRepository;
  settings: PlatformSettingsRepository;
  keys: ApiKeyRepository;
  operations: OperationRepository;
  auditRepo: AuditRepository;
  audit: AuditLog;
  /** Minted during boot; the default credential every request below carries. */
  adminKey: string;
  operatorKey: string;
  get: <T = any>(path: string, options?: RequestOptions) => Promise<HttpResult<T>>;
  post: <T = any>(path: string, options?: RequestOptions) => Promise<HttpResult<T>>;
  patch: <T = any>(path: string, options?: RequestOptions) => Promise<HttpResult<T>>;
  del: <T = any>(path: string, options?: RequestOptions) => Promise<HttpResult<T>>;
  /**
   * Shuts the container down but leaves the database intact, for the specs that boot a second
   * container over the same rows. Idempotent.
   */
  stop: () => Promise<void>;
  /** `stop()`, plus dropping the database this boot created. Idempotent. */
  close: () => Promise<void>;
};

export type HarnessOptions = {
  /** Skips minting the default keys, for the specs that test the empty-table behaviour. */
  withoutKeys?: boolean;
  /** Reuses a stand-in across reboots, the way a real dpm-wallet outlives a container. */
  upstream?: FakeDpmWallet;
};

/**
 * Boots the real application against a throwaway Postgres database.
 *
 * dpm-wallet is replaced by a real HTTP server rather than a stubbed client class, so the client's
 * own headers, error translation and timeout are exercised too. Everything else is the actual
 * application: guards, interceptor, validation pipe, exception filter, migrations, repositories.
 * The parts most likely to be wrong are exactly the ones a hand-wired subset would skip.
 *
 * Pass `DATABASE_URL` to boot against a database the caller owns; that is how a restart test gets
 * two boots over one set of rows. Anything else gets a fresh database that `close()` drops.
 */
export async function startHarness(
  overrides: Record<string, string> = {},
  options: HarnessOptions = {},
): Promise<Harness> {
  const ownedDatabase = overrides.DATABASE_URL ? undefined : await createTestDatabase();
  const upstream = options.upstream ?? new FakeDpmWallet();
  const upstreamBaseUrl = options.upstream ? upstream.baseUrl : await upstream.start();
  // Everything from here on can throw — a rejected config, a failed migration, a startup abort —
  // and every one of those has to give the database and the stand-in server back. Without this a
  // spec asserting a startup failure leaves a listening socket behind, and jest hangs at exit
  // instead of reporting anything.
  try {
    return await boot();
  } catch (err) {
    if (!options.upstream) await upstream.stop().catch(() => undefined);
    await ownedDatabase?.drop().catch(() => undefined);
    throw err;
  }

  async function boot(): Promise<Harness> {
    const env = testEnv({
      ...(ownedDatabase ? { DATABASE_URL: ownedDatabase.url } : {}),
      DPM_WALLET_BASE_URL: upstreamBaseUrl,
      DPM_WALLET_API_KEY: FAKE_UPSTREAM_API_KEY,
      // Specs own key setup via the harness. Only the boot-adoption e2e opts in by setting
      // BOOTSTRAP_ADMIN_KEY (and then StartupService must be allowed to run).
      ...(overrides.DPM_WALLET_MANAGER_BOOTSTRAP_ADMIN_KEY
        ? {}
        : { DPM_WALLET_MANAGER_SKIP_STARTUP_KEY_BOOTSTRAP: "1" }),
      ...overrides,
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CONFIG)
      .useValue(loadConfig(env))
      .compile();

    const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApp(app, loadConfig(env));
    // The service does not migrate itself, so a test applies the schema the way a deploy does:
    // after the pool is open, before anything boots against it.
    await runMigrations(app.get<Db>(DB));
    await initOrClose(app, async () => {
      if (!options.upstream) await upstream.stop();
      await ownedDatabase?.drop();
    });

    const keyService = app.get(ApiKeyService);
    let adminKey = "";
    let operatorKey = "";
    if (!options.withoutKeys) {
      const bootstrapped = await keyService.bootstrap("harness-admin");
      // A second container over the same database finds the keys already there and mints nothing,
      // so the credential has to be recovered rather than assumed — which is what an operator
      // restarting the service does through the reveal endpoint.
      const systemActor: Actor = {
        keyId: bootstrapped.key.id,
        role: "admin",
        prefix: bootstrapped.key.prefix,
        name: "harness",
      };
      adminKey = bootstrapped.created
        ? bootstrapped.key.key
        : (await keyService.reveal(bootstrapped.key.id, systemActor)).key;

      const existingOperator = (await keyService.list()).find(
        (key) => key.role === "operator" && key.status === "active",
      );
      // Minted through the API's own path, so the operator credential a test uses is one an admin
      // could actually have created.
      operatorKey = existingOperator
        ? (await keyService.reveal(existingOperator.id, systemActor)).key
        : (await keyService.create({ role: "operator", name: "harness-operator" }, undefined)).key;
    }

    let stopped = false;
    const stop = async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      await app.close();
      // Only a stand-in this boot owns is stopped; a shared one outlives the container by design.
      if (!options.upstream) await upstream.stop();
    };

    const send = async <T>(
      method: "get" | "post" | "patch" | "delete",
      path: string,
      requestOptions: RequestOptions = {},
    ): Promise<HttpResult<T>> => {
      const call = request(app.getHttpServer())[method](path);
      if (requestOptions.query) void call.query(requestOptions.query);
      const apiKey = requestOptions.apiKey === undefined ? adminKey : requestOptions.apiKey;
      void call.set("Content-Type", "application/json");
      if (apiKey !== null && apiKey !== "") void call.set(API_KEY_HEADER, apiKey);
      if (requestOptions.idempotencyKey) {
        void call.set("Idempotency-Key", requestOptions.idempotencyKey);
      }
      const response = await (requestOptions.body === undefined
        ? call.send()
        : call.send(requestOptions.body as object));
      return { status: response.status, body: response.body as T };
    };

    return {
      app,
      db: app.get<Db>(DB),
      upstream,
      wallets: app.get(WalletRepository),
      settings: app.get(PlatformSettingsRepository),
      keys: app.get(ApiKeyRepository),
      operations: app.get(OperationRepository),
      auditRepo: app.get(AuditRepository),
      audit: app.get(AuditLog),
      adminKey,
      operatorKey,
      get: (path, requestOptions) => send("get", path, requestOptions),
      post: (path, requestOptions) => send("post", path, requestOptions),
      patch: (path, requestOptions) => send("patch", path, requestOptions),
      del: (path, requestOptions) => send("delete", path, requestOptions),
      // Never `app.close()` on its own from a spec: the stand-in HTTP server would stay listening
      // and jest would hang at exit on the open handle rather than failing anything.
      stop,
      // Dropped after the app closes, so the pool is drained and no session is left holding the
      // database open. A caller-supplied database is the caller's to drop.
      close: async () => {
        await stop();
        await ownedDatabase?.drop();
      },
    };
  }
}

/**
 * A boot that fails during startup leaves the pool and the stand-in server open, so everything
 * this call created has to be torn down before the failure is re-thrown. Without it, the specs
 * that assert a startup abort would leak a listening socket and a database per run.
 */
async function initOrClose(app: INestApplication, cleanUp: () => Promise<void>): Promise<void> {
  try {
    await app.init();
  } catch (err) {
    await app.close().catch(() => undefined);
    await cleanUp().catch(() => undefined);
    throw err;
  }
}
