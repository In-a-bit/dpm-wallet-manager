# dpm-wallet-manager

The policy and directory layer in front of [`dpm-wallet`](../dpm-wallet).

`dpm-wallet` is deliberately dumb: it mints Turnkey-backed addresses, signs whatever it is asked
to sign, and enforces nothing — "authorisation stops at the API key: a caller that holds it may
ask for any signature the service offers, for any `ref`". That is the right design for a signing
service and the wrong one to expose to a product.

This service is what makes it usable. It owns:

- **Identity** — a Postgres wallet directory with its own ids, so callers never handle `ref`s.
- **Two roles** — an `admin` key for administration and an `operator` key for operations, both
  rotatable, revealable and audited.
- **Custody mode** — `segregated` or `shared`, burned in on first boot and immutable after.
- **One hard money rule** — USDC leaves the platform only from the **master wallet**, only with
  the **admin** key.
- **Ergonomics** — a caller says "wallet X buys"; this service works out who signs, who funds and
  who is paid.

It is **sign-only**, like the service beneath it. It returns signed orders and submit-ready
meta-transaction bodies; the caller posts them to `clob-api` and `relayer-api`.

---

## The two modes

Set once, in `DPM_WALLET_MANAGER_MODE`, and burned into `platform_settings` on the first boot. A
container whose environment disagrees with the burned value **refuses to start** — see
[Mode is permanent](#mode-is-permanent).

| | `segregated` | `shared` |
|---|---|---|
| Who holds USDC | every wallet, its own | the **operations wallet**, all of it |
| Order `recipient` | never used | used on every trade |
| Operations wallet | allowed, unused | required |

### How an order is routed

The caller always names the *user-facing* wallet. What happens next is the whole reason this
service exists:

| mode | side | signs | `maker` (funds) | `recipient` (proceeds) |
|---|---|---|---|---|
| `segregated` | BUY | user | user proxy | — |
| `segregated` | SELL | user | user proxy | — |
| `shared` | BUY | **operations** | operations proxy | user proxy |
| `shared` | SELL | user | user proxy | operations proxy |

The invariant underneath: **the maker is always the source of funds**; the recipient only receives
proceeds. So "who makes?" is really "whose money is being spent?", and the mode answers it. In
shared mode a BUY spends the treasury's USDC and credits the user's tokens; a SELL spends the
user's tokens and sweeps the USDC back to the treasury.

Every order response carries a `routing` block naming the signer, maker and recipient, so a caller
never has to infer what was decided.

## The two platform wallets

| | created by | purpose |
|---|---|---|
| **master** | `POST /v1/platform/master-wallet`, **admin key** | The only wallet USDC may leave the platform from. Never gets an allowance, so it cannot trade — both are enforced, not conventions. |
| **operations** | `POST /v1/platform/operations-wallet`, **operator key** | In `shared` mode, the treasury: makes every BUY, receives every SELL. |

Both are ordinary Turnkey wallets upstream. All the specialness lives here.

## The money rule

`FundsPolicyService` is the only thing that may authorise a value-moving signature, and every
route passes through it:

```
recipient is an address in our directory        → allowed, operator key
recipient is outside, from the master wallet
  with an admin key                             → allowed, audited as meta.withdraw.external
anything else with a recipient outside          → 403 EXTERNAL_TRANSFER_FORBIDDEN
allowance on the master wallet                  → 403 MASTER_ALLOWANCE_FORBIDDEN
order/cancel on the master wallet               → 403 MASTER_WALLET_CANNOT_TRADE
```

A refusal happens **before** anything is signed: a signed withdrawal envelope is a bearer
instrument, and "we signed it but did not return it" is not a meaningful distinction once it
exists. Every decision — permitted and refused — writes an audit row.

Internal movement is otherwise unrestricted: whose funds may move where inside the platform is the
caller's business logic, not this service's.

---

## Running it

```bash
cp .env.example .env
openssl rand -hex 32   # → DPM_WALLET_MANAGER_MASTER_KEY
# set DPM_WALLET_BASE_URL and DPM_WALLET_API_KEY to reach your dpm-wallet

docker compose up -d postgres
npm ci
npm run db:migrate
npm run dev
```

`docker compose up` runs the whole thing; the image's command migrates and then starts the
service, so a failed migration stops the boot rather than serving against a stale schema.

OpenAPI is at `/v1/docs` (Swagger UI) and `/v1/docs-json` (the raw document).

### First API key (bootstrap)

On boot, if `api_keys` is empty, the service inserts the first admin key **in code** (no CLI):

- **`DPM_WALLET_MANAGER_BOOTSTRAP_ADMIN_KEY` set** → that string is adopted (must be well-formed;
  see format below). Logs `startup.bootstrap_admin_key_adopted` with prefix only.
- **unset** → a random key is minted and logged once as `startup.bootstrap_admin_key_minted`
  (includes the plaintext — prefer setting the env in anything shared).

Use that value as `X-API-Key` for `POST /v1/api-keys` and everything else. Later boots do nothing
if any key already exists.

Wrong: `BOOTSTRAP_ADMIN_KEY=bootstrap-admin-key` → validation error (and boot fails if set).  
Right: `BOOTSTRAP_ADMIN_KEY=dpmm_live_ad_k7m2q9x4b3n8v3c6z2s5t2r7w4y9p8j3` (and
`DPM_WALLET_MANAGER_KEY_ENV=live`).

### API key format

Every key — bootstrap env value, minted keys, and every `X-API-Key` header — must match:

```text
dpmm_<env>_<role>_<32-char-secret>
```

| Segment | Meaning |
|---|---|
| `dpmm` | fixed namespace |
| `<env>` | `DPM_WALLET_MANAGER_KEY_ENV` (e.g. `live`, `test`) — 2–12 `[a-z0-9]` |
| `<role>` | `ad` = admin, `op` = operator |
| `<secret>` | exactly 32 chars from `a-hjkmnpqrstuvwxyz23456789` |

Example: `dpmm_live_ad_k7m2q9x4b3n8v3c6z2s5t2r7w4y9p8j3`.

`parseApiKey` in `src/crypto/api-key-format.ts` enforces this on bootstrap **and** on every
request. A free-form string never authenticates and never gets stored.

### Verifying an install

```bash
BASE_URL=http://localhost:3000 ADMIN_KEY=dpmm_live_ad_… ./scripts/smoke.sh
```

Walks the whole API against a **real** `dpm-wallet` and asserts the routing decision and the money
rule. The test suite covers everything else; this covers the one thing a test double cannot — that
the `maker` and `recipient` this service rewrites are accepted upstream.

---

## API

Base path `/v1`. Authenticate with `X-API-Key`. Signing routes accept `Idempotency-Key`.
Errors are `{ "error": { "code", "message", "details"? } }`.

**The schema is the contract.** `/v1/docs-json` is generated by the
[OpenAPI CLI plugin](https://docs.nestjs.com/openapi/cli-plugin) from the controllers and DTOs, so
every operation carries its summary, description, path and query parameters, request body, typed
success response, and every error code it can return with an explanation of each. Generate a
client from it rather than hand-writing one. The table below is a map, not the reference.

### Keys — `admin`, except `self`

| | | |
|---|---|---|
| `GET` | `/api-keys` | metadata only, never a secret |
| `POST` | `/api-keys` | `{ role, name, expiresAt? }` → the plaintext, **once** |
| `POST` | `/api-keys/:id/rotate` | `{ graceSeconds }` → both keys work during the overlap |
| `POST` | `/api-keys/:id/reveal` | the full key; throttled and audited |
| `DELETE` | `/api-keys/:id` | revoke; refuses the last usable admin key |
| `GET` | `/api-keys/self` | any role — the UI's session probe |

### Platform

| | | |
|---|---|---|
| `GET` | `/platform` | mode, both platform wallets, wallet count, upstream health — one call for a dashboard |
| `POST` | `/platform/master-wallet` | **admin** |
| `POST` | `/platform/operations-wallet` | **operator** |

### Wallets — `operator`, except `PATCH`

| | | |
|---|---|---|
| `POST` | `/wallets` | `{ externalId?, label? }` |
| `GET` | `/wallets` | `?kind&status&q&limit&offset` |
| `GET` | `/wallets/:id`, `/wallets/by-external/:externalId` | |
| `PATCH` | `/wallets/:id` | **admin** — `{ label?, status? }` |
| `POST` | `/wallets/:id/reconcile` | finish a half-done provisioning |
| `POST` | `/wallets/:id/dpm-attestation` | EOA + proof of control, to register with the platform |
| `POST` | `/wallets/:id/dpm-registered` | `{ registered }` — a precondition for every meta-tx |

### Trading and meta-transactions — `operator`

| | | |
|---|---|---|
| `POST` | `/wallets/:id/orders/sign` | `{ side, tokenId, shares, price, feeRateBps }` → signed order + `routing` |
| `POST` | `/wallets/:id/orders/cancel` | `{ orderHash, marketId }` — signed by whoever signed the order |
| `POST` | `/wallets/:id/allowance` | |
| `POST` | `/wallets/:id/redeem` | `{ conditionId, recipient? \| recipientWalletId? }` |
| `POST` | `/wallets/:id/split`, `/merge` | `{ conditionId, amountDecimal }` |
| `POST` | `/wallets/:id/withdraw` | `{ amountDecimal, recipient \| recipientWalletId }` |

`recipientWalletId` names a wallet in this directory instead of an address, and resolves to its
**proxy**. Use it for internal movement: it is self-evidently internal, which removes a class of
typo that would otherwise be refused as an external transfer.

### History

| | | |
|---|---|---|
| `GET` | `/audit` | the decision log — who asked, what for, and whether it was permitted. `?action&outcome&walletId&actorKeyId&from&to` |
| `GET` | `/operations` | the artefact log — what was signed, and **by which wallet**. `?walletId&kind&from&to` |

Two logs because they answer different questions. In shared mode "which wallet signed the order
behind this hash" is not answerable from the decision log: the caller named the user, the treasury
signed.

---

## Design notes

### API keys are stored twice

An HMAC for verification, and an AES-256-GCM envelope so an admin can reveal the key later. That
second copy is a deliberate trade: an operator can recover a mislaid credential instead of
rotating every time, at the cost of the key being recoverable by someone holding *both* an admin
key and `DPM_WALLET_MANAGER_MASTER_KEY`. The audit row on every reveal is what makes the trade
accountable rather than merely convenient.

Verification is HMAC-SHA256, not Argon2. A password needs a slow KDF because it has little
entropy; these keys carry 160 random bits, so guessing is already impossible and a slow KDF would
only add tens of milliseconds to every request. The pepper is what stops someone with the table —
but not the master key — confirming a guess offline.

`DPM_WALLET_MANAGER_MASTER_KEY` is HKDF-expanded into both the pepper and the encryption key. One
secret, because the two must always change together: a mismatched pepper makes every key
unverifiable, a mismatched encryption key makes every key unrevealable.

### Wallet creation writes the row first

1. insert the row as `provisioning`, and commit;
2. ask `dpm-wallet` for an address, keyed by the row's own id;
3. write the address back and mark it `active`.

Minting upstream first would, on a crash in between, leave an address holding customer funds that
this service has no record of. This way a crash leaves a `provisioning` row — refused by every
signing route — and because `ref` is derived from the row id, retrying is a no-op upstream:
`REF_ALREADY_EXISTS` means "already minted, go read it". A boot sweep finishes any that are stuck.

### Mode is permanent

`platform_settings` is a key/value table, so there is no column constraint that could express
"immutable". Instead there is **no code path that updates a write-once key**: `burnOnce` issues
`INSERT … ON CONFLICT DO NOTHING` and then reads back what the database holds. Two replicas
booting at the same instant both read the same winning value; a container that disagrees with it
exits rather than picking a side. Honouring the environment would reroute new orders away from the
wallets the existing ones settled against; honouring the database would leave an operator
convinced they had switched modes when they had not.

### Constraints live in the database

"One master wallet", "one operations wallet" and "one wallet per external id" are partial unique
indexes, not read-then-insert checks — the latter cannot be made safe under concurrency without a
lock. The service translates the violation into an error code; the guarantee is Postgres'.

The `lower(...)` indexes on both address columns exist because the funds policy asks "is this
recipient one of ours?" on every withdrawal, and that check must not be a sequential scan.

### The OpenAPI document is tested, not just generated

`test/openapi.e2e-spec.ts` asserts the generated document is complete: every route accounted for,
every operation summarised and described, exactly one typed success response, every error typed as
the shared envelope and explained by code, every path parameter documented, security everywhere
except `/v1/health`, and no schema property left as a bare type. Documentation reviewed only by eye
stops being true within a release or two; this makes an undocumented addition a failing test.

Three consequences for anyone adding an endpoint:

- **Responses must be classes**, not inline object types or interfaces — the plugin can only
  introspect a class. `ApiKeyDto`, `SignedOrderResponseDto` and the rest are the single definition
  of their shape; the services return them directly rather than a parallel type.
- **JSDoc becomes documentation.** `introspectComments` routes a controller method's comment into
  the operation's `description` (`controllerKeyOfComment: "description"`) and a DTO property's
  comment into its `description`. Each `@ApiOperation` supplies the short `summary` separately.
- **Shared validation composites are invisible to the plugin.** `IsEvmAddress`, `IsDecimalAmount`
  and friends are built with `applyDecorators`, and the class-validator shim reads the AST — so a
  property using one needs an explicit `@ApiProperty` for its pattern and example. The shim is also
  wrong about `@IsPositive` on a float, mapping it to `minimum: 1`; `price` states its own bounds
  for that reason.

Errors are declared by code, not by status: `@ApiErrors("EXTERNAL_TRANSFER_FORBIDDEN", …)` looks the
status and the description up in `errors.ts`, groups codes that share a status, and attaches the
envelope. `@Roles(...)` documents its own 403, so enforcement and documentation cannot drift.

### No `dpm-sdk` dependency

Under sign-only passthrough this service never builds or signs anything, so taking the SDK would
buy nothing and cost a vendored build, a React-adjacent import graph, and a version coupling to
the EIP-712 domain. The upstream contract is declared in `src/clients/dpm-wallet.types.ts` and
pinned by `scripts/smoke.sh` against the real service.

---

## Development

```bash
npm run typecheck
npm run lint
npm test              # needs the compose postgres; each spec gets its own database
npm run db:generate -- src/db/migrations/YourChange
```

Tests boot the real application — guards, interceptor, validation pipe, exception filter,
migrations, repositories — against a throwaway Postgres database and a stand-in `dpm-wallet` that
is a real HTTP server, so the client's headers, error translation and timeout are exercised too.

`jest` runs the OpenAPI plugin through `test/swagger-transformer.js`; its options must mirror
`nest-cli.json`, and its `version` must be bumped when they change or ts-jest will serve stale
transformed output.

Node 22 (`.nvmrc`); `nvm use` before anything, or `next`/`nest` will refuse to start.
