# Custody Operational Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A custody install keeps bounded logs and tables, pages every list, survives restarts
without lost or doubled work, and upgrades (and rolls back) safely.

**Architecture:** Each service gains a background `RetentionService` that trims in batches, plus
cursor paging on its unbounded lists and a DB readiness probe. The deploy bundle gains log caps,
healthchecks, digest-pinned and checksummed releases, and a `dpm-custody upgrade` that is
health-gated and rolls itself back.

**Tech Stack:**
- NestJS 11, TypeORM, Postgres 18, Jest (DB-backed through `TEST_DATABASE_URL`).
- Vite + React admin UI.
- Docker Compose; bash for `deploy/dpm-custody` and `install.sh`; PowerShell for `install.ps1`.
- GitHub Actions.

**Spec:** `dpm-wallet-manager/docs/superpowers/specs/2026-10-23-custody-operational-hardening-design.md`

Repos: `M` = `/home/yuvala/Documents/prediction-claude/dpm-wallet-manager`,
`W` = `/home/yuvala/Documents/prediction-claude/dpm-wallet`. Both are on branch `ops-hardening`
(from `main`).

## Global Constraints

- **Local only:**
  - Never touch dev.
  - Never push, tag or release.
  - Commits stay on `ops-hardening`.
- **No new runtime dependencies:** plain `setInterval`/`setTimeout`, not `@nestjs/schedule`.
- **API compatibility:** existing API responses only gain fields. Offset paging keeps working
  without `cursor`.
- **Retention env:**
  - `OPERATIONS_RETENTION_DAYS` (default 90), `ROUTED_ORDER_RETENTION_DAYS` (default 365), and
    `RETENTION_ENABLED` (default `true`).
  - Days are whole numbers from 1 to 3650. Routed may not be below operations.
  - A bad value fails the boot.
- **Routine operation kinds:** `order`, `cancel`, `allowance`, `redeem`, `split`, `merge`.
  `withdraw` is never deleted.
- **Routine audit actions:**
  - `sign.order`, `sign.cancel`, `meta.allowance`, `meta.redeem`, `meta.split`, `meta.merge`.
  - Only with `outcome = 'success'`. Every other audit row is never deleted.
- **Routed order rule:** a manager `order` row with `signer_wallet_id <> wallet_id` uses the routed
  retention.
- **Batching and scheduling:**
  - Batch size 5000, at most 100 batches per table per run.
  - First run 60 s after start, then hourly. Runs never overlap.
  - A failure logs `retention.failed` and never throws out of the timer.
  - Each run logs `retention.run` with `{ table: deletedCount }`.
- **Paging:** limit cap 200, default 50 (the existing `PaginationDto`). Cursor errors:
  - manager: 400 `INVALID_CURSOR`;
  - dpm-wallet: its existing validation error shape.
- **Readiness:** `GET /v1/health/ready` is public, runs `SELECT 1`, and answers 200
  `{status:"ok"}` or 503 `{status:"unavailable"}`.
- **Compose:**
  - Logging: json-file, `max-size: 20m`, `max-file: 5`.
  - Healthcheck: `interval: 10s`, `timeout: 5s`, `retries: 6`, `start_period: 60s`.
- **Upgrade:**
  - Health gate 5 minutes.
  - Disk floor is 2× the database size plus 1 GB.
  - `*.prev` files are mode 600.
  - Rollback reverts only the image tags and `DPM_CUSTODY_VERSION` in `.env`.
- **CLI portability:** `deploy/dpm-custody` and `install.sh` stay portable bash. No GNU-only flags
  (`sed -i` needs a suffix, as the existing `set_env` does).
- **Checks:** in each repo, `npm run lint`, `npm run typecheck` and `npm test` (e2e where touched)
  pass. Pre-existing failures are reported, not fixed.
- **Local installs:**
  - `~/dpm-custody-segregated` (manager :3001) and `~/dpm-custody-shared` (:3002), images
    `ghcr.io/in-a-bit/dpm-wallet{,-manager}:local`.
  - Ask the user before any step that stops, upgrades or rolls back one of them.

## Review Focus

1. **A cancel for an old shared-mode order.** Purging must keep routed `order` rows for 365 days.
   The test seeds a 200-day-old routed order and a 200-day-old direct order, and only the direct
   one goes (Task 1).
2. **A cursor taken from the second page while new rows arrive.** Newer rows must not shift or
   repeat items on older pages. The test inserts rows between page fetches (Tasks 3 and 4).
3. **A retry after a crash mid-transfer.** It must not produce a second signed nonce (Task 7).
4. **An upgrade where the new manager crash-loops on migration.** It must roll back by itself to
   the previous tags, leave the operator's other `.env` edits intact, and report it (Task 10).
5. **An install created before this work, with no `DPM_CUSTODY_VERSION`.** `upgrade` must
   proceed once, say the version is unknown, and record the target (Task 10).

---

### Task 1: Manager retention (config, indexes, purge, scheduler)

**Files:**
- Modify: `M/src/config.ts`, `M/src/config.spec.ts`
- Create: `M/src/db/migrations/1793000000000-RetentionIndexes.ts`
- Modify: `M/src/db/repositories/{operation,audit,idempotency,ui-session}.repo.ts`
- Create: `M/src/retention/retention.service.ts`, `M/src/retention/retention.module.ts`,
  `M/src/retention/retention.service.spec.ts`
- Modify: `M/src/app.module.ts`, `M/.env.example` (if present)

**Interfaces:**
- Produces:
  - `Config.retention: { enabled: boolean; operationsDays: number; routedOrderDays: number }`.
  - `OperationRepository.purgeRoutine(cutoff: string, routedCutoff: string, batch: number): Promise<number>`.
    It deletes one batch and returns the count.
  - `AuditRepository.purgeRoutine(cutoff: string, batch: number): Promise<number>`.
  - `IdempotencyRepository.purgeExpired` and `UiSessionRepository.purgeExpired` are reused as is.
  - `RetentionService.runOnce(now?: Date): Promise<Record<string, number>>`.

- [ ] **Step 1: config tests** (`config.spec.ts`):
  - defaults are `{enabled:true, operationsDays:90, routedOrderDays:365}`;
  - `OPERATIONS_RETENTION_DAYS=0` throws, and so does `3651` and `abc`;
  - routed `30` with operations `90` throws;
  - `RETENTION_ENABLED=false` gives `enabled:false`, and `RETENTION_ENABLED=maybe` throws.
- [ ] **Step 2:** implement in `loadConfig` with `parsePositiveInt`'s style plus range checks.
  Run `npx jest src/config.spec.ts` and expect PASS.
- [ ] **Step 3: migration** `RetentionIndexes`. `up` creates:
  - `operations_created_at_id` on `operations (created_at, id)`;
  - `operations_order_result_summary` on `operations (result_summary) WHERE kind = 'order'`;
  - `audit_events_created_at_id` on `audit_events (created_at, id)`.

  `down` drops all three. It is additive only. Run `npm run db:migrate` against the dev DB and
  `npm run db:check`, and expect it to apply.
- [ ] **Step 4: repo tests** (`retention.service.spec.ts`, DB-backed through `pg-test-db`).
  Seeds:
  - operations: a direct `order` 100 days old (deleted), a direct `order` 10 days old (kept), a
    routed `order` 200 days old (kept) and 400 days old (deleted), a `withdraw` 1000 days old
    (kept), and a `merge` 100 days old (deleted);
  - audit: `sign.order` success 100 days old (deleted), `sign.order` denied 100 days old (kept),
    `meta.withdraw` success 1000 days old (kept), and `api_key.create` 1000 days old (kept);
  - an idempotency key past expiry (deleted).

  `runOnce()` returns counts matching that, and a second `runOnce()` returns all zeros.
- [ ] **Step 5: batching test:** seed 12,001 routine operations with batch size injected as 5000.
  `runOnce` deletes all of them in 3 batches. `RetentionService` takes batch size from a
  constructor default so the test can lower it.
- [ ] **Step 6: implement:**
  - Both repo `purgeRoutine` methods use `DELETE … WHERE id IN (SELECT id … LIMIT $batch)`.
  - `RetentionService` implements `OnApplicationBootstrap`/`OnModuleDestroy`:
    - `setTimeout` 60 s, then `setInterval` 1 h. Skip when `!enabled`.
    - A `running` flag prevents overlap.
    - It catches errors and logs `retention.failed` with `logError`, and logs `retention.run`.
    - `onModuleDestroy` clears the timers.
    - In the test harness, either keep `RETENTION_ENABLED=false` or confirm the 60 s timer never
      fires in tests.
- [ ] **Step 7:** run `npm run lint && npm run typecheck && npm test` and expect PASS (pre-existing
  failures noted).
- [ ] **Step 8:** commit `retention: trim routine operations and audit rows on a schedule`.

### Task 2: dpm-wallet retention

**Files:**
- Modify: `W/src/config.ts` (+ spec)
- Modify: `W/src/db/repositories/{audit,idempotency}.repo.ts`
- Create: `W/src/retention/retention.service.ts`, `W/src/retention/retention.module.ts`,
  `W/src/retention/retention.service.spec.ts`
- Modify: `W/src/app.module.ts`

**Interfaces:**
- Produces:
  - `Config.retention: { enabled: boolean; operationsDays: number }`. dpm-wallet does not read
    the routed variable.
  - `AuditRepository.purgeRoutine(cutoff: string, batch: number): Promise<number>`.
  - `RetentionService.runOnce(now?: Date)`.

- [ ] **Step 1: config tests**, the same cases as Task 1 minus routed.
- [ ] **Step 2: retention test** (DB-backed, the repo's existing test-DB harness):
  - deleted: `sign.order` success 100 days old, `meta.split` success 100 days old, an idempotency
    key older than 24 h;
  - kept: `sign.cancel` success 10 days old, `meta.withdraw` success 1000 days old, and every
    `address.*` and `vault.*` row.
- [ ] **Step 3:** implement with the same shape as Task 1:
  - Idempotency uses `purgeOlderThan` with the existing 24 h `IDEMPOTENCY_RETENTION_MS`. Move that
    constant somewhere both the startup and retention services import.
  - The audit table's batch subquery orders by `id`.
- [ ] **Step 4:** lint, typecheck and test all PASS. Commit
  `retention: trim routine audit rows and idempotency keys on a schedule`.

### Task 3: Manager cursor paging, plus paged API keys and UI users

**Files:**
- Create: `M/src/common/dto/cursor.ts` (+ spec)
- Modify: `M/src/audit/audit.controller.ts`, `M/src/audit/dto/*`
- Modify: `M/src/db/repositories/{operation,audit,api-key,ui-user}.repo.ts`
- Modify: `M/src/api-keys/*`, `M/src/ui-users/*`, `M/src/startup/startup.service.ts`,
  `M/src/testing/harness.ts`
- Modify: `M/src/errors.ts`
- Test: `M/test/audit.e2e-spec.ts`, `M/test/api-keys.e2e-spec.ts`, `M/test/admin-ui.e2e-spec.ts`

**Interfaces:**
- Produces:
  - `encodeCursor(createdAt: string, id: string | number): string` and
    `decodeCursor(raw: string): { createdAt: string; id: string }`. The encoding is base64url JSON,
    and a bad value throws `ManagerError("INVALID_CURSOR")` (400).
  - Query DTOs gain an optional `cursor`.
  - Page responses gain `nextCursor: string | null`. `total` is omitted when `cursor` was sent.
  - `GET /v1/api-keys` and `GET /v1/ui-users` take `PaginationDto` and return
    `{items, total, limit, offset}`.
  - `ApiKeyRepository.exists(): Promise<boolean>`, plus `list(limit, offset)` and
    `findActiveAdmin()` (or the existing helper) for `bootstrap`.

- [ ] **Step 1: cursor unit tests:**
  - an encode/decode round trip;
  - `decodeCursor("!!")`, `decodeCursor(base64url('{"x":1}'))` and a non-ISO `createdAt` all
    throw `INVALID_CURSOR`.
- [ ] **Step 2: e2e tests for operations and audit:**
  - Seed 120 operations, then page with `limit=50` and the cursor. Pages are 50/50/20 with no
    overlap, the last page has `nextCursor: null`, and none of the cursor pages has `total`.
  - Insert 5 newer rows after page 1, then fetch page 2 with page 1's cursor. Its items equal the
    original rows 51–100 (Review Focus 2).
  - Without `cursor` the response is as today, with `total` and `offset`.
  - `cursor=garbage` returns 400 `INVALID_CURSOR`.
  - Run the same cases for audit.
- [ ] **Step 3:** implement keyset paging with `WHERE (created_at, id) < (:c, :i) ORDER BY
  created_at DESC, id DESC LIMIT limit+1`. `nextCursor` comes from the last returned row when
  there was an extra row.
- [ ] **Step 4: tests for API keys and UI users:**
  - with 3 keys, `limit=2` returns 2 with `total:3`, and `offset=2` returns 1;
  - the same for UI users;
  - bootstrap still mints only when no key exists;
  - the harness's operator/readonly lookups still work, through a non-paged internal finder.
- [ ] **Step 5:** implement it. Swagger shows `cursor` and `nextCursor`. Description: offset mode
  on operations and audit is deprecated.
- [ ] **Step 6:** lint, typecheck, unit and e2e tests all PASS. Commit
  `paging: cursor paging for operations and audit; page api keys and ui users`.

### Task 4: dpm-wallet cursor paging for audit

**Files:**
- Modify: `W/src/audit/audit.controller.ts`, `W/src/audit/dto/audit-query.dto.ts`
- Modify: `W/src/db/repositories/audit.repo.ts`
- Test: `W/test/app.e2e-spec.ts`, or the existing audit e2e if there is one

**Interfaces:**
- Produces:
  - `GET /v1/audit?cursor=` returns `nextCursor`, and `total` is omitted in cursor mode.
  - The cursor is the base64url string of the last `id`, with `WHERE id < :id ORDER BY id DESC`.
  - A bad cursor gets the repo's validation error (400).

- [ ] **Step 1:** tests mirroring Task 3 Step 2: 120 rows, 50/50/20, newer rows mid-way, legacy
  mode unchanged, and a bad cursor gives 400.
- [ ] **Step 2:** implement. Lint, typecheck and test all PASS. Commit
  `paging: cursor paging for the audit log`.

### Task 5: Admin UI paging

**Files:**
- Modify: `M/ui/src/api.ts`
- Create: `M/ui/src/components/CursorPager.tsx`
- Modify: `M/ui/src/components/{OperationsList,AuditList}.tsx`, `M/ui/src/pages/{ApiKeys,Users}.tsx`

**Interfaces:**
- Consumes: the Task 3 responses.
- Produces:
  - `CursorPage<T> = { items: T[]; nextCursor: string | null; limit: number }`.
  - `listOperations` and `listAudit` now send `cursor` (undefined on the first page) and return
    `CursorPage`.
  - `listApiKeys(q)` and `listUiUsers(q)` return `Page<T>`.

- [ ] **Step 1: `CursorPager`** takes props `{ hasNewer: boolean; hasOlder: boolean; onNewer();
  onOlder() }` and renders "Newer" and "Older" buttons. The lists keep a stack of cursors:
  - "Older" pushes `nextCursor`;
  - "Newer" pops;
  - a filter change resets the stack.
- [ ] **Step 2:** ApiKeys and Users use `Pagination` with `PAGE = 50`. After a create, revoke or
  delete, refetch the current page.
- [ ] **Step 3:** run `npm --prefix ui run build` (and the UI lint if it exists) and expect PASS.
- [ ] **Step 4:** the browser check of these pages happens in Task 12, on the rebuilt image.
- [ ] **Step 5:** commit `admin ui: cursor paging for operations and audit; page keys and users`.

### Task 6: Readiness, healthchecks, log caps, retention env in compose

**Files:**
- Modify: `M/src/health/health.controller.ts` (+ DTO and spec), `W/src/health/health.controller.ts`
  (+ spec)
- Modify: `M/deploy/compose.yml`, `M/deploy/README.md`

**Interfaces:**
- Produces:
  - `GET /v1/health/ready` in both services, as in Global Constraints.
  - Compose healthchecks that the upgrade health gate (Task 10) reads with
    `docker compose ps --format json`.

- [ ] **Step 1: e2e tests:**
  - `/v1/health/ready` returns 200 `{status:"ok"}` with no credential.
  - With the DB query stubbed to throw, it returns 503 `{status:"unavailable"}`. Inject the DB
    token, and mock `query` in a unit test.
  - The OpenAPI e2e snapshot is updated if the repo has one.
- [ ] **Step 2:** implement it. `GET /v1/health` stays liveness, and its comment points at
  `/ready`. dpm-wallet's `/health` (vault health) is unchanged.
- [ ] **Step 3: compose:**
  - an `x-logging` anchor applied to all four services;
  - healthchecks on dpm-wallet (port 8090) and the manager (port 3000), as
    `["CMD", "node", "-e", "fetch('http://127.0.0.1:<port>/v1/health/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]`;
  - the manager `depends_on: dpm-wallet: condition: service_healthy`;
  - both app services get `OPERATIONS_RETENTION_DAYS: ${OPERATIONS_RETENTION_DAYS:-}` and
    `RETENTION_ENABLED: ${RETENTION_ENABLED:-}`, and the manager also gets
    `ROUTED_ORDER_RETENTION_DAYS`.
  - Config parsing must treat an empty string as unset. Add a test in Tasks 1 and 2 if missing.
  - An app service waits in its shell loop until setup writes `/config/ready`, so it reports
    `starting` and then `unhealthy` until setup finishes. Document that in the README.
- [ ] **Step 4:** `docker compose -f deploy/compose.yml config` validates with the env vars set as
  the installer does (`POSTGRES_PASSWORD=x DPM_WALLET_TAG=a DPM_WALLET_MANAGER_TAG=b`).
- [ ] **Step 5:** README sections "Logs", "Retention" (the three variables and how to set them in
  `.env`) and "Health".
- [ ] **Step 6:** commit in each repo: `health: readiness probe on the database`. In M, also
  `deploy: log caps, healthchecks, retention settings`.

### Task 7: A transfer retry after a crash never signs twice

**Files:**
- Modify: `M/src/meta-tx/transfers.service.ts`, `M/src/clients/dpm-wallet.client.ts` (if needed)
- Test: `M/src/meta-tx/transfers.service.spec.ts` (create or extend)

**Interfaces:**
- Consumes: `DpmWalletClient.relay(body, options?)`, which already takes
  `{ idempotencyKey?: string }` through its request helper.

- [ ] **Step 1: test "retry after a crash between relay and recording":**
  - Use a fake upstream that records each `sign` and `relay` body.
  - First call `transfer(…, key="k1")`, and make `operations.setRelayerTransactionId` throw once
    to simulate the crash.
  - Second call with the same key and arguments.
  - Assert: both relay bodies are byte-identical (same nonce and signature); the relay was called
    with `idempotencyKey` `"k1:relay"`; and the second result carries the first relayer id when
    the fake replays by key.
- [ ] **Step 2:** run it and record whether it passes as is. It is expected to fail on
  `idempotencyKey` (not forwarded today).
- [ ] **Step 3:**
  - Forward `idempotencyKey ? \`${idempotencyKey}:relay\` : undefined` to `upstream.relay`. The
    suffix is needed because dpm-wallet's interceptor hashes the method and path, so reusing the
    signing key on `/relay` would conflict.
  - Confirm dpm-wallet's interceptor applies to `POST /v1/relay`. It is global (`APP_INTERCEPTOR`)
    in `W/src/app.module.ts`.
  - In W, add an e2e in `W/test/relay.e2e-spec.ts`: the same `Idempotency-Key` twice on
    `/v1/relay` submits to the relayer once and replays the response.
- [ ] **Step 4:** the test passes. A test where relaying throws a 4xx with the second identical
  body maps to `TRANSFER_REJECTED` (existing behaviour, so assert it).
- [ ] **Step 5:** lint, typecheck and test all PASS in both repos. Commit
  `transfers: key the relay so a retry after a crash replays it`.

### Task 8: No unbounded multi-row query

**Files:**
- Modify: whatever the audit finds in `M/src/db/repositories/*`, `W/src/db/repositories/*` and
  their callers
- Create: `M/docs/queries.md`

- [ ] **Step 1:**
  - List every repository method in both repos that returns an array (`find(`, `getMany`,
    `findBy`, raw `query` with no `LIMIT`).
  - For each, record in `M/docs/queries.md` one of: the limit it takes; why it is bounded by
    construction (for example "wallets of kind master/operations: at most 2", or "UI users: the
    install's admins"); or "fixed in this task".
- [ ] **Step 2:**
  - Fix any method that can grow with users or orders and has no limit.
  - `reconcileAll` (provisioning wallets at startup) is processed in pages of 200.
  - Each fix comes with a test that seeds `limit+1` rows and asserts paging.
- [ ] **Step 3:** lint, typecheck and test all PASS. Commit
  `db: every list query is paged or bounded`.

### Task 9: Releases carry digests, checksums and versions; installs record theirs

**Files:**
- Modify: `M/.github/workflows/build_and_push.yml` (job `release-install-files`)
- Modify: `M/deploy/versions.env`, `M/deploy/compose.yml`
- Modify: `M/deploy/install.sh`, `M/deploy/install.ps1`, `M/deploy/README.md`

**Interfaces:**
- Produces:
  - `versions.env` keys: `RELEASE_VERSION`, `MIN_UPGRADE_FROM` (empty means no minimum),
    `DPM_WALLET_TAG` and `DPM_WALLET_MANAGER_TAG`. On release, the tags are `<version>@sha256:<digest>`.
  - Release asset `SHA256SUMS` in `sha256sum` format, covering `install.sh`, `install.ps1`,
    `compose.yml`, `versions.env` and `dpm-custody`.
  - Optional `DPM_IMAGE_REGISTRY` (default `ghcr.io/in-a-bit`), used in both compose image
    lines, so a local registry can stand in for tests.
  - `.env` gains `DPM_CUSTODY_VERSION`.

- [ ] **Step 1: workflow:**
  - After pinning the manager tag, resolve both digests with
    `docker buildx imagetools inspect <ref> --format '{{json .Manifest.Digest}}'`, failing if
    either is empty.
  - Write `TAG@digest` and `RELEASE_VERSION=${VERSION#v}` into `versions.env`.
  - Generate `SHA256SUMS` and attach it with `install.ps1` and `dpm-custody`.
  - Check with `actionlint` if installed, and in any case run the job's shell snippets locally
    against a temp copy.
- [ ] **Step 2: compose:**
  - image lines become `${DPM_IMAGE_REGISTRY:-ghcr.io/in-a-bit}/dpm-wallet:${DPM_WALLET_TAG:?…}`,
    and the same for the manager and setup;
  - the `?` messages say "Re-run the installer".
  - Verify with `docker compose config`.
- [ ] **Step 3: installer:**
  - Verify downloaded files against `SHA256SUMS` when the release has one, using `sha256sum` or
    `shasum -a 256`. A mismatch aborts.
  - Write `DPM_CUSTODY_VERSION` from `RELEASE_VERSION` (`unknown` when absent).
  - Honour `DPM_CUSTODY_RELEASES_URL`.
  - Re-running over an existing folder keeps `.env` secrets and the volumes. Read the current
    logic and fix it if it would overwrite `POSTGRES_PASSWORD`.
  - Mirror all of this in `install.ps1`.
- [ ] **Step 4: test.** Run `bash deploy/install.sh` with `DPM_CUSTODY_DIR` set to a temp folder,
  `DPM_CUSTODY_RELEASES_URL=file://<temp release folder>` and a deliberately wrong `SHA256SUMS`.
  It must abort before writing `.env`. With a correct `SHA256SUMS` it writes the files.
  - Stop before it starts containers: use the installer's existing no-start or dry flag if it has
    one, otherwise add `DPM_CUSTODY_NO_START=1`.
- [ ] **Step 5:** commit `release: pin images by digest, checksum the install files, record the
  version`.

### Task 10: `dpm-custody upgrade` and `rollback`

**Files:**
- Modify: `M/deploy/dpm-custody`
- Create: `M/deploy/test/upgrade.test.sh`, a stub-based test: `docker` and `curl` are shell
  functions or PATH shims that log calls and return scripted results.

**Interfaces:**
- Consumes: the Task 9 release files and `.env` keys, and the Task 6 healthchecks.
- Produces: `./dpm-custody upgrade [version] [--yes]`, `./dpm-custody rollback`, and
  `stack_healthy()`. `stack_healthy()` is true when every service with a healthcheck is `healthy`
  and the rest are `running`, as parsed from `compose ps --format json`. Use `node` from the
  setup container, or `grep`/`sed`, since `jq` may be missing.

- [ ] **Step 1: test cases** in `upgrade.test.sh`, each in a temp install folder with shims:
  1. A bad checksum aborts; `compose.yml` and `.env` are unchanged, and no `pull` or `up` runs.
  2. A target equal to or older than the installed version is refused.
  3. Installed `1.0.0` with target `MIN_UPGRADE_FROM=1.2.0` is refused, and the message names
     `1.2.0`.
  4. No `DPM_CUSTODY_VERSION`: the upgrade proceeds, prints "installed version unknown", and
     `.env` gets the target version.
  5. An unhealthy stack before the upgrade is refused.
  6. A failed `pull` aborts with the files unchanged.
  7. Happy path, in order: backup, pull, `.prev` written (mode 600), switch, up, healthy, success.
  8. Unhealthy after `up` for the whole (shimmed, shortened) gate:
     - rollback restores `compose.yml` and `dpm-custody`;
     - the tags and `DPM_CUSTODY_VERSION` in `.env` are back to the old values;
     - an operator line added to `.env` after the switch (simulate it) survives;
     - `up` runs again and the message names the backup folder.
  9. `rollback` with no `.prev` is refused.
  10. A failed backup aborts before `pull`.

  The gate timeout is overridable (`DPM_CUSTODY_HEALTH_TIMEOUT`, default 300) so the tests run
  fast.
- [ ] **Step 2:** run `bash deploy/test/upgrade.test.sh` and expect FAIL.
- [ ] **Step 3: implement** the steps in the spec's order:
  - versions are compared numerically as `x.y.z`;
  - the disk check uses `df -Pk .` against `pg_database_size` summed from postgres;
  - `--yes` skips the prompt, and a non-tty without `--yes` refuses;
  - the new `dpm-custody` is moved into place last, via `mv`, so the running script is not
    rewritten mid-run;
  - `rollback` shares the restore and health-gate functions.
- [ ] **Step 4:** the tests pass, and `shellcheck deploy/dpm-custody deploy/test/upgrade.test.sh`
  is clean if `shellcheck` is installed.
- [ ] **Step 5:** update the usage header and the README "Upgrading" and "Rolling back" sections,
  including the existing-install note from the spec (re-run the installer once to get the new
  CLI).
- [ ] **Step 6:** commit `cli: verified, backed-up, health-gated upgrade with automatic rollback`.

### Task 11: Schema rule and version-skew check

**Files:**
- Create: `M/docs/migrations.md`, `W/docs/migrations.md`
- Modify: `M/.github/pull_request_template.md` and the W equivalent, only if they exist
- Possibly modify: `*/src/startup/schema-check.ts`, `*/src/db/migrate-cli.ts`

- [ ] **Step 1:** write the rule, verbatim from the spec's "Schema rule". Covers what counts as
  additive, the two-release removal, and raising `MIN_UPGRADE_FROM`.
- [ ] **Step 2: version skew, in each repo:**
  - On a throwaway DB, migrate with this branch's migrations plus a temporary extra additive
    migration (a nullable column on `wallets`, not committed).
  - Start the service built from `main` against it (`node dist/main` with `DATABASE_URL` set).
  - Run `migrate-cli` from `main` against it.
  - Record the results in the docs file.
  - If either refuses, fix the check in scope (spec) with a test, and commit.
- [ ] **Step 3:** commit `docs: migrations stay additive so a rollback needs no restore`.

### Task 12: Local verification on the installs

No code unless something fails. Ask the user before Steps 3–5 (they stop or upgrade a local
install).

- [ ] **Step 1:** rebuild the `:local` images for both services from `ops-hardening`.
- [ ] **Step 2:** create `M/deploy/test/crash.sh`. Against `MANAGER_URL` and an operator key, it:
  - places 20 small allowance or order signings with unique idempotency keys, then one 0.01 USDC.e
    master→operations transfer with a fixed key;
  - `docker kill`s dpm-wallet, then the manager, then postgres, at random points, each time
    waiting for `stack_healthy` and retrying every request with its key;
  - asserts: no idempotency key yields two `operations` rows with different `result_summary`; the
    transfer has one relayer id and at most one mined tx; every service is healthy at the end.

  The on-chain transfer needs explicit user approval when run.
- [ ] **Step 3:** with the user's go-ahead, recreate the segregated install on the new images:
  - copy in the new `compose.yml` and re-run the installer, keeping the data;
  - check `status` shows healthy, logs are capped (`docker inspect` LogConfig), balances still
    load, and `/admin` paging works on Operations, Audit, API keys and Users.
- [ ] **Step 4:** with approval, run `crash.sh` against the segregated install.
- [ ] **Step 5: upgrade and rollback rehearsal, with approval:**
  - start `registry:2` on `localhost:5000`;
  - push `:local` as `1.0.0`, and a build with a dummy additive migration as `1.1.0`;
  - push a build whose manager exits at boot as `1.2.0-broken`;
  - make three release folders with real `SHA256SUMS` and digests;
  - with `DPM_IMAGE_REGISTRY=localhost:5000/in-a-bit` and `DPM_CUSTODY_RELEASES_URL` pointing at
    them:
    - upgrade 1.0.0 → 1.1.0 succeeds;
    - 1.1.0 → 1.2.0-broken rolls back by itself to 1.1.0 and stays healthy;
    - `rollback` returns to 1.0.0, and 1.0.0 runs on the 1.1.0-migrated schema.
  - Afterwards restore the install to the `:local` tags and confirm it is healthy.
- [ ] **Step 6:** report the results. Commit `crash.sh` and any fixes:
  `test: crash and upgrade rehearsal scripts`.
