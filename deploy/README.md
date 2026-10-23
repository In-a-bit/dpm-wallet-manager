# Install your DPM custody service

This guide sets up the service that holds your users' wallets. You don't need to be technical.
Plan for about 15 minutes, most of it waiting for downloads.

## Before you start

You need two things:

1. **Your builder private key.** The platform team gives it to you. It's a long line of text
   that starts with `bld_sk_`. Keep it private, like a password.
2. **Docker.** This is the free program the service runs in.
   - **Windows or Mac:** install [Docker Desktop](https://www.docker.com/products/docker-desktop/)
     and open it once. Wait until it says it's running.
   - **Linux server:** install [Docker Engine](https://docs.docker.com/engine/install/).

## Step 1: Run the installer

Open a terminal (**Terminal** on Mac and Linux, **PowerShell** on Windows), paste the line for
your system, and press Enter.

**Mac or Linux**

```sh
curl -fsSL https://github.com/In-a-bit/dpm-wallet-manager/releases/latest/download/install.sh | sh
```

**Windows (PowerShell)**

```powershell
irm https://github.com/In-a-bit/dpm-wallet-manager/releases/latest/download/install.ps1 | iex
```

It downloads and starts the service, then opens the **setup dashboard** in the same window.

## Step 2: Follow the setup dashboard

The dashboard is a checklist of everything setup does. Each line shows ✔ when it's done, a
spinner while it runs, and ○ while it's still to come. The box at the bottom explains the
highlighted line in plain words, and asks you a question when one is needed. Every answer is
checked as soon as you give it. If one is wrong, it says why and asks again.

1. **Choose the platform** you're joining. If you're not sure, ask the platform team.
2. **Paste your builder private key.** It isn't shown as you paste it. It should say
   "Connecting as" followed by your company's name.
3. **Choose how your users' funds are held.** If you're not sure, choose **Segregated**. This
   choice can't be changed later, so you type `yes` to confirm it.
4. **Wait a minute or two** while each step gets a ✔. While you wait:
   - **↑ and ↓** pick a step.
   - **?** explains it in more detail.
   - **d** shows exactly what it did: each request, its answer and its timing.
5. **Create your login** for the admin dashboard: a username and a password of at least 12
   characters.
6. **Save the backup kit.** It's printed above the dashboard. Copy all of it somewhere safe and
   private, such as a password manager, then type `saved`. If you lose this computer, the backup
   kit is the only way to recover. Never send it to anyone, support included.

The last screen shows the **backend key** and the **wallet manager address**. Give both to
whoever runs your backend. The **admin dashboard** is at that address followed by `/admin`.
Sign in there with the login you just created to see your wallets, manage API keys, read the
audit log, and add more people.

You can close the window at any time, even halfway through: setup carries on in the
background. Run `~/dpm-custody/dpm-custody setup` to see it again. On Windows, use the command
the installer printed.

### If setup stops

The dashboard says which step stopped, why, and what to try. Fix that, then press **r** to try
again. Finished steps aren't repeated.

If it keeps stopping, run `~/dpm-custody/dpm-custody support`. It writes one file with
everything support needs: the checklist, what each step did and when, the state of each service,
and their recent logs. Keys in it are masked, so it's safe to email. Send that file to the
platform team, with the **reference** shown on the dashboard.

## Everyday use

Everything lives in the `dpm-custody` folder in your home folder. On Mac and Linux:

| To…                          | Run                                  |
| ---------------------------- | ------------------------------------ |
| start it (e.g. after reboot) | `~/dpm-custody/dpm-custody start`    |
| stop it                      | `~/dpm-custody/dpm-custody stop`     |
| see what's running           | `~/dpm-custody/dpm-custody status`   |
| make a backup                | `~/dpm-custody/dpm-custody backup`   |
| update to the newest version | `~/dpm-custody/dpm-custody upgrade`  |
| undo the last update         | `~/dpm-custody/dpm-custody rollback` |
| get help from support        | `~/dpm-custody/dpm-custody support`  |
| see setup again              | `~/dpm-custody/dpm-custody setup`    |

On Windows, open PowerShell in `%USERPROFILE%\dpm-custody` and use
`docker compose --env-file .env -f compose.yml` followed by `up -d`, `stop`, `ps` or `logs`.

**Back up regularly.** A backup lands in the `backups` folder. Copy it somewhere off this
machine. It contains secrets, so keep it private.

## Upgrading

```sh
~/dpm-custody/dpm-custody upgrade            # the newest release
~/dpm-custody/dpm-custody upgrade 1.4.0      # a given release
~/dpm-custody/dpm-custody upgrade --yes      # without the question (for scripts)
```

It runs these steps in order. Until the switch, nothing in the install changes, and any problem
stops the upgrade with the install running as before:

1. Downloads the release's `compose.yml`, `versions.env` and `dpm-custody` into `upgrade.tmp/`
   and checks them against its `SHA256SUMS`. A release without `SHA256SUMS`, or a file that does
   not match, stops the upgrade.
2. Checks that the release is newer than the installed version (`DPM_CUSTODY_VERSION` in `.env`)
   and that the install is not below the release's `MIN_UPGRADE_FROM`. If it is, the message
   names the version to upgrade to first. It also checks that every service is healthy now, and
   that free disk is at least twice the size of the databases plus 1 GB.
3. Shows the installed and new versions and the release notes, and asks. Without a terminal it
   needs `--yes`.
4. Takes a backup (`dpm-custody backup`). A failed backup stops the upgrade.
5. Downloads the new images while the old ones keep running.
6. Keeps the current `compose.yml`, `versions.env`, `.env` and `dpm-custody` as `*.prev`
   (readable only by you).
7. Switches: puts the new files in place, sets the new image tags and `DPM_CUSTODY_VERSION` in
   `.env`, and restarts. Database changes run as each service starts.
8. Waits up to 5 minutes for every service to be healthy. If they are, it removes this install's
   older images (other than the new and previous ones) and is done. If not, it rolls back by
   itself (below) and tells you where the backup is.

**Installs from before this command:** their `.env` has no `DPM_CUSTODY_VERSION` and their
`dpm-custody` cannot fetch the new one. Run the installer again once (Step 1). On an existing
install it only replaces the `dpm-custody` script and keeps your data and settings. Then run
`dpm-custody upgrade`. It says "installed version unknown", skips the version checks this once,
and records the new version.

## Rolling back

```sh
~/dpm-custody/dpm-custody rollback
```

This undoes the last upgrade. It puts back `compose.yml` and `dpm-custody` from the `*.prev`
files. In `.env` it resets only the image tags and `DPM_CUSTODY_VERSION`, so any other change you
made to `.env` since the upgrade stays. Then it restarts and waits for every service to be healthy,
like an upgrade does. Without `*.prev` files there is nothing to undo, and it says so.

A rollback never touches the databases. That is safe because a release's database changes only
add (new tables, new optional columns, new indexes), so the previous version runs on them. A
release that cannot keep that promise raises `MIN_UPGRADE_FROM` and says so in its notes. Undoing
it means restoring the backup.

## Restoring a backup

Only do this when the platform team asks you to, for example when even the previous version does
not come up after a rollback. It replaces both databases with the backup's copy. Anything done
since that backup is lost.

```sh
cd ~/dpm-custody
B=backups/20261023-101500        # the backup folder to restore
DB_USER=dpm                      # POSTGRES_USER in .env
./dpm-custody stop
docker compose --env-file .env -f compose.yml up -d postgres
docker compose --env-file .env -f compose.yml exec -T postgres \
  psql -U "$DB_USER" -d postgres -c 'DROP DATABASE dpm_wallet_manager' -c 'DROP DATABASE dpm_wallet'
docker compose --env-file .env -f compose.yml exec -T postgres \
  psql -U "$DB_USER" -d postgres <"$B/databases.sql"
./dpm-custody start
```

The restore prints `role "dpm" already exists`. That is expected. The backup also holds the
configuration (`config.tar.gz`) and the wallet keys (`wallet-data.tar.gz`). An upgrade or a
rollback never changes them, so you do not restore them here. If they are lost, for example on a
new machine, ask the platform team.

## If something goes wrong

- **"Docker is not running":** open Docker Desktop, wait a minute, and run the installer again.
  Running it again is always safe: on an existing install it only refreshes the `dpm-custody`
  script (checked against the release's `SHA256SUMS`) and starts the stack. It never touches
  `compose.yml`, `versions.env` or `.env`. To move to the new version, run
  `./dpm-custody upgrade`.
- **"This key was not accepted":** copy the whole key again, and check you chose the right
  platform.
- **Setup stopped with an error:** fix what the dashboard says, then press **r**. Finished steps
  are kept.
- **Port already in use:** another program uses port 3000. Rerun the installer with another
  port, e.g. `DPM_CUSTODY_MANAGER_PORT=3001` before `sh`.

For anything else, run `dpm-custody support` and send the file it writes to the platform team.

## Release files and checks

Each release carries `install.sh`, `install.ps1`, `compose.yml`, `versions.env`, `dpm-custody` and
a `SHA256SUMS` file. The installer checks every file it downloads against `SHA256SUMS` and stops
without writing anything if one differs; a release without `SHA256SUMS` (the download answers "not found") installs with a warning, while any other failure to fetch it stops the install. `SHA256SUMS` protects against corrupt or mixed downloads, not against a compromised release.
`versions.env` pins both images by digest (`<version>@sha256:...`) and records `RELEASE_VERSION`,
which the installer writes to `.env` as `DPM_CUSTODY_VERSION`.

Installer variables: `DPM_CUSTODY_RELEASES_URL` replaces the download base (`file://` works),
`DPM_CUSTODY_NO_START=1` stops after the files and `.env` are written, and `DPM_IMAGE_REGISTRY`
(default `ghcr.io/in-a-bit`) names the registry the images are pulled from. Run
`bash deploy/test/install.test.sh` to check the installer without Docker.

## For administrators

- **Services:** Postgres, dpm-wallet, dpm-wallet-manager and a setup service. All come from the
  public images `ghcr.io/in-a-bit/dpm-wallet` and `ghcr.io/in-a-bit/dpm-wallet-manager`. See
  `compose.yml`.
- **Network exposure:** only the manager API (3000) is published, on `127.0.0.1`. Setup has no
  port: it runs in a terminal, inside its container. To reach the manager from another host, set `MANAGER_BIND=0.0.0.0` in
  `.env` and put TLS in front of it.
- **Configuration:** setup writes both services' configuration into the `config` volume. It
  also keeps its state there, plus `setup-journal.jsonl`, a masked log of every step, which the
  support report includes. It gets the platform values from dpm-api `GET /wallet-install/config`, authenticated
  with the builder key, and generates every other secret itself.
- **Credentials:** the builder private key (`X-Builder-Api-Private-Key`) is the install's only
  platform credential, so no platform-wide `APP_API_KEY` is handed out or configured. The
  platform accepts it without the app key only where an install needs it:
  - dpm-api: `GET /wallet-install/config` and `POST /turnkey/sub-organizations`;
  - gamma-api: `POST /custody/users`;
  - relayer-api: every route, but bound to the install's own wallets. Except for
    `GET /contract-info`, a request must name one of them in `X-Builder-Address`. That is how
    you relay a signed meta-transaction for the master or operations wallet yourself:
    `POST /submit` with the builder key and the wallet's EOA in `X-Builder-Address`.

  Anything else, such as the CLOB, needs the app key as well. Your backend sends it.
- **Balances unavailable after an upgrade:** balances are read from the platform's data-api,
  whose address setup takes from the platform when it saves the configuration. An install set
  up before its platform published one (`PUBLIC_DATA_API_URL` on the platform side) has no
  `DATA_API_URL`, and its admin UI shows "Balances unavailable". Running `dpm-custody setup`
  again does not fix this: on a finished install it reports "Setup is already done" and does
  not rewrite the configuration. Once the platform publishes its data-api, add the variable to
  dpm-wallet's configuration and restart it:

  ```sh
  cd ~/dpm-custody
  docker compose --env-file .env -f compose.yml exec setup \
    sh -c 'echo "DATA_API_URL=https://<the platform data-api address>" >> /config/dpm-wallet.env'
  docker compose --env-file .env -f compose.yml restart dpm-wallet
  ```

  The platform team can tell you the address; it is the `data_api` service that
  `GET /wallet-install/config` reports.

### Logs

Every service keeps at most five container log files of 20 MB each (100 MB per service), then
discards the oldest. Read them with `docker compose --env-file .env -f compose.yml logs <service>`.

### Retention

The manager deletes routine records after a set time: operations after 90 days, and orders that
were signed for another wallet (routed orders) after 365 days. Important records are never deleted
automatically. To change the defaults, add any of these to `.env` and restart the manager. An
empty value means the default. A value set in the dashboard wins over `.env`.

```sh
OPERATIONS_RETENTION_DAYS=90        # whole days, 1 to 3650
ROUTED_ORDER_RETENTION_DAYS=365     # whole days, 1 to 3650, not below the line above
RETENTION_ENABLED=true              # false turns automatic deletion off
```

A bad value stops the manager from starting, and the log says which one.

### Health

`GET /v1/health` answers whether the process is up. `GET /v1/health/ready` also runs a database
query and answers `200 {"status":"ok"}` or `503 {"status":"unavailable"}`; neither needs a key.
Compose runs the ready probe on dpm-wallet (port 8090, inside the stack) and the manager (port
3000), every 10 seconds, with a 60 second start period. Check with `docker compose --env-file .env -f compose.yml ps`.

On a fresh install both services wait for setup to write their configuration, so they show
`starting` and then `unhealthy` until setup finishes. That is expected, and they turn `healthy`
by themselves afterwards. The manager starts after dpm-wallet has started, not after it is healthy,
so a fresh install can come up and reach setup.

---

# Running it per environment (platform team)

The steps above are what a builder does. This part is for the platform team: what a platform
needs before builders can install against it, how to try the install yourself (local or dev),
and how to release it for production. Setup offers Production, Development and Custom (any
dpm-api address); add an environment in `src/setup/environments.ts`.

## What every environment needs first

The installer works only when the platform it points at has all four of these. The pre-flight
check below tells you which one is missing; `deploy/try-install.sh` runs it for you.

1. **prediction-go deployed with both changes**
   - dpm-api serves `GET /wallet-install/config`.
   - gamma-api accepts `X-Builder-Api-Private-Key` alone on `POST /custody/users`, and
     relayer-api accepts it alone (bound to the builder's own wallets).
   - **Order:** deploy gamma-api and relayer-api before any install that runs without
     `APP_API_KEY`, or user registration and signing answer 401.
2. **dpm-api's env sets the three public URLs**
   - `PUBLIC_DPM_API_URL`, `PUBLIC_GAMMA_API_URL`, `PUBLIC_RELAYER_API_URL`.
   - Without them, the endpoint answers 503.
3. **Both images are published on GHCR and public**
   - `ghcr.io/in-a-bit/dpm-wallet` and `ghcr.io/in-a-bit/dpm-wallet-manager`.
   - They must include these changes. For dpm-wallet, that means `APP_API_KEY` is optional.
4. **A custody builder with a private key**
   - Issued in that environment's backoffice, under **Custody builders**.
   - **One install per builder.** Each install creates the builder's Turnkey sub-organization.
     A second install for the same builder stops at "Create the secure key vault" with a 409.
     Test with a new builder each time.

**Pre-flight check** (replace the URL and key). The last line shows the status code:

```sh
curl -s -w '\nHTTP %{http_code}\n' <dpm-api URL>/wallet-install/config \
  -H 'X-Builder-Api-Private-Key: bld_sk_...'
```

| Answer                                                 | Meaning                                                   |
| ------------------------------------------------------ | --------------------------------------------------------- |
| JSON with `owner`, `chain_id`, `contracts`, `services` | Ready                                                     |
| `404`                                                  | dpm-api is not deployed with the endpoint (1)             |
| `503`                                                  | the `PUBLIC_*` URLs are not set (2)                       |
| `401`                                                  | wrong key, or a key from another environment (4)          |
| `409`                                                  | the key belongs to an embedded builder, not a custody one |

## Try it yourself: local or dev

`deploy/try-install.sh` installs on your machine exactly what a builder installs. It works
against any platform you can reach: one running on your computer, or a shared one such as dev.
Run it from your dpm-wallet-manager checkout. It doesn't depend on where your folders are or
what else runs on the machine.

### What you need

1. **Docker, curl and python3.**
2. **A platform that meets the four requirements above**, reachable from this machine. You give
   the script its dpm-api address.
3. **A new custody builder and its private key**, from that platform's backoffice:
   1. Go to **Custody Builders**.
   2. Under **Onboard custody builder**, type a name and click **Create custody builder**.
   3. On the builder's row, click **New key**, confirm, and click **Copy**.

   Use a builder that has never been installed: each builder can be installed only once.

4. **Images**, from one of two places:
   - **Published:** `--images TAG`. For example, `dev` is published once changes are merged to
     `dev`, and a version number after a release.
   - **Built from source:** `--build`. This uses your dpm-wallet-manager checkout plus a
     dpm-wallet checkout, given with `--wallet-src`. By default it looks for a `dpm-wallet`
     folder next to this one.

### Run it

| Trying against                                        | Command                                                                      |
| ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| A platform on your computer, images built from source | `./deploy/try-install.sh --build --wallet-src ../dpm-wallet`                 |
| Dev, with the published dev images                    | `./deploy/try-install.sh --platform https://dpm-api.inabit.dev --images dev` |

Everything happens in the terminal; no browser is needed. The script asks for the platform
address (suggesting `http://localhost:8086`) unless you pass `--platform`, and for the builder key
unless you pass it as the last argument. `--images` defaults to `main`. It then:

1. **Checks** Docker, then each answer as soon as you give it: that the platform answers and
   supports self-install, then that it accepts your key (and names your builder). A wrong answer
   is asked for again; a problem on the platform's side stops the run and says what to fix.
2. **Prepares the images:** it pulls or builds them.
3. **Installs** into `~/dpm-custody-try` (`--dir` to change). It uses port 3000, or the next
   free one if that's taken.
4. **Sets up** with the install's own terminal setup (`dpm-custody setup`). That setup checks the
   platform and key again, from inside the install, without asking for them again. Then it asks
   for the custody mode, creates your admin login, and shows the backup kit.
5. **Offers the smoke test** (`verify`, below).

```sh
./deploy/try-install.sh verify   # services, platform status, and scripts/smoke.sh
./deploy/try-install.sh clean    # remove the install to start over (then use a new builder)
```

If you used `--dir`, pass the same `--dir` to both.

### Two installs side by side: one segregated, one shared

Each install needs its own **name**, its own **folder** and its own **builder**: create two
custody builders in the backoffice and issue a key for each. Name each install after its mode,
so you can always tell them apart:

```sh
./deploy/try-install.sh --build --name dpm-custody-segregated --dir ~/dpm-custody-segregated
#   setup asks for the mode: choose Segregated
./deploy/try-install.sh --build --name dpm-custody-shared --dir ~/dpm-custody-shared
#   setup asks for the mode: choose Shared
```

`--build` is only needed once: the second run reuses the images the first built, unless the
source changed in between.

How they stay apart:

- **Containers, volumes and network** are all prefixed with the name, which is written into the
  install's `.env` as `COMPOSE_PROJECT_NAME`. The two never share anything.
- **Ports:** the only port an install publishes is its wallet manager's. Each gets the first free
  port from 3000 that no other container has claimed, even a stopped one. It's in the install's
  `.env` as `MANAGER_PORT`, and the setup dashboard shows it at the end.
- **A name already used** by another install, running or stopped, is refused.

Everything else finds the install by its folder:

```sh
./deploy/try-install.sh verify --dir ~/dpm-custody-shared   # smoke test one install
~/dpm-custody-shared/dpm-custody status                      # or any everyday command
./deploy/try-install.sh clean --dir ~/dpm-custody-shared     # remove one install only
```

A builder installing for real can do the same with `DPM_CUSTODY_NAME=… DPM_CUSTODY_DIR=…` before
`sh`.

### Preparing a platform on your own computer

Any way you run prediction-go works, as long as:

- **Version:** dpm-api and gamma-api run a version with the self-install changes (see
  requirement 1).
- **Public URLs:** dpm-api's env has the three `PUBLIC_*` URLs, set to where this machine reaches
  those services. With prediction-go's default ports:

  ```sh
  PUBLIC_DPM_API_URL=http://localhost:8086
  PUBLIC_GAMMA_API_URL=http://localhost:8084
  PUBLIC_RELAYER_API_URL=http://localhost:8085
  ```

  `localhost` is fine: setup rewrites it so its containers can reach your computer.
  Restart dpm-api after changing them.

- **Backoffice:** the backoffice is running (the prediction-backoffice UI and its backend), so
  you can issue the key.

### Preparing dev

In prediction-env, `dev/prediction.env` for dpm-api:

```sh
PUBLIC_DPM_API_URL=https://dpm-api.inabit.dev
PUBLIC_GAMMA_API_URL=https://gamma-api.inabit.dev
PUBLIC_RELAYER_API_URL=https://relayer-api.inabit.dev
```

Deploy prediction-go to `dev` with **Manage ENV Deployments**, gamma-api first, then dpm-api.
Merge dpm-wallet and dpm-wallet-manager to `dev` so the `:dev` images exist. Then get a key from
the dev backoffice and run the dev command above.

### The same, by hand

These are the script's steps, if you want to see or run each one. Run them from your
dpm-wallet-manager checkout, in one terminal. Set the first line to your platform.

**1. The platform to join.**

```sh
PLATFORM=http://localhost:8086
```

**2. Your builder private key.**

```sh
read -rp "Builder private key: " BUILDER_KEY
```

**3. Pre-flight.**

```sh
curl -s -w '\nHTTP %{http_code}\n' "$PLATFORM/wallet-install/config" \
  -H "X-Builder-Api-Private-Key: $BUILDER_KEY"
```

This should print your builder's name, `chain_id`, `contracts` and `services`, ending
`HTTP 200`. Any other code is explained in the pre-flight table above. Then check gamma-api and
relayer-api at the addresses the platform just reported. Neither request changes anything:

```sh
SERVICES=$(curl -s "$PLATFORM/wallet-install/config" -H "X-Builder-Api-Private-Key: $BUILDER_KEY")
GAMMA=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["services"]["gamma_api"])' <<<"$SERVICES")
RELAYER=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["services"]["relayer_api"])' <<<"$SERVICES")
curl -s -o /dev/null -w 'gamma-api: HTTP %{http_code}\n' -X POST "$GAMMA/custody/users" \
  -H "X-Builder-Api-Private-Key: $BUILDER_KEY" -H 'Content-Type: application/json' -d '{}'
curl -s -o /dev/null -w 'relayer-api: HTTP %{http_code}\n' "$RELAYER/contract-info" \
  -H "X-Builder-Api-Private-Key: $BUILDER_KEY"
```

This should print `gamma-api: HTTP 400` (the key was accepted and the empty body refused) and
`relayer-api: HTTP 200`. `HTTP 401` from either means that service does not accept the builder
key there.

**4. Images.** Use one of the two blocks.

Published images:

```sh
TAG=dev
docker pull "ghcr.io/in-a-bit/dpm-wallet:$TAG"
docker pull "ghcr.io/in-a-bit/dpm-wallet-manager:$TAG"
```

Built from source (set `WALLET_SRC` to your dpm-wallet checkout):

```sh
TAG=local
WALLET_SRC=../dpm-wallet
docker build -t "ghcr.io/in-a-bit/dpm-wallet:$TAG" "$WALLET_SRC"
docker build -t "ghcr.io/in-a-bit/dpm-wallet-manager:$TAG" .
```

**5. Install.** If 3000 is taken on your machine, change the port variable.

```sh
SRC=$(mktemp -d)
cp deploy/compose.yml deploy/dpm-custody "$SRC/"
printf 'DPM_WALLET_TAG=%s\nDPM_WALLET_MANAGER_TAG=%s\n' "$TAG" "$TAG" > "$SRC/versions.env"
DPM_CUSTODY_DIR=~/dpm-custody-try DPM_CUSTODY_SOURCE="$SRC" \
  DPM_CUSTODY_MANAGER_PORT=3000 SETUP_PLATFORM_URL="$PLATFORM" sh deploy/install.sh
```

**6. Setup.** The installer goes straight on to the setup dashboard. `SETUP_PLATFORM_URL` has
already answered the platform question, so:

1. Paste your key. It should say "Connecting as" followed by your builder's name.
2. Pick a mode and type `yes`. Wait until every step has a ✔.
3. Create the admin login, save the backup kit, and type `saved`.

**7. Verify.**

```sh
./deploy/try-install.sh verify
```

This checks the services and the platform status, then runs `scripts/smoke.sh`, which ends
with every line ✓.

**8. Start over.** Only one install can run on a machine at a time, because they share the
Docker project name `dpm-custody`.

```sh
./deploy/try-install.sh clean
```

## Production (`dpm.network`)

This is exactly what a builder runs (Step 1 at the top of this guide), so it's the final check
before telling builders about it.

**1. Platform.** In prediction-env, `prod/prediction.env` for dpm-api:

```sh
PUBLIC_DPM_API_URL=https://api.dpm.network
PUBLIC_GAMMA_API_URL=https://gamma-api.dpm.network
PUBLIC_RELAYER_API_URL=https://relayer-api.dpm.network
```

Deploy prediction-go to `prod` (gamma-api first, then dpm-api).

**2. Images and installer files.**

1. Tag a dpm-wallet release (`vX.Y.Z`); that publishes `ghcr.io/in-a-bit/dpm-wallet:X.Y.Z`.
2. Set `DPM_WALLET_TAG=X.Y.Z` in this repo's `deploy/versions.env` and merge it to `main`.
3. Tag a dpm-wallet-manager release (`vA.B.C`). CI publishes its image and attaches the installer
   files to the GitHub release, with the manager pinned to `A.B.C`.
4. The first time only: make both GHCR packages **Public** (package settings → Change
   visibility).

**3. Key.** In the production backoffice, go to **Custody builders**, create a builder (use one
reserved for testing) and issue its key. Run the pre-flight check against
`https://api.dpm.network`.

**4. Install** exactly as a builder would:

```sh
curl -fsSL https://github.com/In-a-bit/dpm-wallet-manager/releases/latest/download/install.sh | sh
```

When the setup dashboard asks, choose **Production**, paste the key and choose a mode.

**5. Verify.** From your dpm-wallet-manager checkout, run
`./deploy/try-install.sh verify --dir ~/dpm-custody`. This is real production: use small
amounts, and revoke the test builder's key in the backoffice when done.
