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
2. High-volume tables are trimmed on a schedule. Rows that matter later are kept until the
   operator archives them. Every retention period is set from the admin dashboard.
3. The operator is warned well before the disk fills, with what to do about it. Old important
   records can be archived to a file and removed in a few clicks.
4. Every query that can return many rows is paged. The busiest lists stay fast however large
   the table grows, and every admin UI list pages.
5. A restart or a stop never loses or duplicates work, and the stack reports real health.
6. `dpm-custody upgrade` is safe: pinned and verified, backed up first, health-gated, and it
   rolls back by itself when the new version does not come up.

## Non-goals

- Shipping logs anywhere (Loki, CloudWatch…). Operators who want that change the log driver.
- Image signatures (cosign). Checksums now; signatures are a later step.
- Zero-downtime upgrades. A short outage while containers restart is acceptable.
- Archiving routine rows that retention trims. Deleted means deleted. Only important records
  are archived, and only when the operator chooses to.
- Restoring an archive back into the database. Archived records are viewed from the file, in
  the browser (section 7).
- `VACUUM FULL` or any other table rewrite that blocks signing.
- Changing anything on the platform (prediction-go) or in the mocks.

## Anti-goals

- Never delete a row that a later request depends on. In particular, cancelling an order needs
  the row that says which wallet signed it (see "Routed orders" below).
- Never delete a withdrawal or transfer, a denial, a failure, or any key, user, wallet or
  setting change, from either table, except through an archive the operator ran and confirmed.
  Nothing deletes them automatically, however full the disk.
- An upgrade must never leave the operator with a stack that is down and no instruction that
  brings it back.
- Never move funds twice because of a restart or a retry.
- Existing API clients (the builder's backend) keep working. New fields only; nothing removed.

## Decisions

### The user's

- **Retention:** audit events and transfer/withdrawal operations are kept until archived.
  Order-signing operations are kept 90 days, and the period is configurable.
- **No automatic deletion of important records.** The system warns; the operator archives.
- **Archiving is manual and easy from the admin UI.** So is setting how long each kind of record
  is kept.

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

- deletes expired idempotency keys (and, in the manager, expired UI sessions and old storage
  samples). Today this only happens at boot. The boot purge stays.
- in the manager only: deletes routine rows older than their cutoff, its own and dpm-wallet's
  (through the maintenance endpoint below), as described below.

Rules for every run:

- Deletes go in batches of 5,000 rows (`DELETE … WHERE id IN (SELECT … LIMIT 5000)`). The loop
  stops when a batch deletes fewer rows, or after 100 batches per table per run. No table is
  locked for long.
- A run that is still going when the next is due is skipped, not stacked.
- A failure is logged (`retention.failed`) and never crashes the process.
- Each run logs `retention.run` with the rows deleted per table.

Settings: what the dashboard sets wins; the environment supplies the defaults.

| Setting (`platform_settings` key) | Env default | Default | Meaning |
|---|---|---|---|
| `retention.routine_days` | `OPERATIONS_RETENTION_DAYS` | 90 | Routine operation rows (manager) and routine success audit rows (both services) |
| `retention.routed_order_days` | `ROUTED_ORDER_RETENTION_DAYS` | 365 | Manager `order` rows whose signer differs from the named wallet |
| `retention.enabled` | `RETENTION_ENABLED` | true | `false` stops the scheduled trimming. The boot purge of idempotency keys and sessions still runs |
| `archive.reminder_days` | — | 730 | Important records older than this make the dashboard suggest an archive. Nothing is deleted |

- Days are whole numbers from 1 to 3650. Routed may not be below routine. The reminder may not
  be below routine.
- A bad env value fails the boot. A bad dashboard value is refused with 400 `VALIDATION_FAILED`.
- `GET /v1/settings/retention` (viewer and up) returns each value and its source (`dashboard` or
  `environment`). `PUT /v1/settings/retention` (owner/admin) changes them, writes an audit event
  `settings.retention_update` with the old and new values, and takes effect on the next run.
  Clearing a value returns it to the environment default.
- Fixed and shown read-only: idempotency keys 24 h, UI sessions (their own timeouts), container
  logs 5 × 20 MB per service.
- **dpm-wallet does not decide its own routine cutoff.** The manager's run calls a new dpm-wallet
  endpoint `POST /v1/maintenance/purge-routine-audit {before: ISO, batch: number}` (its API key,
  like every other call), which deletes one batch and returns `{deleted}`. The manager loops it
  under the same batch rules. dpm-wallet still purges its own expired idempotency keys hourly by
  itself. One source of truth: the dashboard.
- **Automatic tightening under storage pressure** (see section 6): at critical, the run uses 30
  days for routine records if the setting is above that, and 7 days if the level is still critical
  after 24 h. It logs `retention.tightened` and the dashboard says so. When the level drops below
  warning, the configured value applies again. Important records are never touched.

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

- **Graceful shutdown already exists** (`src/startup/shutdown.ts` in both: drain up to 25 s,
  then `app.close()`). The only addition: the retention job stops on `onModuleDestroy`, so a
  shutdown never waits on, or cuts into, a half-run batch loop beyond the batch in flight.
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

### 6. Storage monitor and alerts (manager)

- The manager gets a read-only mount of the Postgres volume (`pg-data:/storage/pg:ro`) used only
  for `fs.statfs`: total and free bytes of the disk the database lives on. It never reads the
  files.
- Every 15 minutes it records a sample in a new `storage_samples` table: `at`, disk total and
  free, `pg_database_size` of both databases, and per-table total size and estimated rows
  (`pg_class.reltuples`) for `operations`, `audit_events` (both) and `idempotency_keys`. Samples
  older than 30 days are trimmed by the retention run.
- **Growth and days to full:** bytes per day from the 7-day least-squares slope of disk used;
  `daysToFull = free / growth` (null when growth ≤ 0 or there are fewer than 24 h of samples).
- **Levels** (`platform_settings`, editable on the same page, owner/admin):
  - `storage.warning_percent` 75, `storage.warning_days` 30;
  - `storage.critical_percent` 90, `storage.critical_days` 7;
  - a level applies when either its percent or its days condition holds.
- **Where the operator sees it:**
  - `GET /v1/storage` (viewer and up) returns the latest sample, growth, days to full, level,
    whether routine retention is tightened, and the oldest important record date.
  - Admin UI: a banner on every page at warning (amber) or critical (red), saying what to do:
    enlarge the disk or Docker volume, archive old records (link), free Docker space
    (`docker system df`). Also an "archive suggested" note when important records are older than
    `archive.reminder_days`.
  - `./dpm-custody status` prints one storage line from `GET /v1/health/ready`'s new optional
    field `storage: {level, usedPercent, daysToFull}` read from the latest sample. The readiness
    status code never depends on storage, so a full-ish disk never restarts containers.
  - Log `storage.level` when the level changes and once a day while not OK.
  - Optional `storage.alert_webhook_url` setting: a JSON POST `{install, level, usedPercent,
    daysToFull, dbBytes, at}` when the level changes and daily while critical, 5 s timeout, no
    retries, failures logged. The URL must be http(s).
- After a successful upgrade, `dpm-custody upgrade` removes the install's images other than the
  current and previous versions.

### 7. Archive (manager, admin UI)

What it covers: the important records older than a cutoff the operator picks — manager
`operations` of kind `withdraw`, manager `audit_events` not covered by routine retention, and
dpm-wallet `audit_events` not covered by routine retention. Archives and their own audit events
(`archive.*`) are never archived.

Flow, on a new admin page **Storage** (viewers see it; owners act):

1. **Pick a cutoff.** Default: `archive.reminder_days` ago. The page shows the rows per table that
   it would cover (counted on demand, `created_at < cutoff`).
2. **Download.** `POST /v1/archives {before}` creates an archive record (status `pending`) and
   fixes its scope: per table, the highest `id` with `created_at < before` at this moment, so rows
   written later are never in scope. `GET /v1/archives/:id/download` streams
   `dpm-archive-<install>-<yyyymmdd>-<code>.ndjson.gz`, where `<code>` is 6 characters of the
   archive id:
   - line 1: a manifest `{archiveId, install, mode, createdAt, before, tables: {name: {maxId,
     rows}}}`;
   - then one line per row `{table, row}`, read in pages of 1000 (dpm-wallet rows through a new
     paged `GET /v1/maintenance/audit-export?before&maxId&cursor`);
   - while streaming, the server computes SHA-256 of the gzipped bytes and the row count, and on
     completion stores both with status `downloaded`. A download that breaks off leaves `pending`
     and can be retried.
3. **Confirm and remove.** The confirm dialog repeats what will be deleted and asks the owner to
   type the 6-character code from the file name. `POST /v1/archives/:id/delete {code}` refuses
   unless the archive is `downloaded` and the code matches. It then deletes, in batches of 5000,
   exactly the rows in scope (`id <= maxId AND created_at < before` with the same category
   filters), dpm-wallet's through `POST /v1/maintenance/delete-archived-audit {before, maxId,
   batch}`, followed by plain `VACUUM (ANALYZE)` on the touched tables. Status moves
   `deleting` → `done` with the deleted counts; a failure leaves `deleting` and the button resumes.
4. **History.** The page lists every archive: when, by whom, cutoff, rows, SHA-256, status. The
   `archives` table is never trimmed.

5. **View archived records.** A tab "Archived records" on the Storage page opens an archive
   file the operator picks from their own computer. The file is read in the browser; nothing is
   uploaded and nothing goes back into the database, so archived records stay where the operator
   keeps them.
   - **Integrity first:** the page computes the file's SHA-256 (Web Crypto, streamed) and matches
     it against the archive history. It shows "verified: archive of <date> by <user>, N rows", or
     a clear warning when the hash matches no archive or the file is damaged. An unverified file
     can still be browsed, under the warning.
   - **Search and filter:** table (manager operations, manager audit, dpm-wallet audit), date
     range, action or kind, outcome, wallet id, actor (key id or username), and free text over the
     whole row. Filters combine.
   - **How it scales:** a Web Worker decompresses the file with `DecompressionStream` and streams
     it line by line for each search, keeping only the first 500 matches plus a total match
     count, with a progress bar and a cancel button. Nothing holds the whole file in memory, so a
     multi-GB archive works, just more slowly.
   - **Results:** a table with the same columns as the live Operations and Audit lists. A row
     opens its full JSON. "Export matches (CSV)" streams every match, not just the first 500, to
     a download.
   - Available to every signed-in role, like the live Audit page.
   - The same viewer accepts several files at once and searches them together, so a year spread
     over several archives can be searched in one go.

Rules:
- Every step writes an audit event (`archive.create`, `archive.download`, `archive.delete`) with
  the actor; these are never archived or trimmed.
- One archive may be `pending`, `downloaded` or `deleting` at a time; a second `POST /v1/archives`
  gets 409 `ARCHIVE_IN_PROGRESS`.
- The page states plainly that deleting rows stops growth but Postgres reuses the space rather
  than returning it to the disk.
- API roles: create, download and delete need `admin` (UI owner); listing needs `readonly`.
- The dpm-wallet maintenance endpoints refuse a cutoff newer than 24 h ago, as a guard.
- The README shows how to read an archive (`gunzip -c … | head`, `jq`).

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
