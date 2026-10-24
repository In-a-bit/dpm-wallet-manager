# DPM custody service: install, run, upgrade

This folder holds everything a builder installs: the installers (`install.sh` for Mac and Linux,
`install.ps1` for Windows), `compose.yml`, `versions.env` and the `dpm-custody` command.

**Part 1** is for builders: install, check, use, upgrade. You don't need to be technical.
**Part 2** is for the platform team: preparing a platform, trying the install locally (one install
or two side by side), on dev and on production, and testing these scripts.

- [Part 1: For builders](#part-1-for-builders)
  - [Before you start](#before-you-start)
  - [Step 1: Run the installer](#step-1-run-the-installer)
  - [Installer options](#installer-options)
  - [Step 2: Follow the setup dashboard](#step-2-follow-the-setup-dashboard)
  - [Step 3: Check it works](#step-3-check-it-works)
  - [Everyday use](#everyday-use)
  - [Settings in .env](#settings-in-env)
  - [Two installs on one machine](#two-installs-on-one-machine)
  - [Upgrading](#upgrading)
  - [Rolling back](#rolling-back)
  - [Restoring a backup](#restoring-a-backup)
  - [Removing an install](#removing-an-install)
  - [If something goes wrong](#if-something-goes-wrong)
  - [For administrators](#for-administrators)
- [Part 2: For the platform team](#part-2-for-the-platform-team)
  - [What every environment needs first](#what-every-environment-needs-first)
  - [Local environment](#local-environment)
  - [Dev](#dev)
  - [Production (dpm.network)](#production-dpmnetwork)
  - [Testing the deploy scripts](#testing-the-deploy-scripts)

---

# Part 1: For builders

Plan for about 15 minutes, most of it waiting for downloads.

## Before you start

You need two things:

1. **Your builder private key.** The platform team gives it to you. It's a long line of text
   that starts with `bld_sk_`. Keep it private, like a password.
2. **Docker.** This is the free program the service runs in.
   - **Windows or Mac:** install [Docker Desktop](https://www.docker.com/products/docker-desktop/)
     and open it once. Wait until it says it's running.
   - **Linux server:** install [Docker Engine](https://docs.docker.com/engine/install/).

The wallet manager uses port **3000** on this machine. If another program already uses it, the
installer stops before changing anything and tells you a free port to use instead (see
[Installer options](#installer-options)).

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

It puts the files in the `dpm-custody` folder in your home folder, downloads and starts the
service, then opens the **setup dashboard** in the same window.

Running the installer again is always safe. On an existing install it only refreshes the
`dpm-custody` command (checked against the release's signed `SHA256SUMS`) and starts the service. It
never changes `compose.yml`, `versions.env` or `.env`, so the name and port options below
apply only to a new install.

## Installer options

Every option is an environment variable. Both installers accept the same ones, and none is
needed for a normal install.

| Variable                   | Default            | What it does                                                                                             |
| -------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------- |
| `DPM_CUSTODY_MANAGER_PORT` | `3000`             | The wallet manager's port. A taken port stops the install before anything is written, naming a free one. |
| `DPM_CUSTODY_DIR`          | `~/dpm-custody`    | Where the install goes.                                                                                  |
| `DPM_CUSTODY_NAME`         | `dpm-custody`      | The install's name. Its containers, volumes and network all start with it. Needed for two installs.      |
| `DPM_CUSTODY_RELEASE`      | `latest`           | Install this release instead, e.g. `v1.2.3`.                                                             |
| `SETUP_PLATFORM_URL`       | (asked)            | Answers setup's first question, the platform address. Still checked.                                     |
| `SETUP_BUILDER_KEY`        | (asked)            | Answers setup's second question, your builder key. Still checked. Prefer pasting it when asked.          |
| `DPM_CUSTODY_NO_START`     | (unset)            | `1` writes the files and `.env`, then stops before starting anything.                                    |
| `DPM_CUSTODY_RELEASES_URL` | the GitHub release | Download the installer files from here instead. Must be `https://` unless the next option is set. Testing. |
| `DPM_CUSTODY_SOURCE`       | (unset)            | Copy the installer files from this local folder instead of downloading them. For testing.                |
| `DPM_CUSTODY_ALLOW_INSECURE` | (unset)          | `1` allows `file://` and `http://` release URLs. Local rehearsals only; never on a real install.         |
| `DPM_CUSTODY_RELEASE_PUBKEY` | the embedded key | A PEM public key to check the release signature against instead. Local rehearsals only.                 |

The name may use lowercase letters, digits, `-` and `_`, and must start with a letter or digit.
A name another install on this machine already uses, running or stopped, is refused.

**Mac or Linux:** put the variables just before `sh`:

```sh
# another port
curl -fsSL https://github.com/In-a-bit/dpm-wallet-manager/releases/latest/download/install.sh \
  | DPM_CUSTODY_MANAGER_PORT=3001 sh

# a given release, in another folder
curl -fsSL https://github.com/In-a-bit/dpm-wallet-manager/releases/latest/download/install.sh \
  | DPM_CUSTODY_RELEASE=v1.2.3 DPM_CUSTODY_DIR=/opt/dpm-custody sh
```

**Windows (PowerShell):** set them first, in the same window:

```powershell
$env:DPM_CUSTODY_MANAGER_PORT = "3001"
irm https://github.com/In-a-bit/dpm-wallet-manager/releases/latest/download/install.ps1 | iex
```

A variable set with `$env:` stays set until you close that window. Remove one with
`Remove-Item Env:DPM_CUSTODY_MANAGER_PORT`.

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
background. To see it again, run `~/dpm-custody/dpm-custody setup` (Windows: see
[Everyday use](#everyday-use)).

### If setup stops

The dashboard says which step stopped, why, and what to try. Fix that, then press **r** to try
again. Finished steps aren't repeated.

If it keeps stopping, run `~/dpm-custody/dpm-custody support`. It writes one file with
everything support needs: the checklist, what each step did and when, the state of each service,
and their recent logs. Keys in it are masked, so it's safe to email. Send that file to the
platform team, with the **reference** shown on the dashboard.

## Step 3: Check it works

Replace `3000` with your port if you changed it.

```sh
~/dpm-custody/dpm-custody status                  # every service "Up", the manager and dpm-wallet "(healthy)"
curl -s http://localhost:3000/v1/health/ready     # {"status":"ok"}
```

Then open `http://localhost:3000/admin` in a browser and sign in. The overview shows the master
and operations wallets.

The `setup` service stays running after setup is done. That is on purpose: the `dpm-custody`
commands (`setup`, `backup`, `support`, `backup-kit`) run inside it, and it would finish an
interrupted setup after a restart. It uses about 20 MB of memory.

## Everyday use

Everything lives in the install folder (`~/dpm-custody` unless you chose another).

**Mac and Linux**

| To…                          | Run                                        |
| ---------------------------- | ------------------------------------------ |
| start it (e.g. after reboot) | `~/dpm-custody/dpm-custody start`          |
| stop it (nothing is deleted) | `~/dpm-custody/dpm-custody stop`           |
| see what's running           | `~/dpm-custody/dpm-custody status`         |
| read recent logs             | `~/dpm-custody/dpm-custody logs [service]` |
| make a backup                | `~/dpm-custody/dpm-custody backup`         |
| print the backup kit again   | `~/dpm-custody/dpm-custody backup-kit`     |
| create the backup recovery key (older installs) | `~/dpm-custody/dpm-custody backup-key` |
| decrypt one sealed backup file | `~/dpm-custody/dpm-custody backup-open FILE.sealed` |
| empty the old config volume  | `~/dpm-custody/dpm-custody cleanup-legacy` |
| update to the newest version | `~/dpm-custody/dpm-custody upgrade`        |
| undo the last update         | `~/dpm-custody/dpm-custody rollback`       |
| get help from support        | `~/dpm-custody/dpm-custody support`        |
| see setup again              | `~/dpm-custody/dpm-custody setup`          |

The services are `postgres`, `dpm-wallet`, `dpm-wallet-manager` and `setup`.

**Windows.** `dpm-custody` is a bash script. The installer puts it in the install folder; run it
from **Git Bash** or **WSL**, e.g. `bash ~/dpm-custody/dpm-custody status`. Without bash, open
PowerShell in the install folder and use Docker Compose directly:

```powershell
cd $HOME\dpm-custody
docker compose --env-file .env -f compose.yml up -d        # start
docker compose --env-file .env -f compose.yml stop         # stop
docker compose --env-file .env -f compose.yml ps           # status
docker compose --env-file .env -f compose.yml logs --tail 200 dpm-wallet-manager
docker compose --env-file .env -f compose.yml exec setup node dist/setup/main setup   # setup again
docker compose --env-file .env -f compose.yml exec setup node dist/setup/main kit     # backup kit
```

`backup`, `backup-key`, `backup-open`, `upgrade`, `rollback`, `cleanup-legacy` and `support` exist only in `dpm-custody`, so on Windows they
need Git Bash or WSL. They have not been tested on Windows yet; tell the platform team if one
fails there.

**Back up regularly.** A backup lands in the `backups` folder. Copy it somewhere off this
machine. It contains secrets, so keep it private.

**Backups are encrypted.** Setup makes a *backup recovery key* and shows it once, in the backup kit
(save it with the other secrets; it is not stored on this computer). Each backup file is encrypted
to that key as it is written (`databases.sql.sealed`, `config.tar.gz.sealed`, ...), so someone who
steals the `backups` folder, or this machine, cannot read them, and neither can you without the
key. If the key is lost, the backups cannot be opened. An install made before this existed has no
key, and its backups are plaintext with a warning: run `dpm-custody backup-key` once to create one
(it shows the key once; the public half goes into `.env` as `DPM_BACKUP_RECIPIENT`). `backup-key
--rotate` replaces it; backups made earlier still need the key they were encrypted with.
`dpm-custody backup` keeps the newest 5 backups and removes older ones after a good backup;
set `DPM_CUSTODY_KEEP_BACKUPS=10` (in the shell that runs it) to keep more. A backup that failed
is kept as `...-incomplete` and never counts. An upgrade that an older `dpm-custody` (v0.2.2)
performs takes a plaintext backup: run the installer once first (Step 1) to get the current one.

## Settings in .env

The installer writes `.env` in the install folder. Edit it with any text editor, then run
`dpm-custody start` (or `docker compose --env-file .env -f compose.yml up -d`) to apply it: only
the services whose settings changed restart.

| Setting                       | Default                 | What it does                                                                           |
| ----------------------------- | ----------------------- | -------------------------------------------------------------------------------------- |
| `MANAGER_PORT`                | `3000`                  | The wallet manager's port on this machine. Change `MANAGER_PUBLIC_URL` with it.        |
| `MANAGER_PUBLIC_URL`          | `http://localhost:3000` | Where your backend and browser reach the manager. Shown by setup; used in alert links. |
| `MANAGER_BIND`                | `127.0.0.1`             | `0.0.0.0` lets other machines reach the manager. Put TLS in front of it first.         |
| `OPERATIONS_RETENTION_DAYS`   | `90`                    | See [Retention](#retention).                                                           |
| `ROUTED_ORDER_RETENTION_DAYS` | `365`                   | See [Retention](#retention).                                                           |
| `RETENTION_ENABLED`           | `true`                  | See [Retention](#retention).                                                           |
| `DPM_IMAGE_REGISTRY`          | `ghcr.io/in-a-bit`      | Where the images come from. Only for testing.                                          |
| `DPM_BACKUP_RECIPIENT`        | (set by `backup-key`)   | Public key backups are encrypted to. Not secret; the private half is never stored.     |

Leave `COMPOSE_PROJECT_NAME`, `POSTGRES_*`, `DPM_WALLET_TAG`, `DPM_WALLET_MANAGER_TAG` and
`DPM_CUSTODY_VERSION` alone: the installer and `upgrade` own them.

## Two installs on one machine

Two installs can run side by side, for example one **segregated** and one **shared**. Each needs
its own **name**, **folder**, **port** and **builder key** (a key can be installed only once).

**Mac or Linux**

```sh
URL=https://github.com/In-a-bit/dpm-wallet-manager/releases/latest/download/install.sh

curl -fsSL $URL | DPM_CUSTODY_NAME=dpm-custody-segregated DPM_CUSTODY_DIR=~/dpm-custody-segregated \
  DPM_CUSTODY_MANAGER_PORT=3000 sh
#   setup asks for the mode: choose Segregated

curl -fsSL $URL | DPM_CUSTODY_NAME=dpm-custody-shared DPM_CUSTODY_DIR=~/dpm-custody-shared \
  DPM_CUSTODY_MANAGER_PORT=3001 sh
#   setup asks for the mode: choose Shared
```

**Windows (PowerShell)**

```powershell
$env:DPM_CUSTODY_NAME = "dpm-custody-segregated"; $env:DPM_CUSTODY_DIR = "$HOME\dpm-custody-segregated"; $env:DPM_CUSTODY_MANAGER_PORT = "3000"
irm https://github.com/In-a-bit/dpm-wallet-manager/releases/latest/download/install.ps1 | iex

$env:DPM_CUSTODY_NAME = "dpm-custody-shared"; $env:DPM_CUSTODY_DIR = "$HOME\dpm-custody-shared"; $env:DPM_CUSTODY_MANAGER_PORT = "3001"
irm https://github.com/In-a-bit/dpm-wallet-manager/releases/latest/download/install.ps1 | iex
```

How they stay apart:

- **Containers, volumes and network** start with the name, which the installer writes into the
  install's `.env` as `COMPOSE_PROJECT_NAME`. The two never share anything.
- **Ports:** the manager's port is the only one an install publishes. A port another install
  already has, even a stopped one, is refused.
- **Commands** work on the install whose folder they're in, so use each install's own command:

```sh
~/dpm-custody-segregated/dpm-custody status
~/dpm-custody-shared/dpm-custody status
~/dpm-custody-shared/dpm-custody upgrade
curl -s http://localhost:3000/v1/health/ready     # segregated
curl -s http://localhost:3001/v1/health/ready     # shared
```

Upgrade, roll back and back up each install on its own.

## Upgrading

```sh
~/dpm-custody/dpm-custody upgrade            # the newest release
~/dpm-custody/dpm-custody upgrade 1.4.0      # a given release
~/dpm-custody/dpm-custody upgrade --yes      # without the question (for scripts)
DPM_CUSTODY_HEALTH_TIMEOUT=1800 ~/dpm-custody/dpm-custody upgrade   # wait up to 30 min (see below)
```

On a remote machine, run it inside `tmux` or `screen`, so you can reconnect and watch it if the
connection drops. Once you have confirmed, it keeps running even if the terminal or SSH session
closes, rollback included. Every message, plus Docker's output, goes to `upgrade.log` in the
install folder. Read that file to see how it ended.

It runs these steps in order. Until the switch, nothing in the install changes, and any problem
stops the upgrade with the install running as before:

1. Downloads the release's `compose.yml`, `versions.env` and `dpm-custody` into `upgrade.tmp/`,
   checks the signature on its `SHA256SUMS` (`SHA256SUMS.sig`) with the public key embedded in
   the dpm-custody you are running, then checks the files against `SHA256SUMS`. A release without
   `SHA256SUMS` or its signature, a bad signature or a file that does not match stops the
   upgrade. Downloads must be `https://` (TLS 1.2 or newer).
2. Checks that the release is newer than the installed version (`DPM_CUSTODY_VERSION` in `.env`)
   and that the install is not below the release's `MIN_UPGRADE_FROM`. If it is, the message
   names the version to upgrade to first. It also checks that every service is healthy now, and
   that free disk is at least twice the size of the databases plus 1 GB.
3. Shows the installed and new versions and the release notes, and asks. Without a terminal it
   needs `--yes`.
4. Takes a backup (`dpm-custody backup`). A failed backup stops the upgrade. (Its
   `config.tar.gz` holds the three configuration volumes; on an install from before the volume
   split, the single old `config` volume.)
5. Downloads the new images while the old ones keep running.
6. Keeps the current `compose.yml`, `versions.env`, `.env` and `dpm-custody` as `*.prev`
   (readable only by you).
7. Switches: puts the new files in place, sets the new image tags and `DPM_CUSTODY_VERSION` in
   `.env`, stops the old setup worker, prepares the configuration volumes (`setup migrate`, safe to
   repeat; it copies an older install's single `config` volume into the new ones and keeps the
   old one), and restarts. Database changes run as each service starts.
8. Waits up to 5 minutes (see below) for every service to be healthy. If they are, it removes
   this install's older images (other than the new and previous ones) and is done. If not, it
   rolls back by itself (below) and tells you where the backup is.

**An upgrade that did not finish:** a file `upgrade.inprogress` marks an upgrade that switched
files but did not finish, for example because the machine restarted during it. While it is there,
`upgrade` refuses and `status` says so. Run `dpm-custody rollback` to return to the previous
version (that removes the file), then check `upgrade.log`. Only one upgrade or rollback runs at a
time. If one is refused because `upgrade.lock` exists although none is running, delete that
folder.

**A slow start after an upgrade:** on a large database, the first start of a new version can take
longer while it builds new indexes. To wait longer than 5 minutes before rolling back, set
`DPM_CUSTODY_HEALTH_TIMEOUT` (seconds, default 300) for that run, as in the last example above.
Raise it when the release notes mention a database change and your tables hold millions of rows.

**Installs from before this release:** run the installer again once (Step 1, with the same
`DPM_CUSTODY_DIR` if you used one) before `dpm-custody upgrade`. On an existing install it only
replaces the `dpm-custody` script and keeps your data and settings. The older `dpm-custody`
either has no `upgrade` at all, or has one that takes no backup and does not wait for the
services to be healthy (so it never rolls back by itself). If the installer cannot fetch the new
script, it says so and keeps the old one. Then run `dpm-custody upgrade`. On an install whose
`.env` has no `DPM_CUSTODY_VERSION` it says "installed version unknown", skips the version checks
this once, and records the new version.

## Rolling back

```sh
~/dpm-custody/dpm-custody rollback
```

This undoes the last upgrade. It puts back `compose.yml` and `dpm-custody` from the `*.prev`
files. In `.env` it resets only the image tags and `DPM_CUSTODY_VERSION`, so any other change you
made to `.env` since the upgrade stays. Then it restarts and waits for every service to be healthy,
like an upgrade does. Without `*.prev` files there is nothing to undo, and it says so.

An upgrade that failed and rolled back by itself keeps the `*.prev` files of the upgrade before
it, so `rollback` still undoes that earlier upgrade.

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
# Encrypted backup (files end in .sealed): backup-open asks for the backup recovery key, hidden as
# you type, or reads it from the file named by DPM_BACKUP_RECOVERY_KEY_FILE. It works while the
# stack is stopped.
./dpm-custody backup-open "$B/databases.sql.sealed" | docker compose --env-file .env -f compose.yml exec -T postgres \
  psql -U "$DB_USER" -d postgres
# A plaintext backup (older installs, no recovery key) is restored from the file directly:
#   ... exec -T postgres psql -U "$DB_USER" -d postgres <"$B/databases.sql"
./dpm-custody start
```

`./dpm-custody backup-open "$B/config.tar.gz.sealed" >config.tar.gz` opens the other files the same
way (do not leave the decrypted copies lying around).

The restore prints `role "dpm" already exists`. That is expected. The backup also holds the
configuration (`config.tar.gz`) and the wallet data directory (`wallet-data.tar.gz`, which holds
no plaintext key). The wallet keys themselves live encrypted in the database, so they come back
with `databases.sql` and `DPM_WALLET_ENCRYPTION_KEY` from the configuration. An upgrade or a
rollback never changes them, so you do not restore them here. If they are lost, for example on a
new machine, ask the platform team.

## Removing an install

**This deletes the wallet keys and both databases.** Without a backup of the databases and the
configuration (it holds the encryption key), the funds
in the install's wallets can no longer be moved. Take a backup and copy it off the machine first.

```sh
cd ~/dpm-custody
./dpm-custody backup                                      # then copy backups/ somewhere safe
docker compose --env-file .env -f compose.yml down -v     # containers, network and volumes
cd .. && rm -rf ~/dpm-custody
```

A builder key can be installed only once, so a new install needs a new key from the platform
team.

## If something goes wrong

- **"Docker is not running":** open Docker Desktop, wait a minute, and run the installer again.
- **"Port 3000 is already in use":** another program, or another install, has that port. Nothing
  was installed. Run the installer again with the free port it names, e.g.
  `DPM_CUSTODY_MANAGER_PORT=3001` (see [Installer options](#installer-options)). To move an
  existing install to another port, see [Settings in .env](#settings-in-env).
- **"Another install on this machine is already named …":** pick another `DPM_CUSTODY_NAME`, or
  use that install's folder.
- **"This key was not accepted":** copy the whole key again, and check you chose the right
  platform.
- **Setup stopped with an error:** fix what the dashboard says, then press **r**. Finished steps
  are kept.

For anything else, run `dpm-custody support` and send the file it writes to the platform team.

## For administrators

- **Services:** Postgres, dpm-wallet, dpm-wallet-manager and a setup service. All come from the
  public images `ghcr.io/in-a-bit/dpm-wallet` and `ghcr.io/in-a-bit/dpm-wallet-manager`. See
  `compose.yml`.
- **Network exposure:** only the manager API is published, on `127.0.0.1:$MANAGER_PORT`. Setup
  has no port: it runs in a terminal, inside its container. To reach the manager from another
  host, set `MANAGER_BIND=0.0.0.0` in `.env` and put TLS in front of it. dpm-wallet and Postgres
  are reachable only inside the stack.
- **Configuration:** setup writes each service's configuration into that service's own volume:
  `config-wallet` (mounted by dpm-wallet and setup) and `config-manager` (the manager and
  setup), each file readable by its owner only. Setup keeps its own state in `setup-state`,
  mounted by setup alone, plus `setup-journal.jsonl`, a masked log of every step, which the
  support report includes. So the manager cannot read dpm-wallet's configuration, and neither
  service can read setup's state. Older versions used one `config` volume. Setup copies it across
  whenever it starts (an upgrade also does it up front), and keeps it so a rollback still works;
  `dpm-custody cleanup-legacy` empties it. A version from before the split uses that old volume,
  which can be out of date after a rollback; upgrading again copies any change across. Setup
  gets the platform values from dpm-api
  `GET /wallet-install/config`, authenticated with the builder key, and generates every other
  secret itself.
- **Database accounts:** the Postgres superuser (from `.env`) is used only by Postgres and setup.
  Setup gives dpm-wallet and the manager an account each (`wallet_app`, `manager_app`: no
  superuser, cannot create databases or roles), each owning only its own database, with its own
  random password in that service's env file. An upgrade from a version that used the superuser
  converts the install the first time setup starts: it creates the accounts, hands over the
  databases and rewrites the env files. Rolling back to such a version uses the old `config`
  volume, which still holds the superuser URL (the superuser can use the converted databases);
  `dpm-custody cleanup-legacy` removes it.
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
    sh -c 'echo "DATA_API_URL=https://<the platform data-api address>" >> /config-wallet/dpm-wallet.env'
  docker compose --env-file .env -f compose.yml restart dpm-wallet
  ```

  The platform team can tell you the address; it is the `data_api` service that
  `GET /wallet-install/config` reports.

### Logs

Every service keeps at most five container log files of 20 MB each (100 MB per service), then
discards the oldest. Read them with `dpm-custody logs <service>` or
`docker compose --env-file .env -f compose.yml logs <service>`.

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

A bad value stops the manager from starting, and the log says which one. If you set only
`OPERATIONS_RETENTION_DAYS` above 365, routed orders follow it (they are never kept for less time
than other operations); setting `ROUTED_ORDER_RETENTION_DAYS` below it is a bad value.

The manager also trims dpm-wallet's routine audit records (successful signing and meta
transactions), with the same routine setting. dpm-wallet never trims them by itself, so a
dpm-wallet without a manager keeps them for ever.

**One manager per dpm-wallet.** Retention and archive need exactly one manager in front of each
dpm-wallet. dpm-wallet's maintenance endpoints act on its whole audit table, whatever wallet the
rows belong to, so `WALLET_REF_PREFIX` does not separate them: two managers sharing one
dpm-wallet would trim and archive each other's dpm-wallet records. Give each manager its own
dpm-wallet. Every install already does: two installs side by side never share one.

### Storage and archive

The admin UI's **Storage** page shows how full the disk is, how fast the databases grow and how
many days are left. It warns (a banner, a log line, and the optional alert webhook) when the disk
passes the warning or critical level; at critical, routine records are kept for less time until
it recovers. `dpm-custody status` shows the same level.

**Oldest important record** on that page, and the banner that suggests an archive, cover the
manager's own records only (its operations and audit events that retention never trims).
dpm-wallet's important audit records are archived with them, but their age is not counted there.
The archive reminder is 730 days unless the dashboard sets it; when routine retention is longer,
it follows that.

**Archive:** an owner opens Storage, then Archives, picks a date, previews what would be saved,
and creates and downloads the file. It is named `dpm-archive-<install>-<yyyymmdd>-<code>.ndjson.gz`.
Only after the download finished can the records be removed from the database. To confirm, type
the 6 characters at the end of the file's name (the `<code>`, before `.ndjson.gz`). The admin UI
never shows them: typing them shows you hold the file. Keep the file off this machine. Read it
with `gunzip -c <file> | head` (the first line is the manifest, then one `{table, row}` line per
record), or `gunzip -c <file> | jq -c 'select(.table)'`. As with retention, this needs one
manager per dpm-wallet.

### Health

`GET /v1/health` answers whether the process is up. `GET /v1/health/ready` also runs a database
query and answers `200 {"status":"ok"}` or `503 {"status":"unavailable"}`; neither needs a key.
On the manager, a call from inside its own container (127.0.0.1) also gets a `storage` field with
the disk level; that is what `dpm-custody status` reads. Other callers never see it.
Compose runs the ready probe on dpm-wallet (port 8090, inside the stack) and the manager (port
3000 inside its container), every 10 seconds, with a 60 second start period. Check with
`dpm-custody status`.

On a fresh install both services wait for setup to write their configuration, so they show
`starting` and then `unhealthy` until setup finishes. That is expected, and they turn `healthy`
by themselves afterwards. The manager starts after dpm-wallet has started, not after it is healthy,
so a fresh install can come up and reach setup.

### Release files and checks

Each release carries `install.sh`, `install.ps1`, `compose.yml`, `versions.env`, `dpm-custody`, a
`SHA256SUMS` file and `SHA256SUMS.sig`, a signature over `SHA256SUMS`. `versions.env` pins both
images by digest (`<version>@sha256:...`) and records `RELEASE_VERSION`, which the installer writes
to `.env` as `DPM_CUSTODY_VERSION`.

**What is checked, in order.** The installer and `dpm-custody upgrade` download over `https://` only
(`curl --proto '=https' --tlsv1.2`; PowerShell uses TLS 1.2). They fetch `SHA256SUMS` and
`SHA256SUMS.sig`, and stop, writing nothing, if either is missing or empty. They verify the
signature, then check each file they downloaded against `SHA256SUMS`. Re-running the installer on an
existing install does the same before it replaces `dpm-custody`.

**Signing (ECDSA P-256).** CI signs `SHA256SUMS` with the private key stored as the repository
secret `RELEASE_SIGNING_KEY`, and attaches `SHA256SUMS.sig` (DER) to the release; before attaching, it
checks the signature against the public key embedded in `install.sh`, so a wrong key fails the
release. The public key is embedded in `install.sh` (verified with `openssl dgst -sha256 -verify`),
`install.ps1` (verified with .NET `ECDsa`; Windows PowerShell 5.1 needs .NET Framework 4.7 or
newer) and `dpm-custody`. An upgrade is checked with the key in the dpm-custody you already run, never with
the new release's own copy. Windows PowerShell 5.1 itself has not been tried; PowerShell 7 is tested.

**Hand-off: the embedded key is a placeholder.** No private key exists for it, so until the real
key is embedded no release can be installed or upgraded to. To set it up (these commands are only
printed, none is run):

```sh
sh scripts/release-signing-key.sh     # prints: key generation, `gh secret set RELEASE_SIGNING_KEY`, embedding
```

Then commit the three changed files (`sh scripts/embed-release-key.sh <public key>` does the
embedding) and cut a release. Keep the private key offline. Installs made from the v0.2.2
installer do not verify signatures: re-run the new installer once on them (Step 1) so they carry
the key, then `dpm-custody upgrade` is checked from then on.

**Rehearsals.** `DPM_CUSTODY_RELEASE_PUBKEY` (a PEM file) and `DPM_CUSTODY_ALLOW_INSECURE=1` let
the installer and `dpm-custody upgrade` use a local release folder signed with a throwaway key.
`deploy/try-install.sh` does that for you. They are not for a real install.

---

# Part 2: For the platform team

Part 1 is what a builder does. This part covers what a platform needs before builders can
install against it, how to try the install yourself (locally, on dev, on production), and how to
test these scripts. Setup offers Production, Development and Custom (any dpm-api address); add an
environment in `src/setup/environments.ts`.

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
   - Optional: `PUBLIC_DATA_API_URL`. Without it, installs show "Balances unavailable".
3. **Both images are published on GHCR and public**
   - `ghcr.io/in-a-bit/dpm-wallet` and `ghcr.io/in-a-bit/dpm-wallet-manager`.
   - They must include these changes. For dpm-wallet, that means `APP_API_KEY` is optional.
   - Locally you build them instead (`--build`, below).
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

## Local environment

Everything below runs from your dpm-wallet-manager checkout, with a dpm-wallet checkout next to
it (`../dpm-wallet`). `deploy/try-install.sh` installs exactly what a builder installs; only
where the images come from and which platform to join are yours to choose.

### 1. Prepare the platform on your computer

Any way you run prediction-go works, as long as:

- **Version:** dpm-api, gamma-api and relayer-api run a version with the self-install changes
  (requirement 1 above).
- **Public URLs:** dpm-api's env (prediction-go's root `.env`) has the `PUBLIC_*` URLs, set to
  where this machine reaches those services. With prediction-go's default ports:

  ```sh
  PUBLIC_DPM_API_URL=http://localhost:8086
  PUBLIC_GAMMA_API_URL=http://localhost:8084
  PUBLIC_RELAYER_API_URL=http://localhost:8085
  PUBLIC_DATA_API_URL=http://localhost:8091
  ```

  `localhost` is fine: setup rewrites it so its containers can reach your computer.
  Restart dpm-api after changing them.

- **Backoffice:** the backoffice is running (the prediction-backoffice UI and its backend), so
  you can issue keys.

Check it: `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8086/wallet-install/config`
prints `401` (the endpoint exists and wants a key).

### 2. Get a builder key

In the backoffice: **Custody Builders** → **Onboard custody builder** → type a name → **Create
custody builder** → on its row **New key** → confirm → **Copy**. Use a new builder for every
install.

### 3. Options of try-install.sh

```text
deploy/try-install.sh [options] [bld_sk_…]   check, then install and set up as a builder does
deploy/try-install.sh verify [--dir DIR]      check a finished install (runs scripts/smoke.sh)
deploy/try-install.sh clean  [--dir DIR]      remove the install, to start over
```

| Option             | Default                         | What it does                                                                |
| ------------------ | ------------------------------- | --------------------------------------------------------------------------- |
| `--platform URL`   | asked (`http://localhost:8086`) | The platform's dpm-api address.                                             |
| `--build`          | off                             | Build both images from your checkouts (tagged `:local`) instead of pulling. |
| `--wallet-src DIR` | `../dpm-wallet`                 | The dpm-wallet checkout `--build` uses.                                     |
| `--images TAG`     | `main`                          | Use `ghcr.io/in-a-bit/*:TAG`: pulled, or the copy already on this machine.  |
| `--dir DIR`        | `~/dpm-custody-try`             | Where to install. `verify` and `clean` need the same `--dir`.               |
| `--name NAME`      | `dpm-custody`                   | The install's name (Docker project). Needed for two installs.               |
| `bld_sk_…`         | asked (hidden)                  | The builder key, as the last argument. Prefer pasting it when asked.        |

The port is picked for you: 3000, or the next one that is free and not published by any other
container. The setup dashboard shows it at the end, and it's `MANAGER_PORT` in the install's
`.env`. Every answer is checked as soon as it is given (the platform answers and supports
self-install, the key is accepted, gamma-api and relayer-api accept the key) and asked for again
if it does not pass.

Using `install.sh` directly instead, with your own release folder and env, is described in
[The same, by hand](#the-same-by-hand).

### 4. One install

```sh
cd ~/Documents/prediction-claude/dpm-wallet-manager      # your checkout
./deploy/try-install.sh --build --wallet-src ../dpm-wallet --platform http://localhost:8086
```

It builds the images (a few minutes the first time), asks for the key, installs into
`~/dpm-custody-try` and opens setup. In setup: check it says "Connecting as <your builder>",
choose the mode and type `yes`, wait for every ✔, create the admin login, save the backup kit
and type `saved`. Then it offers the smoke test.

```sh
./deploy/try-install.sh verify                       # services, platform status, scripts/smoke.sh
~/dpm-custody-try/dpm-custody status                 # everyday commands work as in Part 1
grep MANAGER_PORT ~/dpm-custody-try/.env             # the port; admin UI at http://localhost:<port>/admin
./deploy/try-install.sh clean                        # remove it (asks you to type yes)
```

The smoke test creates a wallet and signs an order; it ends with every line ✓.

### 5. Two installs side by side

Create two builders and a key for each. Give each install its own name and folder:

```sh
./deploy/try-install.sh --build --wallet-src ../dpm-wallet --platform http://localhost:8086 \
  --name dpm-custody-segregated --dir ~/dpm-custody-segregated
#   setup asks for the mode: choose Segregated

./deploy/try-install.sh --images local --platform http://localhost:8086 \
  --name dpm-custody-shared --dir ~/dpm-custody-shared
#   setup asks for the mode: choose Shared
```

The second run uses `--images local` to reuse the images the first one built: they are not
published, so it uses the copy already on this machine. Use `--build` again only if the source
changed in between.

Each gets the next free port (for example 3001 and 3002 when 3000 is the backoffice). Everything
else finds the install by its folder:

```sh
./deploy/try-install.sh verify --dir ~/dpm-custody-segregated
./deploy/try-install.sh verify --dir ~/dpm-custody-shared
~/dpm-custody-shared/dpm-custody status
grep MANAGER_PORT ~/dpm-custody-segregated/.env ~/dpm-custody-shared/.env
./deploy/try-install.sh clean --dir ~/dpm-custody-shared      # remove one install only
```

### 6. A new build of an existing local install

To put changed code into a running local install without a release:

```sh
docker build -t ghcr.io/in-a-bit/dpm-wallet-manager:local .
docker build -t ghcr.io/in-a-bit/dpm-wallet:local ../dpm-wallet
~/dpm-custody-try/dpm-custody backup
~/dpm-custody-try/dpm-custody start          # recreates the services whose image changed
~/dpm-custody-try/dpm-custody status
```

Database migrations run as each service starts. This skips the upgrade's checks and rollback, so
to rehearse a real upgrade use the next section.

### 7. Rehearse an upgrade and rollback locally

`dpm-custody upgrade` pulls images and reads release files, so give it a local registry and
local release folders. Start from a finished local install (here `~/dpm-custody-try`):

```sh
# a local registry
docker run -d --name dpm-registry -p 127.0.0.1:5000:5000 registry:2
R=localhost:5000/in-a-bit

# the version the install runs now becomes 1.0.0
docker tag ghcr.io/in-a-bit/dpm-wallet:local         $R/dpm-wallet:1.0.0
docker tag ghcr.io/in-a-bit/dpm-wallet-manager:local $R/dpm-wallet-manager:1.0.0
# change the code, then build 1.1.0
docker build -t $R/dpm-wallet:1.1.0 ../dpm-wallet
docker build -t $R/dpm-wallet-manager:1.1.0 .
for ref in dpm-wallet:1.0.0 dpm-wallet-manager:1.0.0 dpm-wallet:1.1.0 dpm-wallet-manager:1.1.0; do
  docker push $R/$ref
done

# one release folder per version, as CI would publish it, signed with a throwaway key
# (releases are always signed; the install is told to trust this key, for rehearsals only)
openssl ecparam -name prime256v1 -genkey -noout -out /tmp/dpm-rehearsal.pem
openssl pkey -in /tmp/dpm-rehearsal.pem -pubout -out /tmp/dpm-rehearsal.pub
export DPM_CUSTODY_RELEASE_PUBKEY=/tmp/dpm-rehearsal.pub DPM_CUSTODY_ALLOW_INSECURE=1
make_release() {
  D=/tmp/dpm-releases/$1; mkdir -p "$D"
  cp deploy/compose.yml deploy/dpm-custody deploy/install.sh deploy/install.ps1 "$D/"
  printf 'DPM_WALLET_TAG=%s\nDPM_WALLET_MANAGER_TAG=%s\nRELEASE_VERSION=%s\nMIN_UPGRADE_FROM=\n' "$1" "$1" "$1" >"$D/versions.env"
  (cd "$D" && sha256sum compose.yml versions.env dpm-custody install.sh install.ps1 >SHA256SUMS)
  openssl dgst -sha256 -sign /tmp/dpm-rehearsal.pem -out "$D/SHA256SUMS.sig" "$D/SHA256SUMS"
}
make_release 1.0.0
make_release 1.1.0

# point the install at the registry, move it onto 1.0.0, then upgrade and roll back
echo 'DPM_IMAGE_REGISTRY=localhost:5000/in-a-bit' >>~/dpm-custody-try/.env
DPM_CUSTODY_RELEASES_URL=file:///tmp/dpm-releases/1.0.0 ~/dpm-custody-try/dpm-custody upgrade 1.0.0 --yes
DPM_CUSTODY_RELEASES_URL=file:///tmp/dpm-releases/1.1.0 ~/dpm-custody-try/dpm-custody upgrade 1.1.0 --yes
~/dpm-custody-try/dpm-custody rollback        # back to 1.0.0
cat ~/dpm-custody-try/upgrade.log
```

The first `upgrade 1.0.0` says "installed version unknown" (a try install has none) and records
1.0.0. To see the automatic rollback, build a 1.2.0 whose manager exits at boot, push it, make
its release folder and upgrade to it with `DPM_CUSTODY_HEALTH_TIMEOUT=120`: it rolls back to
1.1.0 by itself. On macOS use `shasum -a 256` for `sha256sum`. When done:
`docker rm -f dpm-registry`, remove the `DPM_IMAGE_REGISTRY` line from the install's `.env`,
`unset DPM_CUSTODY_RELEASE_PUBKEY DPM_CUSTODY_ALLOW_INSECURE` and delete `/tmp/dpm-rehearsal.*`.

### 8. Crash test (optional)

`deploy/test/crash.sh` kills dpm-wallet, the manager and Postgres while requests are in flight,
retries each request with its `Idempotency-Key`, and checks nothing was done twice. With
`CRASH_SKIP_TRANSFER=1` it only signs (nothing on chain):

```sh
MANAGER_URL=http://localhost:3001 MANAGER_API_KEY=<an operator or admin key> \
  INSTALL_DIR=~/dpm-custody-try CRASH_SKIP_TRANSFER=1 bash deploy/test/crash.sh
```

Without `CRASH_SKIP_TRANSFER` it also sends one real 0.01 USDC.e transfer from the master wallet
to the operations wallet, so the master wallet must hold at least that. The admin key is in the
backup kit (`dpm-custody backup-kit`).

### The same, by hand

These are try-install.sh's steps, if you want to see or run each one. Run them from your
dpm-wallet-manager checkout, in one terminal. Set the first line to your platform.

**1. The platform to join.**

```sh
PLATFORM=http://localhost:8086
```

**2. Your builder private key.**

```sh
read -rsp 'Builder key: ' BUILDER_KEY; echo
```

**3. Pre-flight.**

```sh
CONFIG=$(curl -s "$PLATFORM/wallet-install/config" -H "X-Builder-Api-Private-Key: $BUILDER_KEY")
echo "$CONFIG" | python3 -m json.tool
GAMMA=$(echo "$CONFIG" | python3 -c 'import json,sys; print(json.load(sys.stdin)["services"]["gamma_api"])')
RELAYER=$(echo "$CONFIG" | python3 -c 'import json,sys; print(json.load(sys.stdin)["services"]["relayer_api"])')
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

**5. Install.** Pick a free port; the installer refuses a taken one and names a free one. Add
`DPM_CUSTODY_NAME=…` for a second install.

```sh
SRC=$(mktemp -d)
cp deploy/compose.yml deploy/dpm-custody "$SRC/"
printf 'DPM_WALLET_TAG=%s\nDPM_WALLET_MANAGER_TAG=%s\n' "$TAG" "$TAG" > "$SRC/versions.env"
# releases are signed: sign this one with a throwaway key and tell the installer to trust it
openssl ecparam -name prime256v1 -genkey -noout -out "$SRC.pem"
openssl pkey -in "$SRC.pem" -pubout -out "$SRC.pub"
(cd "$SRC" && sha256sum compose.yml versions.env dpm-custody >SHA256SUMS)   # shasum -a 256 on macOS
openssl dgst -sha256 -sign "$SRC.pem" -out "$SRC/SHA256SUMS.sig" "$SRC/SHA256SUMS"
DPM_CUSTODY_DIR=~/dpm-custody-try DPM_CUSTODY_SOURCE="$SRC" DPM_CUSTODY_RELEASE_PUBKEY="$SRC.pub" \
  DPM_CUSTODY_MANAGER_PORT=3001 SETUP_PLATFORM_URL="$PLATFORM" sh deploy/install.sh
```

The installer only accepts a signed release, hence the throwaway key; `try-install.sh` does the
same for you.

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

**8. Start over.**

```sh
./deploy/try-install.sh clean
```

Then use a new builder: the old one already has its Turnkey sub-organization.

## Dev

In prediction-env, `dev/prediction.env` for dpm-api:

```sh
PUBLIC_DPM_API_URL=https://dpm-api.inabit.dev
PUBLIC_GAMMA_API_URL=https://gamma-api.inabit.dev
PUBLIC_RELAYER_API_URL=https://relayer-api.inabit.dev
```

Deploy prediction-go to `dev` with **Manage ENV Deployments**, gamma-api first, then dpm-api.
Merge dpm-wallet and dpm-wallet-manager to `dev` so the `:dev` images exist. Then get a key from
the dev backoffice and run:

```sh
./deploy/try-install.sh --platform https://dpm-api.inabit.dev --images dev
./deploy/try-install.sh verify
```

Side by side on dev works the same as locally: add `--name` and `--dir` to each run.

## Production (dpm.network)

This is exactly what a builder runs (Part 1), so it's the final check before telling builders
about it.

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

**6. Upgrade.** After the next release, run `~/dpm-custody/dpm-custody upgrade` on that test
install before announcing the release.

## Testing the deploy scripts

None of these start real containers or touch a platform.

```sh
bash deploy/test/install.test.sh     # install.sh: checksums and signatures, options (name, port), re-runs
bash deploy/test/upgrade.test.sh     # dpm-custody upgrade and rollback, every failure path

# install.ps1, under PowerShell 7 in a container (or `pwsh -File …` where PowerShell is installed)
docker run --rm -v "$PWD:/repo:ro" mcr.microsoft.com/powershell:lts-7.4-ubuntu-22.04 \
  pwsh -NoProfile -File /repo/deploy/test/install.test.ps1
```

Each prints one `ok` or `FAIL` line per check and ends with `all passed`. For a real install,
use [Local environment](#local-environment) steps 4 to 8.
