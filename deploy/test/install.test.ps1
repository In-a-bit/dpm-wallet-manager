# Re-runnable checks for deploy/install.ps1: options (name, port, setup answers), NO_START and the
# existing-install re-run. A `docker` shim on PATH answers instead of Docker, so no container runs.
# The shim is a shell script, so this runs under PowerShell 7 on Linux or macOS, e.g. from the
# repo root:
#   docker run --rm -v "$PWD/deploy:/deploy:ro" mcr.microsoft.com/powershell:lts-7.4-ubuntu-22.04 \
#     pwsh -NoProfile -File /deploy/test/install.test.ps1
$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $PSScriptRoot
$T = Join-Path ([System.IO.Path]::GetTempPath()) ("ps1-test-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $T | Out-Null
$script:Fails = 0
function Check($name, [bool]$ok) {
  if ($ok) { Write-Host "ok   - $name" } else { Write-Host "FAIL - $name"; $script:Fails++ }
}

# Release folder: the installer's files, with SHA256SUMS over them.
$Rel = Join-Path $T "rel"
New-Item -ItemType Directory -Path $Rel | Out-Null
foreach ($f in "compose.yml", "versions.env", "dpm-custody") { Copy-Item (Join-Path $Here $f) (Join-Path $Rel $f) }
$sums = foreach ($f in "compose.yml", "versions.env", "dpm-custody") {
  "$((Get-FileHash -Algorithm SHA256 (Join-Path $Rel $f)).Hash.ToLower())  $f"
}
Set-Content (Join-Path $Rel "SHA256SUMS") $sums

# docker shim: logs every call; `compose ls` lists $EXISTING_NAME, `ps -aq`/`inspect` report a
# container publishing $CLAIMED_PORT; everything else succeeds.
$Bin = Join-Path $T "bin"
New-Item -ItemType Directory -Path $Bin | Out-Null
Set-Content (Join-Path $Bin "docker") @'
#!/bin/sh
echo "$*" >>"$DOCKER_LOG"
case "$1 $2" in
  "compose ls") [ -n "$EXISTING_NAME" ] && echo "$EXISTING_NAME"; exit 0 ;;
  "ps -aq") [ -n "$CLAIMED_PORT" ] && echo c0ffee; exit 0 ;;
esac
[ "$1" = inspect ] && [ -n "$CLAIMED_PORT" ] && echo "$CLAIMED_PORT "
exit 0
'@
chmod +x (Join-Path $Bin "docker")
$env:PATH = "$Bin$([System.IO.Path]::PathSeparator)$env:PATH"
$env:DOCKER_LOG = Join-Path $T "docker.log"

function Get-FreePort {
  $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $l.Start(); $p = $l.LocalEndpoint.Port; $l.Stop(); $p
}
$Port = Get-FreePort

# Runs the installer in a child pwsh (it calls exit) with the given variables; returns its output
# and exit code. Variables not given are cleared, so cases do not leak into each other.
function Invoke-Installer($dir, [hashtable]$vars = @{}) {
  $all = @{
    DPM_CUSTODY_DIR = $dir; DPM_CUSTODY_RELEASES_URL = "file://$Rel"; DPM_CUSTODY_NO_START = "1"
    DPM_CUSTODY_MANAGER_PORT = "$Port"; DPM_CUSTODY_NAME = $null; DPM_CUSTODY_SOURCE = $null
    EXISTING_NAME = $null; CLAIMED_PORT = $null; SETUP_PLATFORM_URL = $null; SETUP_BUILDER_KEY = $null
  }
  foreach ($k in $vars.Keys) { $all[$k] = $vars[$k] }
  foreach ($k in $all.Keys) { [Environment]::SetEnvironmentVariable($k, $all[$k]) }
  $out = pwsh -NoProfile -File (Join-Path $Here "install.ps1") 2>&1 | Out-String
  @{ Out = $out; Code = $LASTEXITCODE }
}
function Test-Empty($dir) { -not (Test-Path $dir) -or -not (Get-ChildItem $dir -Force) }

# 1. a new install with a name and a port
$d = Join-Path $T "i1"
$r = Invoke-Installer $d @{ DPM_CUSTODY_NAME = "dpm-custody-shared" }
$envFile = Get-Content (Join-Path $d ".env") -ErrorAction SilentlyContinue
Check "new install: exits 0" ($r.Code -eq 0)
Check "new install: compose.yml, versions.env and dpm-custody written" ((Test-Path "$d/compose.yml") -and (Test-Path "$d/versions.env") -and (Test-Path "$d/dpm-custody"))
Check "new install: .env has the project name" ($envFile -contains "COMPOSE_PROJECT_NAME=dpm-custody-shared")
Check "new install: .env has the port and public URL" (($envFile -contains "MANAGER_PORT=$Port") -and ($envFile -contains "MANAGER_PUBLIC_URL=http://localhost:$Port"))
Check "new install: .env has no BOM" ([System.IO.File]::ReadAllBytes("$d/.env")[0] -ne 0xEF)

# 2. defaults: name dpm-custody, port 3000 (when free here)
$d = Join-Path $T "i2"
$r = Invoke-Installer $d @{ DPM_CUSTODY_MANAGER_PORT = $null }
$envFile = Get-Content (Join-Path $d ".env") -ErrorAction SilentlyContinue
if ($r.Out -match "Port 3000 is already in use") {
  Check "defaults: 3000 taken here, refused with a free port named" ($r.Out -match 'DPM_CUSTODY_MANAGER_PORT = "\d+"')
} else {
  Check "defaults: name dpm-custody and port 3000" (($envFile -contains "COMPOSE_PROJECT_NAME=dpm-custody") -and ($envFile -contains "MANAGER_PORT=3000"))
}

# 3. a port something listens on
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$busy = $listener.LocalEndpoint.Port
$d = Join-Path $T "i3"
$r = Invoke-Installer $d @{ DPM_CUSTODY_MANAGER_PORT = "$busy" }
$listener.Stop()
Check "port in use: exits non-zero, nothing written" (($r.Code -ne 0) -and (Test-Empty $d))
Check "port in use: names the port and a free one" (($r.Out -match "Port $busy is already in use") -and ($r.Out -match 'DPM_CUSTODY_MANAGER_PORT = "\d+"'))

# 4. a port a stopped container publishes
$d = Join-Path $T "i4"
$r = Invoke-Installer $d @{ CLAIMED_PORT = "$Port" }
Check "port claimed by a container: refused, nothing written" (($r.Code -ne 0) -and (Test-Empty $d) -and ($r.Out -match "Port $Port is already in use"))

# 5. malformed port and names
$r = Invoke-Installer (Join-Path $T "i5") @{ DPM_CUSTODY_MANAGER_PORT = "30x1" }
Check "malformed port: refused" (($r.Code -ne 0) -and ($r.Out -match "must be a port number"))
$r = Invoke-Installer (Join-Path $T "i6") @{ DPM_CUSTODY_NAME = "Bad.Name" }
Check "malformed name: refused" (($r.Code -ne 0) -and ($r.Out -match "DPM_CUSTODY_NAME"))
$d = Join-Path $T "i7"
$r = Invoke-Installer $d @{ DPM_CUSTODY_NAME = "dpm-custody-shared"; EXISTING_NAME = "dpm-custody-shared" }
Check "name in use: refused, nothing written" (($r.Code -ne 0) -and (Test-Empty $d) -and ($r.Out -match "already named"))

# 6. full start: setup gets the answers by name, not on the command line
$d = Join-Path $T "i8"
Remove-Item $env:DOCKER_LOG -ErrorAction SilentlyContinue
$r = Invoke-Installer $d @{ DPM_CUSTODY_NO_START = $null; SETUP_PLATFORM_URL = "http://localhost:8086"; SETUP_BUILDER_KEY = "bld_sk_secret" }
$log = Get-Content $env:DOCKER_LOG -Raw
Check "start: compose up ran" ($log -match "compose --env-file .env -f compose.yml up -d")
Check "start: setup gets both answers by name" ($log -match "exec -e SETUP_INSTALL_SECONDS -e SETUP_PLATFORM_URL -e SETUP_BUILDER_KEY setup node dist/setup/main setup")
Check "start: the key is not on any command line" ($log -notmatch "bld_sk_secret")

# 7. re-run on an existing install keeps .env and starts it
$before = Get-FileHash "$d/.env"
$r = Invoke-Installer $d @{ DPM_CUSTODY_NAME = "something-else"; DPM_CUSTODY_MANAGER_PORT = "1" }
Check "re-run: exits 0, ignores name and port" ($r.Code -eq 0)
Check "re-run: .env byte-identical" ((Get-FileHash "$d/.env").Hash -eq $before.Hash)

Remove-Item $T -Recurse -Force
if ($script:Fails -eq 0) { Write-Host "all passed" } else { Write-Host "$($script:Fails) failed"; exit 1 }
