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
- **Retention settings:**
  - Stored in `platform_settings` under the keys `retention.routine_days`,
    `retention.routed_order_days`, `retention.enabled` and `archive.reminder_days`.
  - A dashboard value wins over the env default.
  - Changes are audited as `settings.retention_update`.
- **Storage settings:** `storage.warning_percent` (75), `storage.warning_days` (30),
  `storage.critical_percent` (90), `storage.critical_days` (7) and
  `storage.alert_webhook_url` (empty).
- **The manager drives dpm-wallet's routine and archive deletions** through the dpm-wallet
  endpoints `POST /v1/maintenance/purge-routine-audit`, `GET /v1/maintenance/audit-export` and
  `POST /v1/maintenance/delete-archived-audit`. dpm-wallet never computes a routine cutoff itself.
- **Important records are never deleted automatically.** Only an archive the operator downloaded
  and confirmed deletes them.
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
5. **Rows written after an archive was created.** They must never be deleted by that archive's
   delete. The test inserts an important row older than the cutoff after `POST /v1/archives` and
   before delete, and the row survives (Task 14).
6. **A broken-off archive download.** The archive stays `pending` and delete is refused (Task 14).
7. **An install created before this work, with no `DPM_CUSTODY_VERSION`.** `upgrade` must
   proceed once, say the version is unknown, and record the target (Task 10).

---

### Task 1: dpm-wallet retention and maintenance endpoints

**Files:**
- Modify: `W/src/db/repositories/{audit,idempotency}.repo.ts`
- Create: `W/src/retention/retention.service.ts`, `W/src/retention/retention.module.ts`
  (hourly idempotency purge only)
- Create: `W/src/maintenance/maintenance.controller.ts`, `W/src/maintenance/maintenance.module.ts`,
  `W/src/maintenance/dto/*`
- Test: `W/test/maintenance.e2e-spec.ts`, `W/src/retention/retention.service.spec.ts`
- Modify: `W/src/app.module.ts`

**Interfaces:**
- Produces, all behind the existing API-key guard:
  - `POST /v1/maintenance/purge-routine-audit {before: ISO, batch: 1..5000}` returns
    `{deleted}`. It deletes one batch of routine success audit rows with `created_at < before`.
  - `GET /v1/maintenance/audit-export?before&maxId&cursor&limit(≤1000)` returns
    `{items: AuditEvent[], nextCursor}`. The items are important rows only (not routine success),
    with `id <= maxId AND created_at < before`, ordered by `id` ascending.
  - `POST /v1/maintenance/delete-archived-audit {before, maxId, batch}` returns `{deleted}`. It
    uses the same row set as the export and deletes one batch.
  - `GET /v1/maintenance/audit-scope?before` returns `{maxId, rows}`, the important rows in scope
    now.
  - Each refuses a `before` newer than 24 h ago with a 400 validation error.
  - The routine rule lives in one exported predicate, `ROUTINE_AUDIT_ACTIONS` plus
    `outcome = 'success'`, which `purge` and `export` share.

- [ ] **Step 1: e2e tests:**
  - Purge deletes only routine success rows older than `before`, at most `batch` per call.
  - Export pages important rows in `id` order with no routine rows.
  - Rows inserted after the scope call (`id > maxId`) are never exported or deleted.
  - `before` = now gives 400. A missing API key gives 401.
- [ ] **Step 2: retention service test.** Idempotency keys older than 24 h are purged by
  `runOnce`. Share the 24 h constant with `startup.service.ts`. The timers are cleared in
  `onModuleDestroy`.
- [ ] **Step 3:** implement. The batch deletes use `DELETE … WHERE id IN (SELECT id … LIMIT $n)`.
- [ ] **Step 4:** lint, typecheck and test all PASS. Commit
  `maintenance: purge, export and delete audit rows for the manager to drive`.

### Task 2: Manager retention (settings, indexes, purge, scheduler)

**Files:**
- Modify: `M/src/config.ts` (+ spec), the env defaults
- Create: `M/src/settings/retention-settings.service.ts` (+ spec)
- Create: `M/src/db/migrations/1793000000000-RetentionIndexes.ts`
- Modify: `M/src/db/repositories/{operation,audit,idempotency,ui-session}.repo.ts`
- Modify: `M/src/clients/dpm-wallet.client.ts`
- Create: `M/src/retention/retention.service.ts`, `M/src/retention/retention.module.ts`,
  `M/src/retention/retention.service.spec.ts`
- Modify: `M/src/app.module.ts`

**Interfaces:**
- Consumes: the Task 1 endpoints.
- Produces:
  - `Config.retentionDefaults: { enabled; routineDays; routedOrderDays }`, validated as in Global
    Constraints, with an empty string treated as unset.
  - `RetentionSettingsService.effective(): Promise<{ enabled; routineDays; routedOrderDays;
    archiveReminderDays; sources: Record<string, "dashboard" | "environment" | "default"> }>`.
  - `RetentionSettingsService.update(patch, actor)`. `null` clears a key. The bounds are checked
    against the effective values after the patch. It writes `settings.retention_update`.
  - `OperationRepository.purgeRoutine(cutoff, routedCutoff, batch): Promise<number>` and
    `AuditRepository.purgeRoutine(cutoff, batch): Promise<number>`.
  - `DpmWalletClient.purgeRoutineAudit(before, batch)`, `auditScope(before)`,
    `auditExport(q)` and `deleteArchivedAudit(...)`.
  - `RetentionService.runOnce(now?: Date): Promise<Record<string, number>>`, with a
    `routineDaysOverride` hook that Task 13 uses for tightening.

- [ ] **Step 1: config and settings tests:**
  - env defaults and bad values (0, 3651, `abc`, routed below routine, `RETENTION_ENABLED=maybe`)
    throw at boot;
  - a dashboard value overrides env and reports source `dashboard`;
  - `null` reverts to `environment`;
  - a patch making routed below routine gets 400 `VALIDATION_FAILED`;
  - an update writes the audit event with the old and new values.
- [ ] **Step 2: migration** `RetentionIndexes`. `up` creates `operations_created_at_id`
  `(created_at, id)`, `operations_order_result_summary` `(result_summary) WHERE kind = 'order'`
  and `audit_events_created_at_id` `(created_at, id)`. `down` drops all three. Apply it to the dev
  DB.
- [ ] **Step 3: retention test** (DB-backed, with the dpm-wallet client faked to record calls).
  Seeds:
  - operations: a direct `order` 100 days old (deleted), a direct `order` 10 days old (kept), a
    routed `order` 200 days old (kept) and 400 days old (deleted), a `withdraw` 1000 days old
    (kept), and a `merge` 100 days old (deleted);
  - audit: `sign.order` success 100 days old (deleted), `sign.order` denied 100 days old (kept),
    `meta.withdraw` success 1000 days old (kept), and `api_key.create` 1000 days old (kept);
  - an expired idempotency key and session (deleted).

  `runOnce` returns those counts, and calls `purgeRoutineAudit` with a 90-day cutoff until it
  returns fewer than `batch`. A second run returns zeros. With `enabled:false` the timers do
  nothing.
- [ ] **Step 4: batching test.** 12,001 routine operations at batch 5000 are deleted in 3 batches.
  A dpm-wallet error is logged as `retention.failed` and the manager tables are still trimmed.
- [ ] **Step 5:** implement the scheduler: 60 s, then 1 h, no overlap, cleared on destroy. Read
  the settings at the start of each run.
- [ ] **Step 6:** lint, typecheck and test all PASS. Commit
  `retention: dashboard-configurable trimming of routine records in both services`.

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
  - After a successful upgrade, remove this install's dpm images other than the current and
    previous tags. Add test case 11: only those two remain referenced; the prune call lists
    exactly the older ones.
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

### Task 12: Settings API and the Storage page skeleton

**Files:**
- Create: `M/src/settings/settings.controller.ts`, `M/src/settings/settings.module.ts`,
  `M/src/settings/dto/*`
- Create: `M/src/settings/storage-settings.service.ts` (+ spec)
- Test: `M/test/settings.e2e-spec.ts`
- Modify: `M/ui/src/api.ts`, `M/ui/src/App.tsx` / router, `M/ui/src/components/Layout.tsx`
- Create: `M/ui/src/pages/Storage.tsx`, `M/ui/src/components/RetentionSettings.tsx`,
  `M/ui/src/components/StorageSettings.tsx`

**Interfaces:**
- Consumes: Task 2's `RetentionSettingsService`.
- Produces:
  - `GET /v1/settings/retention` (readonly and up) and `PUT /v1/settings/retention` (admin).
    The body is a partial of `{enabled, routineDays, routedOrderDays, archiveReminderDays}`, and
    `null` clears a key. The response is the effective values plus `sources`, plus read-only
    `fixed: {idempotencyHours: 24, logs: "5 × 20 MB per service"}`.
  - `GET` and `PUT /v1/settings/storage`, the same shape for
    `{warningPercent, warningDays, criticalPercent, criticalDays, alertWebhookUrl}`. The rules:
    - percents are 1–99 and warning < critical;
    - days are 1–365 and warning > critical;
    - the URL is http(s) or null.
    - The audit event is `settings.storage_update`.
  - `StorageSettingsService.effective()`.
  - The `/storage` route in the UI with three tabs: Overview (filled in Task 13), Archives (Task
    15) and Settings (this task).

- [ ] **Step 1: e2e tests:**
  - a viewer can GET and is refused PUT (403);
  - an admin PUT persists, and the source becomes `dashboard`;
  - `null` reverts;
  - each bound violation gets 400;
  - each update writes one audit event with the old and new values.
- [ ] **Step 2:** implement the endpoints. Retention changes take effect on the next run (no
  restart).
- [ ] **Step 3: UI Settings tab:**
  - one form per group, each field showing its source badge ("default", "from environment",
    "set here") and a "reset" link;
  - the fixed values shown read-only;
  - owners edit, and others see it disabled with a note.
  - Saving shows a toast. A routine-days decrease asks for confirmation ("records older than N
    days will be deleted within the hour").
- [ ] **Step 4:** `npm --prefix ui run build`, lint, typecheck and test all PASS. Commit
  `settings: retention and storage settings from the dashboard`.

### Task 13: Storage monitor, alerts, tightening

**Files:**
- Create: `M/src/db/migrations/1793100000000-StorageSamples.ts`,
  `M/src/db/entities/storage-sample.entity.ts`, `M/src/db/repositories/storage-sample.repo.ts`
- Create: `M/src/storage/storage-monitor.service.ts` (+ spec), `M/src/storage/storage.controller.ts`,
  `M/src/storage/storage.module.ts`, `M/src/storage/growth.ts` (+ spec)
- Modify: `M/src/retention/retention.service.ts` (tightening and sample trimming),
  `M/src/health/health.controller.ts` (`storage` field on `/ready`)
- Modify: `M/deploy/compose.yml` (`pg-data:/storage/pg:ro` on the manager), `M/deploy/dpm-custody`
  (`status` storage line)
- Modify: `M/ui/src/components/Layout.tsx` (banner), `M/ui/src/pages/Storage.tsx` (Overview tab)

**Interfaces:**
- Produces:
  - `growthPerDay(samples: {at: string; usedBytes: number}[]): number | null`. Least squares over
    the last 7 days; null with under 24 h of samples.
  - `levelFor(sample, growth, settings): "ok" | "warning" | "critical"`.
  - `GET /v1/storage` (readonly and up) returns
    `{at, disk: {totalBytes, freeBytes, usedPercent}, databases: {wallet, manager}, tables: [{db,
    name, bytes, estRows}], growthBytesPerDay, daysToFull, level, tightened: null | {routineDays,
    since}, oldestImportantAt, archiveSuggested}`.
  - `/v1/health/ready` gains an optional `storage: {level, usedPercent, daysToFull}`. The status
    code never depends on it.
  - The disk path comes from `STORAGE_PATH` (default `/storage/pg`). When it is missing
    (`statfs` throws), `disk` is null, the level is computed from the DB size alone (`ok`), and
    `storage.unavailable` is logged once.

- [ ] **Step 1: unit tests for `growth.ts`:**
  - a linear 1 GB/day series gives 1e9 ±1%;
  - a flat series gives 0, and `daysToFull` is null;
  - a 12 h series gives null;
  - `levelFor`: 80% gives warning; 50% with 20 days to full gives warning; 50% with 5 days gives
    critical; 91% gives critical.
- [ ] **Step 2: monitor tests** with `statfs` and the clock injected:
  - a sample is written every 15 min;
  - a level change logs `storage.level` and POSTs the webhook once;
  - critical re-POSTs after 24 h, not before;
  - a webhook 500 or timeout is logged and does not throw;
  - samples older than 30 days are trimmed by the retention run.
- [ ] **Step 3: tightening test.**
  - With critical active, `runOnce` uses 30 days when the setting is 90, and logs
    `retention.tightened`.
  - After 24 h still critical, it uses 7.
  - Back below warning, it returns to 90.
  - A `withdraw` operation or important audit row is never deleted in any of these.
- [ ] **Step 4: e2e test:** `/v1/storage` has the shape above, and `/v1/health/ready` includes
  `storage` and stays 200 when critical.
- [ ] **Step 5: UI:**
  - **Banner:** shown on every page while the level isn't ok. Amber for warning, red for critical,
    and blue for "archive suggested". The text names the actions from the spec, links to
    `/storage`, and says when retention is tightened.
  - **Overview tab:** the disk gauge, database sizes, a table-size table, growth per day, days to
    full and a refresh button.
- [ ] **Step 6: compose and CLI:**
  - mount the `pg-data` volume read-only on the manager;
  - `status` prints `Storage: <level> · <used>% used · ~<days> days to full`, from `/ready`
    through `compose exec -T dpm-wallet-manager node -e`.
  - Extend `upgrade.test.sh` for the status line.
- [ ] **Step 7:** build, lint, typecheck and test all PASS. Commit
  `storage: disk and database monitor with dashboard alerts, webhook and tightening`.

### Task 14: Archive backend

**Files:**
- Create: `M/src/db/migrations/1793200000000-Archives.ts`, `M/src/db/entities/archive.entity.ts`,
  `M/src/db/repositories/archive.repo.ts`
- Create: `M/src/archive/archive.service.ts`, `M/src/archive/archive.controller.ts`,
  `M/src/archive/archive.module.ts`, `M/src/archive/archive-writer.ts` (+ specs)
- Modify: `M/src/errors.ts` (`ARCHIVE_IN_PROGRESS` 409, `ARCHIVE_NOT_READY` 409,
  `ARCHIVE_CODE_MISMATCH` 400, `ARCHIVE_NOT_FOUND` 404)
- Modify: `M/src/db/repositories/{operation,audit}.repo.ts` (important-row scope, export page,
  delete batch)
- Test: `M/test/archive.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 1's dpm-wallet maintenance endpoints, through the Task 2 client.
- Produces:
  - Table `archives`: `id uuid`, `before`, `scope jsonb {table: {maxId, rows}}`, `status`
    (`pending | downloaded | deleting | done`), `sha256`, `byte_size`, `row_count`,
    `deleted jsonb`, `created_by_user_id`, `created_by_key_id`, `created_at`, `downloaded_at`,
    `deleted_at`.
  - `POST /v1/archives {before}` (admin) returns `{id, code, scope}`.
    - `code` is the first 6 characters of the id, upper-cased.
    - `before` must be at least 1 day old.
    - Another archive not yet `done` gives 409 `ARCHIVE_IN_PROGRESS`.
  - `GET /v1/archives/preview?before` (readonly) returns `{tables: {name: rows}}`.
  - `GET /v1/archives` (readonly, paged) returns history.
  - `GET /v1/archives/:id/download` (admin) streams gzip with `Content-Disposition` filename
    `dpm-archive-<install>-<yyyymmdd>-<code>.ndjson.gz`. `<install>` is the manager's
    `MANAGER_PUBLIC_URL` host, sanitised, or `install`.
  - `POST /v1/archives/:id/delete {code}` (admin) returns `202 {status:"deleting"}`. The deletion
    runs in the background in batches, then `VACUUM (ANALYZE)` on the touched tables, then
    `done`.
  - The file format is exactly the spec's: a manifest line, then `{table, row}` lines. The table
    names are `manager.operations`, `manager.audit_events` and `wallet.audit_events`.
  - The `archive.*` audit actions are excluded from scope.

- [ ] **Step 1: e2e tests:**
  1. **Create:** preview counts match the seeded important rows. Routine rows and `archive.*`
     rows are excluded.
  2. **Download:** gunzip and parse. The manifest is first, the rows match the scope across all
     three tables, and the stored `sha256` equals the SHA-256 of the received bytes. Status is
     `downloaded`.
  3. **Broken download:** destroy the stream mid-way. Status stays `pending`, and delete gets 409
     `ARCHIVE_NOT_READY` (Review Focus 6).
  4. **Wrong code** gets 400 `ARCHIVE_CODE_MISMATCH` and nothing is deleted.
  5. **Delete:** wait for `done`. The in-scope rows are gone in all three tables. A row inserted
     after create with an old `created_at` survives (Review Focus 5), and `deleted` counts match.
  6. A second create while one is `downloaded` gets 409.
  7. A viewer gets 403 on create, download and delete, and 200 on list and preview.
  8. Each step writes its `archive.*` audit event with the actor.
- [ ] **Step 2: implement.**
  - Export reads in pages of 1000 (keyset on `id`) from the manager tables, then dpm-wallet
    through `auditExport`.
  - The writer pipes through `zlib.createGzip()` and a hashing `Transform` to the response, and
    the record is finalised on `finish` only.
  - Delete resumes from the `deleting` state on restart: the startup service resumes it in the
    background.
- [ ] **Step 3:** lint, typecheck and test all PASS. Commit
  `archive: export important records to a verified file and remove them on confirmation`.

### Task 15: Archive UI

**Files:**
- Modify: `M/ui/src/pages/Storage.tsx` (Archives tab)
- Create: `M/ui/src/components/ArchiveWizard.tsx`, `M/ui/src/components/ArchiveHistory.tsx`

**Interfaces:**
- Consumes: Task 14's endpoints.

- [ ] **Step 1: archive wizard** (owners only; everyone else sees the history only):
  - a date picker defaulting to `archive.reminder_days` ago;
  - "Preview" shows the row count per table, then "Create and download" starts the browser
    download from `/v1/archives/:id/download`;
  - the history row turns `downloaded` (poll `GET /v1/archives` every 3 s while `pending`);
  - "Remove archived records from the database" opens a `Confirm` that repeats the counts, says
    the space is reused rather than returned to the disk, and asks for the 6-character code;
  - progress is shown until `done`;
  - the note "Keep the file somewhere safe, off this machine" is visible throughout.
- [ ] **Step 2: archive history:** when, by whom, cutoff, rows, SHA-256 (with a copy button) and
  status, paged.
- [ ] **Step 3:** `npm --prefix ui run build` passes. The browser check is in Task 16.
- [ ] **Step 4:** commit `admin ui: archive wizard and history`.

### Task 16: Local verification on the installs

No code unless something fails. Ask the user before Steps 2b–5 (they stop or upgrade a local
install).

- [ ] **Step 1:** rebuild the `:local` images for both services from `ops-hardening`.
- [ ] **Step 2:** create `M/deploy/test/crash.sh`. Against `MANAGER_URL` and an operator key, it:
  - places 20 small allowance or order signings with unique idempotency keys, then one 0.01 USDC.e
    master→operations transfer with a fixed key;
  - `docker kill`s dpm-wallet, then the manager, then postgres, at random points, each time
    waiting for `stack_healthy` and retrying every request with its key;
  - asserts: no idempotency key yields two `operations` rows with different `result_summary`; the
    transfer has one relayer id and at most one mined tx; every service is healthy at the end.
- [ ] **Step 2b: storage and archive on the segregated install** (after Step 3):
  - `/storage` shows real figures;
  - set the warning percent below the current use and check the banner, the `status` line and a
    webhook to a local `nc -l` listener;
  - put it back;
  - archive with a cutoff of 1 day ago: download, check the file with `gunzip -c | head`,
    confirm the delete, and check the rows are gone and history shows `done`.

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
