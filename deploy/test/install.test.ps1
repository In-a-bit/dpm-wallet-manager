# Re-runnable checks for deploy/install.ps1: options (name, port, setup answers), NO_START and the
# existing-install re-run. A `docker` shim on PATH answers instead of Docker, so no container runs.
# The shim is a shell script, so this runs under PowerShell 7 on Linux or macOS, e.g. from the
# repo root:
#   docker run --rm -v "$PWD:/repo:ro" mcr.microsoft.com/powershell:lts-7.4-ubuntu-22.04 \
#     pwsh -NoProfile -File /repo/deploy/test/install.test.ps1
# It needs openssl and sh on PATH (to sign the throwaway release, like CI does, and to embed a key).
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

# A throwaway signing key pair, and a second one for a signature by the wrong key. The installer
# checks SHA256SUMS.sig against key.pub through DPM_CUSTODY_RELEASE_PUBKEY. Signed with openssl
# (DER ECDSA over SHA-256), as CI does, so this also proves the DER -> .NET signature conversion.
$Key = Join-Path $T "key.pem"; $PubKey = Join-Path $T "key.pub"; $Other = Join-Path $T "other.pem"
openssl ecparam -name prime256v1 -genkey -noout -out $Key 2>$null
openssl pkey -in $Key -pubout -out $PubKey
openssl ecparam -name prime256v1 -genkey -noout -out $Other 2>$null
function Sign-Release($keyFile = $Key) {
  openssl dgst -sha256 -sign $keyFile -out (Join-Path $Rel "SHA256SUMS.sig") (Join-Path $Rel "SHA256SUMS")
}
Sign-Release

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
# icacls shim (Windows only in real life): logs its arguments; ICACLS_FAIL=1 makes it fail.
Set-Content (Join-Path $Bin "icacls") @'
#!/bin/sh
echo "$* size=$(wc -c <"$1")" >>"$ICACLS_LOG"
[ "$ICACLS_FAIL" = 1 ] && exit 5
exit 0
'@
chmod +x (Join-Path $Bin "icacls")
$env:ICACLS_LOG = Join-Path $T "icacls.log"
$env:PATH = "$Bin$([System.IO.Path]::PathSeparator)$env:PATH"
$env:DOCKER_LOG = Join-Path $T "docker.log"

function Get-FreePort {
  $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $l.Start(); $p = $l.LocalEndpoint.Port; $l.Stop(); $p
}
$Port = Get-FreePort

# Runs the installer in a child pwsh (it calls exit) with the given variables; returns its output
# and exit code. Variables not given are cleared, so cases do not leak into each other.
function Invoke-Installer($dir, [hashtable]$vars = @{}, $script = (Join-Path $Here "install.ps1")) {
  $all = @{
    DPM_CUSTODY_RELEASE_PUBKEY = $PubKey; DPM_CUSTODY_ALLOW_INSECURE = "1"
    DPM_CUSTODY_DIR = $dir; DPM_CUSTODY_RELEASES_URL = "file://$Rel"; DPM_CUSTODY_NO_START = "1"
    DPM_CUSTODY_MANAGER_PORT = "$Port"; DPM_CUSTODY_NAME = $null; DPM_CUSTODY_SOURCE = $null
    EXISTING_NAME = $null; CLAIMED_PORT = $null; SETUP_PLATFORM_URL = $null; SETUP_BUILDER_KEY = $null
    DPM_CUSTODY_ASSUME_WINDOWS = $null; ICACLS_FAIL = $null; DPM_CUSTODY_TEST_SID = $null
    DPM_CUSTODY_PUBLIC_URL = $null
  }
  foreach ($k in $vars.Keys) { $all[$k] = $vars[$k] }
  foreach ($k in $all.Keys) { [Environment]::SetEnvironmentVariable($k, $all[$k]) }
  $out = pwsh -NoProfile -File $script 2>&1 | Out-String
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

# 1b. the .env is restricted to the current user, on Windows only
$d = Join-Path $T "i1b"
Remove-Item $env:ICACLS_LOG -ErrorAction SilentlyContinue
$r = Invoke-Installer $d
Check "not Windows: icacls is not called" (-not (Test-Path $env:ICACLS_LOG))
$d = Join-Path $T "i1c"
$r = Invoke-Installer $d @{ DPM_CUSTODY_ASSUME_WINDOWS = "1"; DPM_CUSTODY_TEST_SID = "S-1-5-21-1-2-3-1001" }
$acl = Get-Content $env:ICACLS_LOG -ErrorAction SilentlyContinue
Check "windows: icacls drops inheritance and grants only the current user's SID, on .env" (($r.Code -eq 0) -and ($acl -match [regex]::Escape("$d/.env /inheritance:r /grant:r *S-1-5-21-1-2-3-1001:F")))
Check "windows: the .env is empty when it is locked down, and holds the settings afterwards" (($acl -match "size=0$") -and ((Get-Content "$d/.env") -contains "COMPOSE_PROJECT_NAME=dpm-custody"))
$d = Join-Path $T "i1d"
$r = Invoke-Installer $d @{ DPM_CUSTODY_ASSUME_WINDOWS = "1"; DPM_CUSTODY_TEST_SID = "S-1-5-21-1-2-3-1001"; ICACLS_FAIL = "1" }
Check "windows: a failing icacls stops the install, removes the .env and says a rerun is safe" (($r.Code -ne 0) -and (-not (Test-Path "$d/.env")) -and ($r.Out -match "Could not restrict") -and (($r.Out -replace '\s+', ' ') -match "running the installer again is safe"))
$d2 = Join-Path $T "i1e"
$r2 = Invoke-Installer $d2 @{ DPM_CUSTODY_ASSUME_WINDOWS = "1" }
Check "windows: an error looking up the SID also removes the empty .env" (($r2.Code -ne 0) -and (-not (Test-Path "$d2/.env")))
$r = Invoke-Installer $d @{ DPM_CUSTODY_ASSUME_WINDOWS = "1"; DPM_CUSTODY_TEST_SID = "S-1-5-21-1-2-3-1001" }
Check "windows: running it again over the incomplete folder succeeds" (($r.Code -eq 0) -and (Test-Path "$d/.env"))

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
$d = Join-Path $T "i6u"
$r = Invoke-Installer $d @{ DPM_CUSTODY_PUBLIC_URL = "https://custody.example.com/" }
Check "public URL: written to .env without the trailing slash" (($r.Code -eq 0) -and ((Get-Content (Join-Path $d ".env")) -contains "MANAGER_PUBLIC_URL=https://custody.example.com"))
$d = Join-Path $T "i6v"
$r = Invoke-Installer $d @{ DPM_CUSTODY_PUBLIC_URL = "custody.example.com" }
Check "public URL without http(s): refused, nothing written" (($r.Code -ne 0) -and (Test-Empty $d) -and ($r.Out -match "must start with http"))
$d = Join-Path $T "i6w"
$r = Invoke-Installer $d @{ DPM_CUSTODY_PUBLIC_URL = "https://x`nEVIL=1" }
Check "public URL with a line break: refused, nothing written" (($r.Code -ne 0) -and (Test-Empty $d) -and ($r.Out -match "plain address"))
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

# 8. signatures and transport. Every refusal writes nothing.
Copy-Item (Join-Path $Rel "SHA256SUMS") (Join-Path $T "signed.sums"); Copy-Item (Join-Path $Rel "SHA256SUMS.sig") (Join-Path $T "signed.sig")
function Restore-Release { Copy-Item (Join-Path $T "signed.sums") (Join-Path $Rel "SHA256SUMS") -Force; Copy-Item (Join-Path $T "signed.sig") (Join-Path $Rel "SHA256SUMS.sig") -Force }

Remove-Item (Join-Path $Rel "SHA256SUMS"), (Join-Path $Rel "SHA256SUMS.sig")
$d = Join-Path $T "s1"; $r = Invoke-Installer $d
Check "missing SHA256SUMS: refused, nothing written" (($r.Code -ne 0) -and (Test-Empty $d) -and ($r.Out -match "SHA256SUMS"))
Restore-Release; Remove-Item (Join-Path $Rel "SHA256SUMS.sig")
$d = Join-Path $T "s2"; $r = Invoke-Installer $d
Check "missing signature: refused, nothing written" (($r.Code -ne 0) -and (Test-Empty $d) -and ($r.Out -match "SHA256SUMS.sig"))
Restore-Release; Sign-Release $Other
$d = Join-Path $T "s3"; $r = Invoke-Installer $d
Check "signature by another key: refused, nothing written" (($r.Code -ne 0) -and (Test-Empty $d) -and ($r.Out -match "does not match"))
Restore-Release; [System.IO.File]::WriteAllBytes((Join-Path $Rel "SHA256SUMS.sig"), [byte[]](1,2,3))
$d = Join-Path $T "s4"; $r = Invoke-Installer $d
Check "garbage signature: refused, nothing written" (($r.Code -ne 0) -and (Test-Empty $d) -and ($r.Out -match "does not match"))
Restore-Release; Add-Content (Join-Path $Rel "SHA256SUMS") ("0" * 64 + "  extra")
$d = Join-Path $T "s5"; $r = Invoke-Installer $d
Check "SHA256SUMS changed after signing: refused, nothing written" (($r.Code -ne 0) -and (Test-Empty $d) -and ($r.Out -match "does not match"))
Restore-Release
$d = Join-Path $T "s6"; $r = Invoke-Installer $d @{ DPM_CUSTODY_ALLOW_INSECURE = $null }
Check "file:// refused without DPM_CUSTODY_ALLOW_INSECURE" (($r.Code -ne 0) -and (Test-Empty $d) -and ($r.Out -match "Refusing to download"))
$d = Join-Path $T "s7"; $r = Invoke-Installer $d @{ DPM_CUSTODY_ALLOW_INSECURE = $null; DPM_CUSTODY_RELEASES_URL = "http://example.test/rel" }
Check "http:// refused without DPM_CUSTODY_ALLOW_INSECURE" (($r.Code -ne 0) -and (Test-Empty $d) -and ($r.Out -match "https:// only"))
# An installer still carrying the placeholder key (no override) verifies nothing.
$ph = Join-Path $T "placeholder"; New-Item -ItemType Directory $ph | Out-Null
(Get-Content (Join-Path $Here "install.ps1") -Raw) -replace '(?m)^\$ReleaseKeyIsPlaceholder = \$false', '$ReleaseKeyIsPlaceholder = $true' |
  Set-Content -NoNewline (Join-Path $ph "install.ps1")
$d = Join-Path $T "s8"; $r = Invoke-Installer $d @{ DPM_CUSTODY_RELEASE_PUBKEY = $null } (Join-Path $ph "install.ps1")
Check "placeholder embedded key: refused, and says why" (($r.Code -ne 0) -and (Test-Empty $d) -and ($r.Out -match "placeholder release key"))
# Embedding a real key (scripts/embed-release-key.sh) makes it the one that counts.
$emb = Join-Path $T "embedded"; New-Item -ItemType Directory $emb | Out-Null
foreach ($f in "install.sh", "install.ps1", "dpm-custody") { Copy-Item (Join-Path $Here $f) (Join-Path $emb $f) }
$env:DEPLOY_DIR = $emb
sh (Join-Path $Here "../scripts/embed-release-key.sh") $PubKey | Out-Null
$env:DEPLOY_DIR = $null
$d = Join-Path $T "s9"; $r = Invoke-Installer $d @{ DPM_CUSTODY_RELEASE_PUBKEY = $null } (Join-Path $emb "install.ps1")
Check "embedded real key verifies a release signed with its private half" (($r.Code -eq 0) -and (Test-Path "$d/.env"))
Sign-Release $Other
$d = Join-Path $T "s10"; $r = Invoke-Installer $d @{ DPM_CUSTODY_RELEASE_PUBKEY = $null } (Join-Path $emb "install.ps1")
Check "embedded real key rejects a release signed by another key" (($r.Code -ne 0) -and (Test-Empty $d))
Restore-Release

Remove-Item $T -Recurse -Force
if ($script:Fails -eq 0) { Write-Host "all passed" } else { Write-Host "$($script:Fails) failed"; exit 1 }
