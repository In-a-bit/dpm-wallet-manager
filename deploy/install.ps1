# Installs a DPM custody stack on Windows (Docker Desktop):
#
#   irm https://github.com/In-a-bit/dpm-wallet-manager/releases/latest/download/install.ps1 | iex
#
# Same steps as install.sh: check Docker, put the files in %USERPROFILE%\dpm-custody, write .env
# with a fresh database password and setup PIN, start the stack and open the setup page.
# Day-to-day commands afterwards: docker compose in that folder (see README).
$ErrorActionPreference = "Stop"

$Dir = if ($env:DPM_CUSTODY_DIR) { $env:DPM_CUSTODY_DIR } else { Join-Path $HOME "dpm-custody" }
$Release = if ($env:DPM_CUSTODY_RELEASE) { $env:DPM_CUSTODY_RELEASE } else { "latest" }
$Releases = "https://github.com/In-a-bit/dpm-wallet-manager/releases"
$SetupPort = 8480

function Fail($message) {
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

function Get-InstallFile($name) {
  if ($env:DPM_CUSTODY_SOURCE) { Copy-Item (Join-Path $env:DPM_CUSTODY_SOURCE $name) (Join-Path $Dir $name); return }
  $base = if ($Release -eq "latest") { "$Releases/latest/download" } else { "$Releases/download/$Release" }
  Invoke-WebRequest -UseBasicParsing "$base/$name" -OutFile (Join-Path $Dir $name)
}

function New-Secret($chars, $length) {
  $bytes = New-Object byte[] ($length * 4)
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] } | Select-Object -First $length)
}

function Write-InstallEnv {
  $versions = Get-Content (Join-Path $Dir "versions.env") | Where-Object { $_ -match '^DPM_WALLET(_MANAGER)?_TAG=' }
  $lines = @(
    "# Written by the installer. Keep this file private: it holds the database password.",
    "POSTGRES_USER=dpm",
    "POSTGRES_PASSWORD=$(New-Secret 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789' 32)",
    "SETUP_PIN=$(New-Secret '0123456789' 6)",
    "SETUP_PORT=$SetupPort",
    "MANAGER_BIND=127.0.0.1",
    "MANAGER_PORT=3000",
    "MANAGER_PUBLIC_URL=http://localhost:3000"
  ) + $versions
  # UTF-8 without a BOM: Compose would read a BOM as part of the first variable's name.
  [System.IO.File]::WriteAllLines((Join-Path $Dir ".env"), $lines, (New-Object System.Text.UTF8Encoding $false))
}

Write-Host ""
Write-Host "  DPM Custody installer"
Write-Host ""
Test-Docker
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
if (Test-Path (Join-Path $Dir ".env")) {
  Write-Host "  Found an existing install in $Dir; starting it."
} else {
  Write-Host "  Installing into $Dir ..."
  foreach ($f in "compose.yml", "versions.env") { Get-InstallFile $f }
  Write-InstallEnv
}

Write-Host "  Downloading and starting the services (the first time takes a few minutes) ..."
Push-Location $Dir
docker compose --env-file .env -f compose.yml up -d --pull missing
$started = $LASTEXITCODE -eq 0
Pop-Location
if (-not $started) { Fail "Docker could not start the services. See the messages above." }

$url = "http://localhost:$SetupPort"
$ready = $false
for ($i = 0; $i -lt 90 -and -not $ready; $i++) {
  try { Invoke-WebRequest -UseBasicParsing $url -TimeoutSec 2 | Out-Null; $ready = $true } catch { Start-Sleep 2 }
}
if (-not $ready) { Fail "The setup page did not start. In $Dir run: docker compose logs setup" }

$pin = ((Get-Content (Join-Path $Dir ".env")) | Where-Object { $_ -like "SETUP_PIN=*" }) -replace "^SETUP_PIN=", ""
Write-Host ""
Write-Host "  Ready. Finish setup in your browser:" -ForegroundColor Green
Write-Host ""
Write-Host "      Address:  $url"
Write-Host "      PIN:      $pin"
Write-Host ""
Start-Process $url
