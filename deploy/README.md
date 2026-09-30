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

When it finishes, it shows an **address** and a **6-digit PIN**, and opens your browser.

## Step 2: Finish in the browser

On the page, type the PIN, then:

1. **Choose the platform** you're joining. If you're not sure, ask the platform team.
2. **Paste your builder private key** and click **Check key**. It should say
   "Connecting as" followed by your company's name.
3. **Choose how your users' funds are held.** If you're not sure, choose
   **"Each user holds their own funds"**. This choice can't be changed later.
4. Click **Start setup** and wait a minute or two.
5. **Download the backup kit** and store it somewhere safe and private, such as a password
   manager. If you lose this computer, the backup kit is the only way to recover.

The last page shows two values: the **wallet manager address** and the **backend key**. Give
them to whoever runs your backend. That's it.

### No browser on this machine?

Some servers have no screen. You have two options:

- **From your own computer:** connect with `ssh -L 8480:localhost:8480 you@your-server`, then
  open <http://localhost:8480> on your computer.
- **In the terminal:** run `~/dpm-custody/dpm-custody setup`. It asks the same questions.

## Everyday use

Everything lives in the `dpm-custody` folder in your home folder. On Mac and Linux:

| To…                          | Run                                 |
| ---------------------------- | ----------------------------------- |
| start it (e.g. after reboot) | `~/dpm-custody/dpm-custody start`   |
| stop it                      | `~/dpm-custody/dpm-custody stop`    |
| see what's running           | `~/dpm-custody/dpm-custody status`  |
| make a backup                | `~/dpm-custody/dpm-custody backup`  |
| update to the newest version | `~/dpm-custody/dpm-custody upgrade` |
| get help from support        | `~/dpm-custody/dpm-custody logs`    |

On Windows, open PowerShell in `%USERPROFILE%\dpm-custody` and use
`docker compose --env-file .env -f compose.yml` followed by `up -d`, `stop`, `ps` or `logs`.

**Back up regularly.** A backup lands in the `backups` folder. Copy it somewhere off this
machine. It contains secrets, so keep it private.

## If something goes wrong

- **"Docker is not running":** open Docker Desktop, wait a minute, and run the installer again.
  Running it again is always safe: it never overwrites an existing install.
- **"This key was not accepted":** copy the whole key again, and check you chose the right
  platform.
- **Setup stopped with an error:** fix what the message says, then click **Retry**. Finished
  steps are kept.
- **Port already in use:** another program uses 8480 or 3000. Rerun the installer with
  different ports, e.g. `DPM_CUSTODY_SETUP_PORT=8481 DPM_CUSTODY_MANAGER_PORT=3001` before
  `sh`.

For anything else, send the output of `dpm-custody logs` to the platform team.

## For administrators

- **Services:** Postgres, dpm-wallet, dpm-wallet-manager and a setup service. All come from the
  public images `ghcr.io/in-a-bit/dpm-wallet` and `ghcr.io/in-a-bit/dpm-wallet-manager`. See
  `compose.yml`.
- **Network exposure:** only the setup page (8480) and the manager API (3000) are published,
  both on `127.0.0.1`. To reach the manager from another host, set `MANAGER_BIND=0.0.0.0` in
  `.env` and put TLS in front of it.
- **Configuration:** the setup page writes both services' configuration into the `config`
  volume. It gets the platform values from dpm-api `GET /wallet-install/config`, authenticated
  with the builder key, and generates every other secret itself.
- **Credentials:** the builder private key is the install's only platform credential, the same
  way an LP key is for a liquidity provider. dpm-api, gamma-api and relayer-api all accept it
  (`X-Builder-Api-Private-Key`), so no platform-wide `APP_API_KEY` is handed out or configured.

---

# Running it per environment (platform team)

The steps above are what a builder does. This part is for us: how to run the same installer
against **local**, **dev** and **production**, and what must be in place first. Sandbox is
listed on the setup page but does not exist yet.

## What every environment needs first

The installer works only when the platform it points at has all four of these. The check in
each section below tells you which one is missing.

1. **prediction-go deployed with both changes**
   - dpm-api serves `GET /wallet-install/config`.
   - gamma-api's gate accepts `X-Builder-Api-Private-Key`.
   - **Order:** deploy gamma-api before any install that runs without `APP_API_KEY`, or user
     registration answers 401.
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

## Local (a platform on your own computer)

Uses your local prediction-go and images built from your checkouts, so nothing needs
publishing.

**1. Platform.** Put these in `prediction-go/.env`:

```sh
PUBLIC_DPM_API_URL=http://localhost:8086
PUBLIC_GAMMA_API_URL=http://localhost:8084
PUBLIC_RELAYER_API_URL=http://localhost:8085
```

Then start it, with the branches that carry the changes checked out:

```sh
cd prediction-go
docker compose -f docker-compose.dev.yml up -d postgres nats redis temporal temporal-ui
make devtool                      # in its own terminal
.bin/devtool start-all            # from another terminal
.bin/devtool rebuild dpm-api
.bin/devtool rebuild gamma-api
```

**2. A test builder and its key**, created through dpm-api's admin API:

```sh
ADMIN=$(grep '^DPM_API_KEY=' .env | cut -d= -f2)
curl -s -XPOST localhost:8086/builders -H "X-API-Key: $ADMIN" \
  -H 'Content-Type: application/json' -d '{"name":"Install Test 1","builder_type":"custody"}'
# → {"id": <ID>, ...}
curl -s -XPOST localhost:8086/builders/<ID>/api-private-key -H "X-API-Key: $ADMIN"
# → {"api_private_key": "bld_sk_..."}
```

Run the pre-flight check against `http://localhost:8086`.

**3. Images**, built from your checkouts and tagged `local`:

```sh
cd ..   # the folder holding the repos
docker build -t ghcr.io/in-a-bit/dpm-wallet:local dpm-wallet
docker build -t ghcr.io/in-a-bit/dpm-wallet-manager:local dpm-wallet-manager
```

**4. Install** from your checkout rather than a GitHub release. Pick free ports: the demo stack
already uses 3000.

```sh
mkdir -p /tmp/dpm-src
cp dpm-wallet-manager/deploy/compose.yml dpm-wallet-manager/deploy/dpm-custody /tmp/dpm-src/
printf 'DPM_WALLET_TAG=local\nDPM_WALLET_MANAGER_TAG=local\n' > /tmp/dpm-src/versions.env

DPM_CUSTODY_DIR=~/dpm-custody-local DPM_CUSTODY_SOURCE=/tmp/dpm-src \
DPM_CUSTODY_MANAGER_PORT=3300 sh dpm-wallet-manager/deploy/install.sh
```

**5. Setup page** (`http://localhost:8480`, PIN from the installer):

1. Click **Show more options**, choose **Custom**, and enter `http://localhost:8086`. Setup
   reaches your computer's ports through the Docker host by itself.
2. Paste the key, click **Check key**, choose a mode, then click **Start setup**.

**6. Verify:**

```sh
~/dpm-custody-local/dpm-custody status
curl -s localhost:3300/v1/platform -H 'X-API-Key: <admin key from the backup kit>'
cd dpm-wallet-manager && BASE_URL=http://localhost:3300 ADMIN_KEY=<admin key> ./scripts/smoke.sh
```

`smoke.sh` creates a wallet, signs an order and checks the routing and money rules, all against
the real platform.

**7. Clean up** before the next run, then use a new builder. Only one install can run at a time:
they share the Docker project name `dpm-custody`.

```sh
cd ~/dpm-custody-local && docker compose --env-file .env -f compose.yml down -v
rm -rf ~/dpm-custody-local
```

## Dev (`inabit.dev`)

**1. Platform.** In prediction-env, `dev/prediction.env` for dpm-api:

```sh
PUBLIC_DPM_API_URL=https://dpm-api.inabit.dev
PUBLIC_GAMMA_API_URL=https://gamma-api.inabit.dev
PUBLIC_RELAYER_API_URL=https://relayer-api.inabit.dev
```

Then deploy prediction-go (gamma-api first, then dpm-api) with **Manage ENV Deployments**,
environment `dev`.

**2. Key.** In the dev backoffice, go to **Custody builders**, create a builder and issue its
private key. Run the pre-flight check against `https://dpm-api.inabit.dev`.

**3. Images.** Merging to `dev` in each repo publishes the `:dev` tag. Install with those, from a
checkout of this repo's `dev` branch:

```sh
mkdir -p /tmp/dpm-src
cp dpm-wallet-manager/deploy/compose.yml dpm-wallet-manager/deploy/dpm-custody /tmp/dpm-src/
printf 'DPM_WALLET_TAG=dev\nDPM_WALLET_MANAGER_TAG=dev\n' > /tmp/dpm-src/versions.env
DPM_CUSTODY_DIR=~/dpm-custody-dev DPM_CUSTODY_SOURCE=/tmp/dpm-src sh dpm-wallet-manager/deploy/install.sh
```

**4. Setup page.** Click **Show more options**, choose **Development**, paste the key, choose a
mode, then click **Start setup**.

**5. Verify and clean up** as in Local (steps 6–7), using port 3000 and `~/dpm-custody-dev`.

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

On the setup page, keep **Production** (it's preselected), paste the key, choose a mode, then
click **Start setup**.

**5. Verify** as in Local step 6, on port 3000. This is real production: use small amounts, and
revoke the test builder's key in the backoffice when done.
