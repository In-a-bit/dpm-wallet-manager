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
# DPM_CUSTODY_RELEASES_URL replaces the download base. Downloads are checked against the release's
# SHA256SUMS, which must carry a valid signature (SHA256SUMS.sig, ECDSA P-256, checked against the
# public key below); a release without either is refused. Only https:// is accepted, unless
# DPM_CUSTODY_ALLOW_INSECURE=1 (file:// and http:// for a local rehearsal), and
# DPM_CUSTODY_RELEASE_PUBKEY=C:\path\public.pem checks against that key instead (rehearsals only).
# Works in Windows PowerShell 5.1 (.NET Framework 4.7+) and PowerShell 7.
# DPM_CUSTODY_NO_START=1 stops after the files and .env are written.
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

# >>> release public key >>>
# PLACEHOLDER: no private key exists for this one. Replace it with the real key (see
# scripts/release-signing-key.sh) in install.sh, install.ps1 and dpm-custody; until then no
# release can be verified, so none can be installed or upgraded to.
$ReleaseKeyIsPlaceholder = $true
$ReleasePubKey = @'
-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEAmHIZwcph401VXfbdEQCsT5VUeke
b/nekspBGcW/P3518k+tqluQyqTRi8Y7R7jA6zxSdQwNYVFy41HokCfzCQ==
-----END PUBLIC KEY-----
'@
# <<< release public key <<<

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

# Refuses anything but https://, except for a local rehearsal.
function Assert-SecureUrl($url) {
  if ($url -like "https://*") { return }
  if ($env:DPM_CUSTODY_ALLOW_INSECURE -eq "1") { return }
  Fail "Refusing to download from ${url}: releases are fetched over https:// only. (DPM_CUSTODY_ALLOW_INSECURE=1 allows file:// and http:// for a local rehearsal; never use it on a real install.)"
}

# Downloads $url to $out; file:// is a plain copy (Invoke-WebRequest has no file scheme in PowerShell 7).
function Get-Remote($url, $out) {
  Assert-SecureUrl $url
  if ($url -like "file://*") { Copy-Item ([uri]$url).LocalPath $out -ErrorAction Stop; return }
  # Windows PowerShell 5.1 defaults to older TLS; the release host needs 1.2.
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
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

# The signature is DER (what openssl writes); .NET wants r||s, 32 bytes each (IEEE P1363).
function ConvertFrom-DerSignature([byte[]]$der) {
  $i = 0
  if ($der.Length -lt 8 -or $der[$i++] -ne 0x30) { throw "not a DER signature" }
  $len = $der[$i++]
  if ($len -band 0x80) { $i += ($len -band 0x7f) }
  $out = New-Object byte[] 64
  for ($part = 0; $part -lt 2; $part++) {
    if ($der[$i++] -ne 0x02) { throw "not a DER signature" }
    $l = [int]$der[$i++]
    $value = New-Object byte[] $l
    [Array]::Copy($der, $i, $value, 0, $l)
    $i += $l
    $skip = 0
    while ($skip -lt $value.Length - 1 -and $value[$skip] -eq 0) { $skip++ }
    $n = $value.Length - $skip
    if ($n -gt 32) { throw "not a P-256 signature" }
    [Array]::Copy($value, $skip, $out, ($part * 32) + (32 - $n), $n)
  }
  return ,$out
}

# Checks SHA256SUMS against SHA256SUMS.sig with the release public key (embedded, or the PEM file
# in DPM_CUSTODY_RELEASE_PUBKEY). The key is read out of its fixed 91-byte P-256 SubjectPublicKeyInfo
# by hand, so this needs only ECDsa.Create(ECParameters) (.NET Framework 4.7+, .NET Core): no
# ImportSubjectPublicKeyInfo, which Windows PowerShell 5.1 lacks.
function Test-ReleaseSignature {
  $pem = if ($env:DPM_CUSTODY_RELEASE_PUBKEY) {
    if (-not (Test-Path $env:DPM_CUSTODY_RELEASE_PUBKEY)) { Fail "DPM_CUSTODY_RELEASE_PUBKEY ($env:DPM_CUSTODY_RELEASE_PUBKEY) is not a readable file." }
    Get-Content -Raw $env:DPM_CUSTODY_RELEASE_PUBKEY
  } else { $ReleasePubKey }
  $valid = $false
  try {
    $der = [Convert]::FromBase64String((($pem -split "`r?`n" | Where-Object { $_ -and $_ -notmatch '^-----' }) -join ""))
    $prefix = [byte[]](0x30,0x59,0x30,0x13,0x06,0x07,0x2a,0x86,0x48,0xce,0x3d,0x02,0x01,0x06,0x08,0x2a,0x86,0x48,0xce,0x3d,0x03,0x01,0x07,0x03,0x42,0x00,0x04)
    if ($der.Length -ne 91) { throw "not a P-256 public key" }
    for ($k = 0; $k -lt $prefix.Length; $k++) { if ($der[$k] -ne $prefix[$k]) { throw "not a P-256 public key" } }
    $q = New-Object System.Security.Cryptography.ECPoint
    $q.X = $der[27..58]
    $q.Y = $der[59..90]
    $parameters = New-Object System.Security.Cryptography.ECParameters
    $parameters.Curve = [System.Security.Cryptography.ECCurve]::CreateFromValue("1.2.840.10045.3.1.7")
    $parameters.Q = $q
    $data = [System.IO.File]::ReadAllBytes((Join-Path $Stage "SHA256SUMS"))
    $signature = ConvertFrom-DerSignature ([System.IO.File]::ReadAllBytes((Join-Path $Stage "SHA256SUMS.sig")))
    $ecdsa = [System.Security.Cryptography.ECDsa]::Create($parameters)
    $valid = $ecdsa.VerifyData($data, $signature, [System.Security.Cryptography.HashAlgorithmName]::SHA256)
  } catch {
    $valid = $false
  }
  if ($valid) { return }
  if ($ReleaseKeyIsPlaceholder -and -not $env:DPM_CUSTODY_RELEASE_PUBKEY) {
    Fail "This installer still carries a placeholder release key, so no signature can be valid. Nothing was installed. Tell the platform team."
  }
  Fail "The release's signature (SHA256SUMS.sig) does not match its SHA256SUMS. Nothing was installed. Do not use this download; tell the platform team."
}

# Checks the staged files against the release's SHA256SUMS, after checking the signature on it. A
# release without SHA256SUMS or SHA256SUMS.sig, a bad signature or a mismatch aborts before
# anything is installed.
function Test-InstallFiles($names) {
  $sums = Join-Path $Stage "SHA256SUMS"
  foreach ($f in "SHA256SUMS", "SHA256SUMS.sig") {
    Remove-Item (Join-Path $Stage $f) -ErrorAction SilentlyContinue
    try { Get-InstallFile $f }
    catch { Fail "Could not get $f for this release ($($_.Exception.Message)). Nothing was installed." }
    if (-not (Test-Path (Join-Path $Stage $f)) -or (Get-Item (Join-Path $Stage $f)).Length -eq 0) {
      Fail "$f is missing or empty. Nothing was installed."
    }
  }
  Test-ReleaseSignature
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
Write-Host "  Later, in $Dir : dpm-custody start, stop, status, backup, upgrade, ... (from Git Bash or WSL; backups are encrypted: keep the backup recovery key from the kit),"
Write-Host "  or docker compose --env-file .env -f compose.yml followed by up -d, stop, ps or logs."
Write-Host ""
