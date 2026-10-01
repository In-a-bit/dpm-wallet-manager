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
5. **Create your login** for the admin dashboard: a username and a password of at least 12
   characters.
6. **Download the backup kit** and store it somewhere safe and private, such as a password
   manager. If you lose this computer, the backup kit is the only way to recover.

The last page shows:

- the **wallet manager address** and the **backend key**. Give these two to whoever runs your
  backend.
- the **admin dashboard** address (`…/admin`). Sign in there with the login you just created to
  see your wallets, manage API keys, read the audit log, and add more people.

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

The steps above are what a builder does. This part is for the platform team: what a platform
needs before builders can install against it, how to try the install yourself (local or dev),
and how to release it for production. The setup page offers Production, Development and
Custom (any dpm-api address); add an environment in `src/setup/environments.ts`.

## What every environment needs first

The installer works only when the platform it points at has all four of these. The pre-flight
check below tells you which one is missing; `deploy/try-install.sh` runs it for you.

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

`--platform` defaults to `http://localhost:8086`, and `--images` to `main`. The script asks for
the builder key, or you can pass it as the last argument. It then:

1. **Checks** Docker, the platform and your key, and names your builder. If something is wrong,
   it stops and says exactly what.
2. **Prepares the images:** it pulls or builds them.
3. **Installs** into `~/dpm-custody-try` (`--dir` to change). It uses ports 8480 and 3000, or the
   next free ones if those are taken.
4. **Prints** the page address, the PIN, the platform address to type, and the builder name to
   expect.

Finish on the page as it says, then:

```sh
./deploy/try-install.sh verify   # services, platform status, and scripts/smoke.sh
./deploy/try-install.sh clean    # remove the install to start over (then use a new builder)
```

If you used `--dir`, pass the same `--dir` to both.

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

  `localhost` is fine: the setup page rewrites it so its containers can reach your computer.
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
`HTTP 200`. Any other code is explained in the pre-flight table above. Then check gamma-api at
the address the platform just reported:

```sh
GAMMA=$(curl -s "$PLATFORM/wallet-install/config" -H "X-Builder-Api-Private-Key: $BUILDER_KEY" |
  python3 -c 'import json,sys; print(json.load(sys.stdin)["services"]["gamma_api"])')
curl -s -o /dev/null -w 'gamma-api gate: HTTP %{http_code}\n' "$GAMMA/events?limit=1" \
  -H "X-Builder-Api-Private-Key: $BUILDER_KEY"
```

This should print `HTTP 200`. `HTTP 401` means gamma-api predates accepting builder keys.

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

**5. Install.** If 8480 or 3000 is taken on your machine, change the two port variables.

```sh
SRC=$(mktemp -d)
cp deploy/compose.yml deploy/dpm-custody "$SRC/"
printf 'DPM_WALLET_TAG=%s\nDPM_WALLET_MANAGER_TAG=%s\n' "$TAG" "$TAG" > "$SRC/versions.env"
DPM_CUSTODY_DIR=~/dpm-custody-try DPM_CUSTODY_SOURCE="$SRC" \
  DPM_CUSTODY_SETUP_PORT=8480 DPM_CUSTODY_MANAGER_PORT=3000 sh deploy/install.sh
```

It ends with `✓ Ready`, the setup page address and a PIN.

**6. The setup page.**

1. Enter the PIN.
2. Click **Show more options**, choose **Custom**, and type the same address as `PLATFORM`.
3. Paste your key and click **Check key**. It should say "Connecting as" followed by your
   builder's name.
4. Pick a mode, tick the box, and click **Start setup**. Wait until every step has a ✓.
5. Download the backup kit, tick "I saved it", and click **Continue**.

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

On the setup page, keep **Production** (it's preselected), paste the key, choose a mode, then
click **Start setup**.

**5. Verify.** From your dpm-wallet-manager checkout, run
`./deploy/try-install.sh verify --dir ~/dpm-custody`. This is real production: use small
amounts, and revoke the test builder's key in the backoffice when done.
