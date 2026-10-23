# Installs a DPM custody stack on Windows (Docker Desktop):
#
#   irm https://github.com/In-a-bit/dpm-wallet-manager/releases/latest/download/install.ps1 | iex
#
# Same steps as install.sh: check Docker, put the files in %USERPROFILE%\dpm-custody, write .env
# with a fresh database password, start the stack, then run setup in this window.
# DPM_CUSTODY_RELEASES_URL replaces the download base; downloads are checked against the release's
# SHA256SUMS. DPM_CUSTODY_NO_START=1 stops after the files and .env are written.
# Day-to-day commands afterwards: docker compose in that folder (see README).
$ErrorActionPreference = "Stop"

$Dir = if ($env:DPM_CUSTODY_DIR) { $env:DPM_CUSTODY_DIR } else { Join-Path $HOME "dpm-custody" }
$Release = if ($env:DPM_CUSTODY_RELEASE) { $env:DPM_CUSTODY_RELEASE } else { "latest" }
$Releases = "https://github.com/In-a-bit/dpm-wallet-manager/releases"

function Remove-Stage { if ($script:Stage) { Remove-Item $script:Stage -Recurse -Force -ErrorAction SilentlyContinue } }

function Fail($message) {
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
  if ($env:DPM_CUSTODY_SOURCE) { Copy-Item (Join-Path $env:DPM_CUSTODY_SOURCE $name) (Join-Path $Stage $name); return }
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
    "POSTGRES_USER=dpm",
    "POSTGRES_PASSWORD=$(New-Secret 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789' 32)",
    "MANAGER_BIND=127.0.0.1",
    "MANAGER_PORT=3000",
    "MANAGER_PUBLIC_URL=http://localhost:3000"
  ) + $versions + "DPM_CUSTODY_VERSION=$version"
  # UTF-8 without a BOM: Compose would read a BOM as part of the first variable's name.
  [System.IO.File]::WriteAllLines((Join-Path $Dir ".env"), $lines, (New-Object System.Text.UTF8Encoding $false))
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
    Get-InstallFile "dpm-custody"
    Test-InstallFiles @("dpm-custody")
    Copy-Item (Join-Path $Stage "dpm-custody") "$custody.new" -Force
    Move-Item "$custody.new" $custody -Force
    Write-Host "  Updated $custody. To move this install to the new version, run: dpm-custody upgrade"
  }
  Write-Host "  Starting the install as it is ..."
} else {
  Write-Host "  Installing into $Dir ..."
  $files = "compose.yml", "versions.env"
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
docker @Compose exec -e SETUP_INSTALL_SECONDS setup node dist/setup/main setup
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
