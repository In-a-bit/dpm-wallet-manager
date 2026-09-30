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

This uses your local prediction-go platform and images built from your own checkouts, so
nothing needs to be published first.

### Before you start

1. **The three repos sit side by side** in one folder: `prediction-go`, `dpm-wallet` and
   `dpm-wallet-manager`. Each must be on its branch:

   | Repo               | Branch                        |
   | ------------------ | ----------------------------- |
   | prediction-go      | `feat/wallet-install-config`  |
   | dpm-wallet         | `feat/gamma-builder-key-only` |
   | dpm-wallet-manager | `feat/one-step-install`       |

2. **`prediction-go/.env` contains these three lines:**

   ```sh
   PUBLIC_DPM_API_URL=http://localhost:8086
   PUBLIC_GAMMA_API_URL=http://localhost:8084
   PUBLIC_RELAYER_API_URL=http://localhost:8085
   ```

3. **The platform is running and rebuilt from that branch.** Run `make devtool` in its own
   terminal, then in another:

   ```sh
   cd ~/Documents/prediction-claude/prediction-go
   docker compose -f docker-compose.dev.yml up -d postgres nats redis temporal temporal-ui
   .bin/devtool start-all
   .bin/devtool rebuild dpm-api
   .bin/devtool rebuild gamma-api
   ```

4. **A new custody builder and its private key, from the backoffice**, the way a real builder
   gets theirs.
   1. Start the backoffice UI:

      ```sh
      cd ~/Documents/prediction-claude/prediction-backoffice && npm run dev
      ```

      Open the address it prints. It is `http://localhost:3001` when 3000 is taken, as it is
      while the demo stack runs. The devtool's `backoffice` service must be running too.

   2. Go to **Custody Builders** and, under **Onboard custody builder**, type a name and click
      **Create custody builder**.
   3. In the list, click **New key** on that builder's row, confirm, and click **Copy**.

   Use a builder that has **never been installed**. Each install creates the builder's Turnkey
   sub-organization, so a second install of the same builder stops at "Create the secure key
   vault" with a 409.

### The quick way: one script

```sh
~/Documents/prediction-claude/dpm-wallet-manager/deploy/try-local.sh
```

It asks you to paste the key from step 4. You can also pass it on the command line:
`try-local.sh bld_sk_…`. The script runs from any folder. It checks everything above and stops
with the exact fix if something is wrong. Then it:

1. Checks your key against dpm-api and gamma-api. It shows your builder's name, or says why the
   key was refused.
2. Builds both images.
3. Installs into `~/dpm-custody-local`.

It ends by printing the page address, the PIN, and your key and builder name, so you know what
to paste and what to expect. Follow those five lines, then:

```sh
~/Documents/prediction-claude/dpm-wallet-manager/deploy/try-local.sh verify   # status + smoke test
~/Documents/prediction-claude/dpm-wallet-manager/deploy/try-local.sh clean    # start over
```

Each new run needs a new builder and key from the backoffice (step 4).

### The same, by hand

Copy each block as-is. Values are captured into variables, so there is nothing to fill in.
Run every block in the **same terminal**, because later blocks use earlier variables.

**1. Point at the workspace.**

```sh
W=~/Documents/prediction-claude
```

**2. Check that dpm-api has the new endpoint.**

```sh
curl -s -w '  HTTP %{http_code}\n' localhost:8086/wallet-install/config
```

- **Expect:** `{"error":"unauthorized"}  HTTP 401`. That is right: no key was sent.
- **`HTTP 404`:** dpm-api is an older build. Run `.bin/devtool rebuild dpm-api` in
  prediction-go.
- **`HTTP 000`:** dpm-api isn't running.

**3. Paste your builder private key** (from Before you start, step 4) when asked:

```sh
read -rp "Builder private key: " BUILDER_KEY
```

**4. Pre-flight: the platform answers for that key.**

```sh
curl -s -w '\nHTTP %{http_code}\n' localhost:8086/wallet-install/config \
  -H "X-Builder-Api-Private-Key: $BUILDER_KEY"
curl -s -o /dev/null -w 'gamma-api gate: HTTP %{http_code}\n' "localhost:8084/events?limit=1" \
  -H "X-Builder-Api-Private-Key: $BUILDER_KEY"
```

- **First command:** JSON with your builder's name, `chain_id`, `contracts` and `services`,
  ending `HTTP 200`.
  - `HTTP 401`: the key is wrong or revoked. Copy it again from the backoffice.
  - `HTTP 409`: you created an embedded builder. Use **Custody Builders** instead.
  - `HTTP 503`: dpm-api has no `PUBLIC_*` URLs. Run `.bin/devtool restart dpm-api`.
- **Second command:** `gamma-api gate: HTTP 200`. `HTTP 401` means gamma-api is an older build;
  run `.bin/devtool rebuild gamma-api`.

**5. Build both images from your checkouts.**

```sh
docker build -t ghcr.io/in-a-bit/dpm-wallet:local "$W/dpm-wallet"
docker build -t ghcr.io/in-a-bit/dpm-wallet-manager:local "$W/dpm-wallet-manager"
```

**6. Install.** Port 3300 is used because the demo stack already has 3000.

```sh
SRC=$(mktemp -d)
cp "$W/dpm-wallet-manager/deploy/compose.yml" "$W/dpm-wallet-manager/deploy/dpm-custody" "$SRC/"
printf 'DPM_WALLET_TAG=local\nDPM_WALLET_MANAGER_TAG=local\n' > "$SRC/versions.env"
DPM_CUSTODY_DIR=~/dpm-custody-local DPM_CUSTODY_SOURCE="$SRC" DPM_CUSTODY_MANAGER_PORT=3300 \
  sh "$W/dpm-wallet-manager/deploy/install.sh"
```

It ends with `✓ Ready`, the address `http://localhost:8480` and a PIN.

**7. Finish in the browser** at <http://localhost:8480>:

1. Enter the PIN.
2. Click **Show more options**, choose **Custom**, and type `http://localhost:8086`.
3. Paste your key and click **Check key**. It should say "Connecting as" followed by the name
   you gave the builder.
4. Pick a mode, tick the box, and click **Start setup**. Wait until every step has a ✓.
5. Download the backup kit, tick "I saved it", and click **Continue**. The status page shows
   everything green.

**8. Verify.**

```sh
~/dpm-custody-local/dpm-custody status
ADMIN_KEY=$(~/dpm-custody-local/dpm-custody backup-kit | sed -n 's/^Admin API key: *//p')
curl -s localhost:3300/v1/platform -H "X-API-Key: $ADMIN_KEY" | python3 -m json.tool
BASE_URL=http://localhost:3300 ADMIN_KEY=$ADMIN_KEY "$W/dpm-wallet-manager/scripts/smoke.sh"
```

- **`status`:** all four services running.
- **`/v1/platform`:** your mode, a master wallet, and `upstream.vault.initialized: true`.
- **`smoke.sh`:** ends with every line ✓.

**9. Start over.** Only one install can run at a time, because they share the Docker project
name `dpm-custody`. The next run needs a new builder and key from the backoffice.

```sh
(cd ~/dpm-custody-local && docker compose --env-file .env -f compose.yml down -v)
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

**5. Verify and clean up** as in Local "by hand" (steps 8–9), using port 3000 and
`~/dpm-custody-dev`.

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

**5. Verify** as in Local "by hand" step 8, on port 3000. This is real production: use small amounts, and
revoke the test builder's key in the backoffice when done.
