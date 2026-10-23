# Multi-row queries

Every repository method that can return more than one row either takes a limit or is bounded by
construction. Audited in both services; line numbers are as of the commit that introduced this
file. A method that returns one row (`findOneBy`, `findOne`, unique-key lookups) is not listed.

## dpm-wallet-manager (`src/db/repositories/`)

| Method | File:line | Bound |
| --- | --- | --- |
| `AuditRepository.query` | `audit.repo.ts:85` | `limit` (cap 200, default 50); cursor or offset |
| `OperationRepository.query` | `operation.repo.ts:132` | `limit` (cap 200, default 50); cursor or offset |
| `WalletRepository.list` | `wallet.repo.ts:93` | `limit` + `offset` |
| `WalletRepository.listProvisioning` | `wallet.repo.ts:117` | Fixed in this task: `limit` (default 200) + `afterId` keyset; `WalletsService.reconcileAll` walks it in pages of 200 |
| `ApiKeyRepository.list` | `api-key.repo.ts:62` | `limit` + `offset` |
| `UiUserRepository.list` | `ui-user.repo.ts:43` | `limit` + `offset` |
| `PlatformSettingsRepository.all` | `platform-settings.repo.ts:28` | Bounded by construction: one row per fixed setting key (retention.*, storage.*, archive.*, mode burn), written only by code that names the key; never grows with users or orders |
| `AuditRepository.purgeRoutine` | `audit.repo.ts:69` | Batched delete (`batch` rows, at most 100 batches per run) |
| `OperationRepository.purgeRoutine` | `operation.repo.ts:112` | Batched delete, same bound |
| `IdempotencyRepository.purgeExpired` | `idempotency.repo.ts:40` | One `DELETE` returning a count, no rows loaded. Not batched: it removes only keys past the idempotency window and runs once at boot; noted, left as is |

Single-row or scalar internals, listed because they sit next to list methods:

| Method | File:line | Why it is not a growth risk |
| --- | --- | --- |
| `ApiKeyRepository.findActiveAdmin` | `api-key.repo.ts:76` | `findOne`: returns one row |
| `ApiKeyRepository.findActiveByRole` | `api-key.repo.ts:85` | `findOne`: returns one row (the install's own key) |
| `ApiKeyRepository.exists` | `api-key.repo.ts:71` | boolean |
| `UiUserRepository.count` | `ui-user.repo.ts:47` | scalar |
| `WalletRepository.findByKind` | `wallet.repo.ts:73` | `findOneBy` on `master` / `operations`: at most 2 such wallets exist |

## dpm-wallet (`src/db/repositories/`)

| Method | File:line | Bound |
| --- | --- | --- |
| `AuditRepository.query` | `audit.repo.ts:105` | `limit` (cap 200); cursor (`queryAfterCursor`, line 123) or offset |
| `AuditRepository.exportImportant` | `audit.repo.ts:142` | `query.limit`, keyset on `afterId` |
| `AuditRepository.purgeRoutine` | `audit.repo.ts:137` | Batched delete |
| `AuditRepository.deleteArchived` | `audit.repo.ts:157` | Batched delete |
| `WalletRepository.list` | `wallet.repo.ts:55` | `limit` + `offset` |
| `WalletRepository.eoaAddressPage` | `wallet.repo.ts:68` | Fixed in this task (was `allEoaAddresses`, which loaded every EOA): `limit` + `afterIndex` keyset; the boot-time vault check walks it in pages of 500 |
