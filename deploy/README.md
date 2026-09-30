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
