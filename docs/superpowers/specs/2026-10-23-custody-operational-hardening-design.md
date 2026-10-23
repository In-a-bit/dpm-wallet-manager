# Custody install: operational hardening — design

Status: approved in chat, 2026-10-23 (retention: the user took Claude's suggestion).

## Intent

dpm-wallet and dpm-wallet-manager run inside the operator's environment, on a machine nobody on
the platform team looks after. Four things there can quietly go wrong over months:

- the disk fills with container logs or with rows nobody needs any more;
- a list or a query slows down as tables grow, until the dashboard or the API stops answering;
- a Docker restart (crash, host reboot, `dpm-custody stop`) interrupts work half-way;
- an upgrade leaves the install broken, with no way back.

This work makes each of those safe by default, without the operator having to know about it.

## Goals

1. Container logs have a fixed upper bound on disk.
2. High-volume tables are trimmed on a schedule. Rows that matter later are kept forever.
3. Every query that can return many rows is paged. The busiest lists stay fast however large
   the table grows, and every admin UI list pages.
4. A restart or a stop never loses or duplicates work, and the stack reports real health.
5. `dpm-custody upgrade` is safe: pinned and verified, backed up first, health-gated, and it
   rolls back by itself when the new version does not come up.

## Non-goals

- Shipping logs anywhere (Loki, CloudWatch…). Operators who want that change the log driver.
- Image signatures (cosign). Checksums now; signatures are a later step.
- Zero-downtime upgrades. A short outage while containers restart is acceptable.
- Archiving trimmed rows to files. Deleted means deleted.
- Changing anything on the platform (prediction-go) or in the mocks.

## Anti-goals

- Never delete a row that a later request depends on. In particular, cancelling an order needs
  the row that says which wallet signed it (see "Routed orders" below).
- Never delete a withdrawal or transfer, a denial, a failure, or any key, user, wallet or
  setting change, from either table.
- An upgrade must never leave the operator with a stack that is down and no instruction that
  brings it back.
- Never move funds twice because of a restart or a retry.
- Existing API clients (the builder's backend) keep working. New fields only; nothing removed.

## Decisions

### The user's

- **Retention:** audit events and transfer/withdrawal operations are kept forever.
  Order-signing operations are kept 90 days, and the period is configurable.

### Claude's calls (flagged to the user)

- **"Order-signing" covers the routine trading artefacts.** That means operation kinds `order`,
  `cancel`, `allowance`, `redeem`, `split` and `merge`. Only `withdraw` is kept forever. In
  practice that covers every transfer and every external withdrawal.
- **Successful routine audit events follow the same 90 days.** Recon showed both services write
  an audit row for every order they sign. "Keep audit forever" would therefore grow as fast as
  orders do, which defeats the point. Trimmed: `outcome = success` events whose action is
  `sign.order`, `sign.cancel`, `meta.allowance`, `meta.redeem`, `meta.split` or `meta.merge`.
  Every other audit row is kept forever: denials, failures, withdrawals, keys, users, wallets and
  settings.
- **Routed orders get longer.** In shared mode an order can be signed by a wallet other than the
  one the caller named. A later cancel finds the signer through the order's row
  (`OperationRepository.findOrderByHash`). An `order` row whose `signer_wallet_id` differs from
  its `wallet_id` is kept `ROUTED_ORDER_RETENTION_DAYS` (default 365). The cost: a shared-mode
  order still open after a year cannot be cancelled through the manager.
- **Audit action names are the same in both services.** Recon confirmed `sign.order`,
  `sign.cancel` and `meta.*` exist verbatim in both `audit-action.ts` files.
- **Cursor paging only where tables are unbounded.** That means manager operations and audit, and
  dpm-wallet audit. Wallets and addresses (one per user) keep offset paging. API keys and UI users
  gain it.

## Design

### 1. Logs

- Every service in `deploy/compose.yml` gets one shared logging block: `driver: json-file`,
  `max-size: 20m`, `max-file: 5`. That caps each service at about 100 MB.
- The services keep writing JSON lines to stdout only. Nothing writes log files inside a
  container.
- `dpm-custody logs` and `support` are unchanged.

### 2. Retention (both services)

A `RetentionService` in each service runs in the background. It runs 60 s after start, then
every hour. Each run:

- deletes expired idempotency keys (and, in the manager, expired UI sessions). Today this only
  happens at boot. The boot purge stays.
- deletes routine rows older than their cutoff, as described below.

Rules for every run:

- Deletes go in batches of 5,000 rows (`DELETE … WHERE id IN (SELECT … LIMIT 5000)`). The loop
  stops when a batch deletes fewer rows, or after 100 batches per table per run. No table is
  locked for long.
- A run that is still going when the next is due is skipped, not stacked.
- A failure is logged (`retention.failed`) and never crashes the process.
- Each run logs `retention.run` with the rows deleted per table.

Settings come from the environment. They are validated at boot, and a bad value fails the boot.

| Variable | Default | Meaning |
|---|---|---|
| `OPERATIONS_RETENTION_DAYS` | 90 | Routine operation rows (manager) and routine success audit rows (both services) |
| `ROUTED_ORDER_RETENTION_DAYS` | 365 | Manager `order` rows whose signer differs from the named wallet |
| `RETENTION_ENABLED` | true | `false` turns the scheduled job off. The boot purge of idempotency keys and sessions still runs |

- Values must be whole days from 1 to 3650.
- `ROUTED_ORDER_RETENTION_DAYS` may not be below `OPERATIONS_RETENTION_DAYS`.
- dpm-wallet reads only `OPERATIONS_RETENTION_DAYS` and `RETENTION_ENABLED`.
- Setup writes nothing new. The defaults apply, and an operator overrides them by adding them to
  `.env`. Compose passes them through with empty defaults.

Indexes the trimming and paging need, added by migrations:

| Service | Table | Index |
|---|---|---|
| manager | `operations` | `(created_at, id)` |
| manager | `operations` | partial index on `result_summary WHERE kind = 'order'`. `findOrderByHash` currently scans every order on each cancel |
| manager | `audit_events` | `(created_at, id)` |
| dpm-wallet | `audit_events` | Already has `created_at`. Its paging keys on `id`, the primary key, which is enough |

### 3. Paging

- **Manager `GET /v1/operations` and `GET /v1/audit`, and dpm-wallet `GET /v1/audit`:**
  - accept an optional opaque `cursor`;
  - always return `nextCursor` (null on the last page);
  - when `cursor` is sent, `offset` is ignored and `total` is omitted;
  - without `cursor`, they behave exactly as today (offset, `total`) for existing clients, and the
    docs mark that mode deprecated.
  - The cursor encodes the last row's sort key: `(created_at, id)` in the manager and `id` in
    dpm-wallet.
  - A malformed cursor gets 400 `INVALID_CURSOR` in the manager, and the equivalent validation
    error in dpm-wallet.
- **Manager `GET /v1/api-keys` and `GET /v1/ui-users`:** accept `limit`/`offset` and return
  `total`, like wallets.
  - The response keeps `items`, so old clients still work.
  - Internal callers that need "is there any key" or "count active owners" use dedicated
    `exists`/`count` queries, not `list()`.
- **The rest:** every repository method in both services that can return more than one row
  either takes a limit or is bounded by construction. The plan audits this and lists each such
  method.
- **Admin UI:**
  - Operations and Audit use cursor paging with "Newer" and "Older" buttons. The page keeps a
    stack of cursors. There is no total count.
  - API keys and Users use the existing `Pagination` component.
  - The limit cap stays at 200 and the page size at 50.

### 4. Restarts

- **Graceful shutdown:** both services call `app.enableShutdownHooks()`.
  - On SIGTERM they stop accepting connections, let in-flight requests finish (up to 20 s) and
    close the database.
  - Today node runs as PID 1 with no handler, so every stop waits the full 30 s grace and is then
    killed mid-request.
  - The retention job stops on shutdown.
- **Readiness:**
  - A new public `GET /v1/health/ready` in both services runs `SELECT 1` and answers 200, or 503
    when the database is unreachable.
  - `GET /v1/health` stays liveness only. Its comment says why.
  - Compose gives dpm-wallet and the manager a healthcheck on `/v1/health/ready`, using `node -e`
    with `fetch`, since the image has no curl: `interval: 10s`, `timeout: 5s`, `retries: 6`,
    `start_period: 60s`.
  - The manager's `depends_on` waits for dpm-wallet to be `service_healthy`.
- **Transfers survive a crash:**
  - A crash between relaying a transfer and recording its relayer id must not let a retry move
    funds twice.
  - Today a retry with the same `Idempotency-Key` gets the same signature back from dpm-wallet,
    because dpm-wallet replays by key. The relayer then sees the same nonce twice and refuses the
    second.
  - The plan proves this with a test. If it does not hold, the transfer is fixed so that it does.
  - The retry must answer either the original transfer (relayer id found by the signer and nonce)
    or `TRANSFER_REJECTED`. Never a second movement.
  - The admin UI already reuses one key per transfer.
- **If that test fails:**
  - The manager forwards the transfer's `Idempotency-Key` to dpm-wallet's `POST /v1/relay` (its
    interceptor already replays by key), so a retry gets back the original relayer response.
  - If dpm-wallet itself died after the relayer accepted, the retry re-sends the same signature.
    The relayer refuses a used nonce, and that surfaces as `TRANSFER_REJECTED`. That is acceptable:
    the UI tells the user to check the balances.
  - No relayer lookup by signer and nonce is built.
- **Crash test:**
  - A script under `deploy/` drives orders and one transfer against a local install while
    `docker kill`-ing each service in turn.
  - Afterwards: no duplicate operation per idempotency key, no transfer submitted twice, every
    service healthy again.
  - It runs only against local installs. It is a script, not a CI job.

### 5. Upgrades

**Release files** (what the `release-install-files` workflow job attaches):

- `install.sh`, `compose.yml`, `versions.env`, `dpm-custody` and a new `SHA256SUMS` covering all
  of them.
- `versions.env` gains:
  - `RELEASE_VERSION`, for example `1.4.0`;
  - `MIN_UPGRADE_FROM`, the oldest version that can upgrade straight to this one. It is kept by
    hand in the repo and defaults to the previous release.
  - Image references pinned by digest: `DPM_WALLET_TAG=0.1.0@sha256:…` and
    `DPM_WALLET_MANAGER_TAG=1.4.0@sha256:…`. The workflow resolves both digests from the registry.
  - A release is refused if either digest cannot be resolved.
- `compose.yml` loses its `:-main` image defaults. A missing tag fails clearly.
- The installer records `DPM_CUSTODY_VERSION` in `.env`.
- The manager repo owns `deploy/` and the release workflow. That workflow resolves the
  dpm-wallet digest from GHCR itself, so the dpm-wallet release must be published first. Today's
  check already enforces that.
- **Existing installs:**
  - Their `.env` has no `DPM_CUSTODY_VERSION`, so the new `upgrade` treats the installed version as
    unknown. That skips the downgrade and `MIN_UPGRADE_FROM` checks once, says so, and records the
    target.
  - Their old `dpm-custody` cannot fetch the new one. The deploy README tells them to run the
    installer again, which keeps the data. The plan checks that a re-run over an existing folder is
    safe and fixes it if not.
  - The first release that carries `SHA256SUMS` sets `MIN_UPGRADE_FROM` empty, meaning no
    minimum.

**`dpm-custody upgrade [version] [--yes]`**, in order. Every step before the stop changes
nothing:

1. **Download:**
   - Fetch the target release's files into `upgrade.tmp/` and check them against `SHA256SUMS`.
     A mismatch aborts.
   - The base URL is `DPM_CUSTODY_RELEASES_URL` when set, which local tests point at a folder,
     otherwise GitHub.
2. **Check:**
   - Refuse a target equal to or older than the installed version, and a jump from below the
     target's `MIN_UPGRADE_FROM`, with the version to go through first.
   - Refuse when the stack is not healthy now, which would make the health gate meaningless.
     "Healthy" means every service with a healthcheck (postgres, dpm-wallet, the manager) is
     `healthy`, and every other service (setup) is `running`. The health gate below uses the same
     test.
   - Refuse when free disk is below twice the database size plus 1 GB.
3. **Confirm:** print the installed and target versions and the release-notes URL, and ask. A
   `--yes` flag skips the question.
4. **Back up:** run `cmd_backup`, which is unchanged. A failed backup aborts.
5. **Pull** the new images while the old ones keep running. A failed pull aborts with nothing
   changed.
6. **Keep the old files:** copy `compose.yml`, `.env` and `dpm-custody` to `*.prev`, mode 600.
7. **Switch:** move the new files in, set the new tags and `DPM_CUSTODY_VERSION` in `.env`, and
   run `compose up -d`. Migrations run in each container as today.
8. **Health gate:** wait up to 5 minutes for every service to be healthy.
   - **Healthy:** print success, and that `dpm-custody rollback` will undo the upgrade.
   - **Not healthy:** roll back by itself (below), then print what happened, where the backup is,
     and the `support` command.

**`dpm-custody rollback`:**

- Restores `compose.yml` and `dpm-custody` from `*.prev`.
- In `.env`, it reverts only the image tags and `DPM_CUSTODY_VERSION` to their `.env.prev`
  values. Any other edit the operator made in the meantime survives.
- Then it runs `compose up -d` and waits for health, as above.
- Refuses when there are no `*.prev` files.
- If the old version still does not come up, it prints the backup restore steps from the deploy
  README and stops. It never restores the database by itself.

**Schema rule that makes rollback safe:**

- A release's migrations only add: tables, nullable or defaulted columns, and indexes.
- Dropping or renaming happens in a later release, once no supported version uses the old shape.
- Each service must start on a database migrated by the next release. TypeORM ignores migrations
  it does not know, and `assertSchemaPresent` only probes `wallets`. The plan verifies both.
- If the version-skew check fails on today's code, for example a startup check that rejects
  unknown migrations, fixing that startup check is in scope.
- The rule goes in each repo's `docs/` and in the PR template, if there is one.
- A release that has to break the rule raises `MIN_UPGRADE_FROM` and says so in its notes. Its
  rollback is then the backup restore.

**Verification:** the plan exercises the whole path on a local install with
`DPM_CUSTODY_RELEASES_URL` pointed at locally built release folders:

- an upgrade to a build carrying an additive migration;
- an upgrade to a deliberately broken build, which must roll back automatically;
- `rollback` after a good upgrade.

## Constraints

- Local only. Never touch dev. Nothing is pushed or released; branches `ops-hardening` in both
  repos, from `main`.
- No new runtime dependencies. Use plain timers, not `@nestjs/schedule`.
- `deploy/dpm-custody` stays POSIX-bash portable for Linux and macOS (no GNU-only flags).
  `install.ps1` gets the matching changes where it writes `.env`.
- Each repo's lint, typecheck and tests pass.
- Existing API responses only gain fields.

## Left to the builder

File layout, log event names beyond those named here, cursor encoding (any opaque base64url),
copy in the CLI and UI, and test layout, following each repo's patterns.
