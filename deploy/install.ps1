# Installs a DPM custody stack on Windows (Docker Desktop):
#
#   irm https://github.com/In-a-bit/dpm-wallet-manager/releases/latest/download/install.ps1 | iex
#
# Same steps and options as install.sh: check Docker, put the files in %USERPROFILE%\dpm-custody
# (override with DPM_CUSTODY_DIR), write .env with a fresh database password, start the stack,
# then run setup in this window. Running it again on an existing install starts it and refreshes
# only the dpm-custody script; compose.yml, versions.env and .env are never overwritten.
#
# Options are environment variables, set before running it ($env:NAME = "value"):
# DPM_CUSTODY_RELEASE=v1.2.3 installs that release instead of the latest.
# DPM_CUSTODY_RELEASES_URL replaces the download base; file:// works. Downloads are checked
# against the release's SHA256SUMS. DPM_CUSTODY_NO_START=1 stops after the files and .env are written.
# DPM_CUSTODY_MANAGER_PORT moves the wallet manager's port (default 3000). A new install checks
# the port first and stops, naming a free one, when another program or container has it.
# DPM_CUSTODY_NAME names the install (default dpm-custody): its containers, volumes and network
# are all prefixed with it, so two installs with different names run side by side.
# DPM_CUSTODY_SOURCE=C:\path\to\deploy copies the files from a local folder (for testing).
# SETUP_PLATFORM_URL / SETUP_BUILDER_KEY answer setup's first two questions (still checked).
#
# Day-to-day commands afterwards: dpm-custody (needs Git Bash or WSL) or docker compose in that
# folder (see README).
$ErrorActionPreference = "Stop"

$Dir = if ($env:DPM_CUSTODY_DIR) { $env:DPM_CUSTODY_DIR } else { Join-Path $HOME "dpm-custody" }
$Release = if ($env:DPM_CUSTODY_RELEASE) { $env:DPM_CUSTODY_RELEASE } else { "latest" }
$Releases = "https://github.com/In-a-bit/dpm-wallet-manager/releases"
$ManagerPort = if ($env:DPM_CUSTODY_MANAGER_PORT) { $env:DPM_CUSTODY_MANAGER_PORT } else { "3000" }
$Name = if ($env:DPM_CUSTODY_NAME) { $env:DPM_CUSTODY_NAME } else { "dpm-custody" }

function Remove-Stage { if ($script:Stage) { Remove-Item $script:Stage -Recurse -Force -ErrorAction SilentlyContinue } }

# While $FailSoft is set (refreshing dpm-custody on an existing install), Fail throws instead of
# exiting, so the caller can keep the current script and carry on.
$FailSoft = $false

function Fail($message) {
  if ($script:FailSoft) { throw $message }
  Remove-Stage
  Write-Host ""
  Write-Host "  X $message" -ForegroundColor Red
  Write-Host ""
  exit 1
}

function Test-Docker {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Fail "Docker is not installed. Install Docker Desktop from https://www.docker.com/products/docker-desktop/ then run this again."
  }
  docker info *> $null
  if ($LASTEXITCODE -ne 0) { Fail "Docker Desktop is not running. Start it, wait a minute, then run this again." }
  docker compose version *> $null
  if ($LASTEXITCODE -ne 0) { Fail "Docker Compose v2 is missing. Update Docker Desktop, then run this again." }
}

# Downloads go to a temporary folder first, so a bad download or checksum never leaves anything
# half-written in the install folder.
$Stage = Join-Path ([System.IO.Path]::GetTempPath()) ("dpm-custody-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $Stage | Out-Null
# Any other error (a failed download, say) also removes the temporary folder.
trap { Remove-Stage; break }

# Downloads $url to $out; file:// is a plain copy (Invoke-WebRequest has no file scheme in PowerShell 7).
function Get-Remote($url, $out) {
  if ($url -like "file://*") { Copy-Item ([uri]$url).LocalPath $out -ErrorAction Stop; return }
  Invoke-WebRequest -UseBasicParsing $url -OutFile $out -ErrorAction Stop
}

function Get-ReleasesBase {
  if ($env:DPM_CUSTODY_RELEASES_URL) { return $env:DPM_CUSTODY_RELEASES_URL.TrimEnd("/") }
  if ($Release -eq "latest") { return "$Releases/latest/download" }
  return "$Releases/download/$Release"
}

function Get-InstallFile($name) {
  if ($env:DPM_CUSTODY_SOURCE) { Copy-Item (Join-Path $env:DPM_CUSTODY_SOURCE $name) (Join-Path $Stage $name) -ErrorAction Stop; return }
  Get-Remote "$(Get-ReleasesBase)/$name" (Join-Path $Stage $name)
}

# Checks the staged files against the release's SHA256SUMS. A release without one (older
# releases) is accepted with a warning; a mismatch aborts before anything is installed.
function Test-InstallFiles($names) {
  $sums = Join-Path $Stage "SHA256SUMS"
  # Only a real "not found" means the release has no SHA256SUMS; any other failure aborts.
  if ($env:DPM_CUSTODY_SOURCE) {
    $src = Join-Path $env:DPM_CUSTODY_SOURCE "SHA256SUMS"
    if (Test-Path $src) {
      try { Copy-Item $src $sums -ErrorAction Stop } catch { Fail "Could not read SHA256SUMS from $env:DPM_CUSTODY_SOURCE." }
    }
  } else {
    $url = "$(Get-ReleasesBase)/SHA256SUMS"
    if ($url -like "file://*" -and -not (Test-Path ([uri]$url).LocalPath)) {
      # missing file: no SHA256SUMS
    } else {
      try { Get-Remote $url $sums }
      catch {
        $status = $null
        if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
        if ($status -eq 404) { Remove-Item $sums -ErrorAction SilentlyContinue }
        else { Fail "Could not download SHA256SUMS ($url). Nothing was installed." }
      }
    }
  }
  if (-not (Test-Path $sums)) {
    Write-Host "  ! This release has no SHA256SUMS; the downloads could not be checked." -ForegroundColor Yellow
    return
  }
  $lines = Get-Content $sums
  foreach ($n in $names) {
    $line = $lines | Where-Object { $_ -match "^([0-9a-fA-F]{64})  \*?$([regex]::Escape($n))$" } | Select-Object -First 1
    if (-not $line) { Fail "SHA256SUMS has no entry for $n. Nothing was installed." }
    $expected = ($line -split " ")[0]
    $actual = (Get-FileHash -Algorithm SHA256 (Join-Path $Stage $n)).Hash
    if ($actual -ne $expected.ToUpper()) { Fail "A downloaded file ($n) does not match SHA256SUMS. Nothing was installed. Try again; if it keeps failing, tell the platform team." }
  }
}

function New-Secret($chars, $length) {
  $bytes = New-Object byte[] ($length * 4)
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] } | Select-Object -First $length)
}

function Write-InstallEnv {
  $versions = Get-Content (Join-Path $Dir "versions.env") | Where-Object { $_ -match '^DPM_WALLET(_MANAGER)?_TAG=' }
  $version = (Get-Content (Join-Path $Dir "versions.env") | Where-Object { $_ -match '^RELEASE_VERSION=.+' } | Select-Object -First 1) -replace '^RELEASE_VERSION=', ''
  if (-not $version) { $version = "unknown" }
  $lines = @(
    "# Written by the installer. Keep this file private: it holds the database password.",
    # Overrides compose.yml's `name:`, which is what keeps this install apart from any other.
    "COMPOSE_PROJECT_NAME=$Name",
    "POSTGRES_USER=dpm",
    "POSTGRES_PASSWORD=$(New-Secret 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789' 32)",
    "MANAGER_BIND=127.0.0.1",
    "MANAGER_PORT=$ManagerPort",
    "MANAGER_PUBLIC_URL=http://localhost:$ManagerPort"
  ) + $versions + "DPM_CUSTODY_VERSION=$version"
  # UTF-8 without a BOM: Compose would read a BOM as part of the first variable's name.
  [System.IO.File]::WriteAllLines((Join-Path $Dir ".env"), $lines, (New-Object System.Text.UTF8Encoding $false))
}

# Refuses a name another install on this machine already uses: Docker would treat the two as one,
# and the new install would take over the other's containers and data.
function Test-InstallName {
  if ($Name -cnotmatch '^[a-z0-9]') { Fail "DPM_CUSTODY_NAME must start with a lowercase letter or digit." }
  if ($Name -cnotmatch '^[a-z0-9_-]+$') { Fail "DPM_CUSTODY_NAME may only use lowercase letters, digits, '-' and '_'." }
  $names = docker compose ls -a -q 2>$null
  if ($names -contains $Name) { Fail "Another install on this machine is already named `"$Name`". Choose another name with DPM_CUSTODY_NAME." }
}

# True when $port is unusable for a new install: something on this machine accepts connections
# on it, or a container (running or stopped) already publishes it. A stopped install's port is
# free right now, but taking it would clash once both are started.
function Test-PortTaken([int]$port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    if ($client.ConnectAsync("127.0.0.1", $port).Wait(1000) -and $client.Connected) { return $true }
  } catch {
    # Refused: nothing listens there.
  } finally {
    $client.Dispose()
  }
  $ids = docker ps -aq 2>$null
  if (-not $ids) { return $false }
  $published = docker inspect --format '{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}{{.HostPort}} {{end}}{{end}}' @ids 2>$null
  return (($published -join " ") -split "\s+") -contains "$port"
}

# Refuses a port that is not a number or is already taken, before anything is written, and names
# the next free one.
function Test-ManagerPort {
  if ($ManagerPort -notmatch '^[0-9]+$') { Fail "DPM_CUSTODY_MANAGER_PORT must be a port number, e.g. 3001." }
  $port = [int]$ManagerPort
  if ($port -lt 1 -or $port -gt 65535) { Fail "DPM_CUSTODY_MANAGER_PORT must be between 1 and 65535." }
  if (-not (Test-PortTaken $port)) { return }
  $free = $port + 1
  while ($free -le 65535 -and (Test-PortTaken $free)) { $free++ }
  Fail "Port $port is already in use on this machine. Nothing was installed. Run the installer again with a free port, e.g. `$env:DPM_CUSTODY_MANAGER_PORT = `"$free`" first."
}

$InstallStart = Get-Date
Write-Host ""
Write-Host "  DPM Custody installer"
Write-Host ""
Test-Docker
if (Test-Path (Join-Path $Dir ".env")) {
  # Only a dpm-custody script, if this folder has one, is refreshed; compose.yml, versions.env
  # and .env stay as they are.
  Write-Host "  Found an existing install in $Dir."
  $custody = Join-Path $Dir "dpm-custody"
  if (Test-Path $custody) {
    # Never install an unverified script, but do not stop a working install from starting.
    $script:FailSoft = $true
    try {
      Get-InstallFile "dpm-custody"
      Test-InstallFiles @("dpm-custody")
      Copy-Item (Join-Path $Stage "dpm-custody") "$custody.new" -Force -ErrorAction Stop
      Move-Item "$custody.new" $custody -Force -ErrorAction Stop
      Write-Host "  Updated $custody. To move this install to the new version, run: dpm-custody upgrade"
    } catch {
      Remove-Item "$custody.new" -Force -ErrorAction SilentlyContinue
      Write-Host "  ! Could not refresh dpm-custody: $($_.Exception.Message)" -ForegroundColor Yellow
      Write-Host "    Kept the current dpm-custody script. Run this installer again later to get the new one before running dpm-custody upgrade."
    } finally {
      $script:FailSoft = $false
    }
  }
  Write-Host "  Starting the install as it is ..."
} else {
  Test-InstallName
  Test-ManagerPort
  Write-Host "  Installing into $Dir ..."
  $files = "compose.yml", "versions.env", "dpm-custody"
  foreach ($f in $files) { Get-InstallFile $f }
  Test-InstallFiles $files
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  foreach ($f in $files) { Copy-Item (Join-Path $Stage $f) (Join-Path $Dir $f) -Force }
  Write-InstallEnv
}
Remove-Item $Stage -Recurse -Force -ErrorAction SilentlyContinue
if ($env:DPM_CUSTODY_NO_START -eq "1") {
  Write-Host "  DPM_CUSTODY_NO_START=1: stopping before the services start."
  return
}

Write-Host "  Downloading and starting the services (the first time takes a few minutes) ..."
Push-Location $Dir
docker compose --env-file .env -f compose.yml up -d --pull missing
$started = $LASTEXITCODE -eq 0
Pop-Location
if (-not $started) { Fail "Docker could not start the services. See the messages above." }

$Compose = @("compose", "--env-file", ".env", "-f", "compose.yml")
Push-Location $Dir
$ready = $false
for ($i = 0; $i -lt 90 -and -not $ready; $i++) {
  docker @Compose exec -T setup true *> $null
  if ($LASTEXITCODE -eq 0) { $ready = $true } else { Start-Sleep 2 }
}
if (-not $ready) { Pop-Location; Fail "The setup service did not start. In $Dir run: docker compose logs setup" }

# Shown in setup's checklist as the time the installation took.
$env:SETUP_INSTALL_SECONDS = [int]((Get-Date) - $InstallStart).TotalSeconds
Write-Host ""
# The two answers, when given, go to setup the way dpm-custody passes them: by name, from this
# process's environment, so the key never appears on a command line.
$SetupEnv = @("-e", "SETUP_INSTALL_SECONDS")
if ($env:SETUP_PLATFORM_URL) { $SetupEnv += @("-e", "SETUP_PLATFORM_URL") }
if ($env:SETUP_BUILDER_KEY) { $SetupEnv += @("-e", "SETUP_BUILDER_KEY") }
docker @Compose exec @SetupEnv setup node dist/setup/main setup
$finished = $LASTEXITCODE -eq 0
Pop-Location
if (-not $finished) {
  Write-Host ""
  Write-Host "  Setup is not finished. Continue any time, in $Dir :" -ForegroundColor Yellow
  Write-Host "      docker compose --env-file .env -f compose.yml exec setup node dist/setup/main setup"
  Write-Host ""
  # Not exit: under irm | iex that would close the window, and the message with it.
  return
}
Write-Host ""
Write-Host "  Later, in $Dir : dpm-custody start, stop, status, backup, upgrade, ... (from Git Bash or WSL),"
Write-Host "  or docker compose --env-file .env -f compose.yml followed by up -d, stop, ps or logs."
Write-Host ""
