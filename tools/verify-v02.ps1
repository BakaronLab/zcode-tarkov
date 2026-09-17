#Requires -Version 5.1
<#
  verify-v02.ps1 - end-to-end acceptance harness for the v0.2 injected client.

  It proves against a real isolated ZCode instance that the v0.2 client (the
  bundle injected by `serve`) actually works: injection and idempotence, clean
  teardown, the banner reservation invariant in all three modes, the media
  library and its byte-range streaming, the dock, the pet, the settings centre,
  the recolourable palette and the editable greeting text; and it captures the
  screenshots the README embeds.

  The user's real ZCode instance is running and must never be restarted, killed
  or written to. This harness therefore launches a second instance with its own
  Chromium profile AND its own ZCode home, and copies the six credential files
  so the instance can render a real chat surface. Everything it writes lives
  under $env:TEMP except the screenshots and the evidence JSON, which are
  repository artifacts at the paths below.

  Fail-closed guards: refuses to run unless every scratch path is under
  $env:TEMP and outside the repository; refuses a busy CDP or API port unless a
  free one can be chosen; closes the instance only through its own CDP
  Browser.close and, if it survives, by stopping only processes whose command
  line carries BOTH the scratch profile path and the CDP port; stops only the
  node process whose command line carries this run's --api-port.

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\verify-v02.ps1
    powershell ... -CdpPort 9544 -ApiPort 9533 -KeepTemp -Width 1440 -Height 900

  Outputs:
    docs/images/v02/01-tarkov-main.png ... 09-greeting-custom.png
    docs/images/v02/verify-v02-evidence.json

  Exit codes: 0 every check passed, 1 at least one assertion failed, 2 the
  harness refused to run (safety guard or a missing prerequisite).
#>
[CmdletBinding()]
param(
    [string]$SourceDir = '',
    [int]$CdpPort = 0,
    [int]$ApiPort = 0,
    [int]$Width = 1440,
    [int]$Height = 900,
    [switch]$KeepTemp
)

$ErrorActionPreference = 'Continue'
$script:failures = New-Object System.Collections.ArrayList
$script:driverChecks = New-Object System.Collections.ArrayList

function Note {
    param([string]$Text)
    Write-Host ('[note] ' + $Text)
}

function Fail-Step {
    param([string]$Text)
    [void]$script:failures.Add($Text)
    Write-Host ('[FAIL] ' + $Text)
}

function Add-DriverCheck {
    param([string]$Name, [string]$Expectation, $Observed, [bool]$Pass, [string]$Reason = '')
    $rec = [ordered]@{ name = $Name; expectation = $Expectation; observed = $Observed; pass = $Pass; status = $(if ($Pass) { 'pass' } else { 'fail' }) }
    if ($Reason) { $rec.reason = $Reason; $rec.status = 'not-tested' }
    [void]$script:driverChecks.Add($rec)
    if (-not $Pass -and -not $Reason) { Write-Host ('[FAIL] ' + $Name + ' expected=' + $Expectation) }
}

$repo = $SourceDir
if ([string]::IsNullOrWhiteSpace($repo)) { $repo = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')) }
try { $repo = [System.IO.Path]::GetFullPath($repo) } catch { }

$tempRoot = [System.IO.Path]::GetFullPath($env:TEMP)
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
$T = Join-Path $tempRoot ('zct-verify-v02-' + $stamp)

# ---------------------------------------------------------------- safety ----
# Every path this harness writes must be under $TEMP; the two repository paths
# (screenshots, evidence JSON) are the only exceptions and are named here.
$guardTargets = [ordered]@{
    root        = $T
    logs        = Join-Path $T 'logs'
    appdata     = Join-Path $T 'appdata'
    userhome    = Join-Path $T 'userhome'
    home        = Join-Path $T 'home'
    zcodeHome   = Join-Path $T 'home\.zcode'
    profile     = Join-Path $T 'zcode-profile'
    session     = Join-Path $T 'zcode-session'
    beautify    = Join-Path $T 'plugin-data'
    userdata    = Join-Path $T 'userdata'
    screenshots = Join-Path $T 'screenshots'
}
$blocked = @(
    [System.IO.Path]::GetFullPath((Join-Path $env:USERPROFILE 'Desktop')),
    [System.IO.Path]::GetFullPath((Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu')),
    [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs\zcode-tarkov')),
    [System.IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.zcode')),
    $repo
)
$guardMessages = @()
foreach ($key in $guardTargets.Keys) {
    $p = [System.IO.Path]::GetFullPath($guardTargets[$key])
    if (-not $p.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        $guardMessages += ($key + '=' + $p + ' is NOT under TEMP (' + $tempRoot + ')')
    }
    foreach ($b in $blocked) {
        if ($p.Equals($b, [System.StringComparison]::OrdinalIgnoreCase) -or $p.StartsWith($b + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
            $guardMessages += ($key + '=' + $p + ' is inside ' + $b)
        }
    }
}
if ($guardMessages.Count -gt 0) {
    Write-Host 'REFUSING TO RUN: the harness would write outside its scratch tree.'
    foreach ($m in $guardMessages) { Write-Host ('  - ' + $m) }
    exit 2
}

$outDir = Join-Path $repo 'docs\images\v02'
$finalEvidencePath = Join-Path $outDir 'verify-v02-evidence.json'
$rendererEvidencePath = Join-Path $T 'verify-v02-mjs-evidence.json'
$required = @('dist\cli.js', 'dist\client.js', 'tools\verify-v02.mjs', 'tools\measure-layout.mjs', 'src\themes\palette.ts', 'src\core\banner.ts')
foreach ($rel in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $repo $rel) -PathType Leaf)) {
        Write-Host ('REFUSING TO RUN: missing ' + (Join-Path $repo $rel))
        if ($rel -eq 'dist\client.js') { Write-Host '  run: npm run bundle' }
        exit 2
    }
}
$zcodeExe = 'C:\Program Files\ZCode\ZCode.exe'
if (-not (Test-Path -LiteralPath $zcodeExe -PathType Leaf)) {
    Write-Host ('REFUSING TO RUN: ZCode.exe not found at ' + $zcodeExe)
    exit 2
}
$nodeExe = Join-Path ${env:ProgramFiles} 'nodejs\node.exe'
if (-not (Test-Path -LiteralPath $nodeExe -PathType Leaf)) {
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($null -eq $cmd) { Write-Host 'REFUSING TO RUN: node.exe not found'; exit 2 }
    $nodeExe = $cmd.Source
}

# The expected accent and band heights come from the source of truth, never
# from a literal here (same rule as tools/verify-clean-install.ps1).
$paletteSrc = [string](Get-Content -LiteralPath (Join-Path $repo 'src\themes\palette.ts') -Raw)
if ($paletteSrc -notmatch 'TARKOV_ACCENT\s*=\s*"(#[0-9a-fA-F]{6})"') {
    Write-Host 'REFUSING TO RUN: could not read TARKOV_ACCENT from src\themes\palette.ts'
    exit 2
}
$accent = $Matches[1]
if ($paletteSrc -notmatch 'TARKOV_BACKGROUND\s*=\s*"(#[0-9a-fA-F]{6})"') {
    Write-Host 'REFUSING TO RUN: could not read TARKOV_BACKGROUND from src\themes\palette.ts'
    exit 2
}
$background = $Matches[1]
$bannerSrc = [string](Get-Content -LiteralPath (Join-Path $repo 'src\core\banner.ts') -Raw)
$fullHeight = 0
$compactHeight = 0
if ($bannerSrc -match 'height:\s*(\d+),') { $fullHeight = [int]$Matches[1] }
if ($bannerSrc -match 'COMPACT_BANNER_HEIGHT\s*=\s*(\d+)') { $compactHeight = [int]$Matches[1] }
if ($fullHeight -le 0 -or $compactHeight -le 0) {
    Write-Host 'REFUSING TO RUN: could not read the banner heights from src\core\banner.ts'
    exit 2
}
Note ('palette accent: ' + $accent + ', background: ' + $background + '; band heights: full=' + $fullHeight + ' compact=' + $compactHeight)

# ---------------------------------------------------------------- helpers ---
function Test-PortOpen {
    param([int]$Port)
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $c.Connect('127.0.0.1', $Port)
        $c.Close()
        return $true
    } catch { return $false }
}

function Resolve-Port {
    param([int]$Wanted, [string]$Label, [int[]]$Avoid = @())
    if ($Wanted -gt 0) {
        if (Test-PortOpen $Wanted) {
            Write-Host ('REFUSING TO RUN: ' + $Label + ' ' + $Wanted + ' is already listening')
            exit 2
        }
        return $Wanted
    }
    $start = if ($Label -eq 'CDP port') { 9544 } else { 9533 }
    for ($p = $start; $p -lt ($start + 40); $p++) {
        if ($Avoid -contains $p) { continue }
        if (-not (Test-PortOpen $p)) { return $p }
    }
    Write-Host ('REFUSING TO RUN: no free ' + $Label + ' in ' + $start + '..' + ($start + 39))
    exit 2
}
$CdpPort = Resolve-Port -Wanted $CdpPort -Label 'CDP port'
$ApiPort = Resolve-Port -Wanted $ApiPort -Label 'API port' -Avoid @($CdpPort)
Note ('ports: CDP ' + $CdpPort + ', API ' + $ApiPort)

function Read-TextFile {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
    try { return [System.IO.File]::ReadAllText($Path) } catch { return '' }
}

# cmd.exe file redirection: a detached grandchild inheriting a pipe would keep
# an async reader from ever seeing EOF (the lesson recorded in the v0.1
# harness), so output goes to real files and only cmd.exe is waited for.
function Invoke-Redirected {
    param([string]$FilePath, [string[]]$Arguments, [string]$Name, [hashtable]$Env)
    $out = Join-Path $logDir ($Name + '.out.txt')
    $err = Join-Path $logDir ($Name + '.err.txt')
    $cmdPath = Join-Path $logDir ($Name + '.cmd')
    $quoted = New-Object System.Collections.ArrayList
    [void]$quoted.Add('"' + $FilePath + '"')
    foreach ($a in $Arguments) {
        if ($a -match '[\s"]') { [void]$quoted.Add('"' + ($a -replace '"', '\"') + '"') } else { [void]$quoted.Add($a) }
    }
    $lines = @('@echo off', (($quoted -join ' ') + ' > "' + $out + '" 2> "' + $err + '"'), 'exit /b %ERRORLEVEL%')
    [System.IO.File]::WriteAllLines($cmdPath, $lines, (New-Object System.Text.ASCIIEncoding))
    $saved = @{}
    foreach ($k in $Env.Keys) {
        $saved[$k] = [System.Environment]::GetEnvironmentVariable($k, 'Process')
        [System.Environment]::SetEnvironmentVariable($k, $(if ($null -eq $Env[$k]) { $null } else { [string]$Env[$k] }), 'Process')
    }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'cmd.exe'
    $psi.Arguments = '/c "' + $cmdPath + '"'
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $proc = [System.Diagnostics.Process]::Start($psi)
    $proc.WaitForExit()
    $exitCode = $proc.ExitCode
    foreach ($k in $saved.Keys) { [System.Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') }
    Start-Sleep -Milliseconds 200
    return [ordered]@{ name = $Name; exitCode = $exitCode; stdoutPath = $out; stderrPath = $err; stdout = (Read-TextFile $out); stderr = (Read-TextFile $err) }
}

function Start-WithEnv {
    param([string]$FilePath, [string]$Arguments, [hashtable]$Env, [string]$OutFile, [string]$ErrFile, [string]$WorkingDirectory = '')
    $saved = @{}
    foreach ($k in $Env.Keys) {
        $saved[$k] = [System.Environment]::GetEnvironmentVariable($k, 'Process')
        [System.Environment]::SetEnvironmentVariable($k, $(if ($null -eq $Env[$k]) { $null } else { [string]$Env[$k] }), 'Process')
    }
    try {
        $spArgs = @{ FilePath = $FilePath; ArgumentList = $Arguments; PassThru = $true }
        if ($OutFile) { $spArgs.RedirectStandardOutput = $OutFile }
        if ($ErrFile) { $spArgs.RedirectStandardError = $ErrFile }
        if ($WorkingDirectory) { $spArgs.WorkingDirectory = $WorkingDirectory }
        return (Start-Process @spArgs)
    } finally {
        foreach ($k in $saved.Keys) { [System.Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') }
    }
}

function Wait-ForHealth {
    param([int]$Port, [int]$TimeoutSec)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $Port + '/api/health') -UseBasicParsing -TimeoutSec 3
            if ($r.StatusCode -eq 200) { return $r.Content }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    return $null
}

# The CDP endpoint answers /json/version as soon as the browser process is up,
# but the renderer page target appears a moment later on a cold scratch profile.
function Wait-ForPageTarget {
    param([int]$Port, [int]$TimeoutSec)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $version = ''
    while ((Get-Date) -lt $deadline) {
        try {
            if ($version -eq '') {
                $vr = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $Port + '/json/version') -UseBasicParsing -TimeoutSec 3
                if ($vr.StatusCode -eq 200) { $version = $vr.Content }
            }
            $lr = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $Port + '/json/list') -UseBasicParsing -TimeoutSec 3
            if ($lr.StatusCode -eq 200) {
                $targets = @(ConvertFrom-Json $lr.Content)
                $pages = @($targets | Where-Object { $_.type -eq 'page' })
                if ($pages.Count -gt 0) { return [ordered]@{ version = $version; pageCount = $pages.Count; targetCount = $targets.Count; pages = $pages } }
            }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    return [ordered]@{ version = $version; pageCount = 0; targetCount = 0; pages = @() }
}

function Get-ScratchZcodeProcesses {
    $result = New-Object System.Collections.ArrayList
    try {
        $all = @(Get-CimInstance Win32_Process -Filter "Name = 'ZCode.exe'" -ErrorAction SilentlyContinue)
        foreach ($item in $all) {
            if ($item.CommandLine -and $item.CommandLine.Contains('--remote-debugging-port=' + $CdpPort) -and $item.CommandLine.Contains($profileDir)) {
                [void]$result.Add($item)
            }
        }
    } catch { }
    return ,$result.ToArray()
}

function Get-ServeProcesses {
    # Identity is this run's API port plus the CLI entry point: the port was
    # proven free before the service started, so a process carrying it is ours.
    $result = New-Object System.Collections.ArrayList
    try {
        $all = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue)
        foreach ($item in $all) {
            if ($item.CommandLine -and $item.CommandLine.Contains('--api-port ' + $ApiPort) -and $item.CommandLine.Contains('cli.js')) {
                [void]$result.Add($item)
            }
        }
    } catch { }
    return ,$result.ToArray()
}

function Get-CredentialStamp {
    param([string]$Dir)
    $out = [ordered]@{ dir = $Dir; files = [ordered]@{}; missing = @() }
    foreach ($name in $script:credFiles) {
        $file = Join-Path $Dir $name
        if (Test-Path -LiteralPath $file -PathType Leaf) {
            $item = Get-Item -LiteralPath $file
            $out.files[$name] = [ordered]@{ size = $item.Length; mtimeUtc = $item.LastWriteTimeUtc.ToString('o') }
        } else {
            $out.missing += $name
        }
    }
    return $out
}

function Compare-CredentialStamp {
    param($Before, $After)
    $diffs = New-Object System.Collections.ArrayList
    foreach ($name in $script:credFiles) {
        $b = $Before.files[$name]
        $a = $After.files[$name]
        if ($null -eq $b -and $null -eq $a) { continue }
        if ($null -eq $b -or $null -eq $a) { [void]$diffs.Add($name + ': existence changed'); continue }
        if ([int64]$b.size -ne [int64]$a.size) { [void]$diffs.Add($name + ': size ' + $b.size + ' -> ' + $a.size) }
        if ([string]$b.mtimeUtc -ne [string]$a.mtimeUtc) { [void]$diffs.Add($name + ': mtime ' + $b.mtimeUtc + ' -> ' + $a.mtimeUtc) }
    }
    return $diffs.ToArray()
}

$script:credFiles = @('credentials.json', 'provider_config.json', 'config.json', 'setting.json', 'model-provider-display-order.json', 'coding-plan-cache.json')

# ------------------------------------------------------------ scratch tree --
foreach ($d in $guardTargets.Values) {
    if (-not (Test-Path -LiteralPath $d -PathType Container)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}
$logDir = [System.IO.Path]::GetFullPath($guardTargets.logs)
$appdataDir = [System.IO.Path]::GetFullPath($guardTargets.appdata)
$userhomeDir = [System.IO.Path]::GetFullPath($guardTargets.userhome)
$homeDir = [System.IO.Path]::GetFullPath($guardTargets.home)
$zcodeHomeDir = [System.IO.Path]::GetFullPath($guardTargets.zcodeHome)
$profileDir = [System.IO.Path]::GetFullPath($guardTargets.profile)
$sessionDir = [System.IO.Path]::GetFullPath($guardTargets.session)
$beautifyDir = [System.IO.Path]::GetFullPath($guardTargets.beautify)
$userdataDir = [System.IO.Path]::GetFullPath($guardTargets.userdata)
New-Item -ItemType Directory -Path (Join-Path $zcodeHomeDir 'v2') -Force | Out-Null
New-Item -ItemType Directory -Path $outDir -Force | Out-Null

Write-Host ('[harness] scratch root: ' + $T)
Write-Host ('[harness] repo:         ' + $repo)

$startedAt = (Get-Date).ToUniversalTime().ToString('o')
$servePid = 0
$zcodePid = 0
$mjs = $null
$closeResult = $null
$cdpVersionRaw = ''

# ------------------------------------------------- stage 0: baseline --------
Write-Host ''
Write-Host '=== stage 0: baseline (real credential stamps, real ZCode pids) ==='
$realHome = Join-Path $env:USERPROFILE '.zcode\v2'
$beforeStamp = Get-CredentialStamp -Dir $realHome
$baselineZcodePids = @(Get-Process -Name ZCode -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id | Sort-Object)
Write-Host ('[baseline] real credential files present: ' + $beforeStamp.files.Count + '/' + $script:credFiles.Count + $(if ($beforeStamp.missing.Count -gt 0) { ' (missing: ' + ($beforeStamp.missing -join ', ') + ')' } else { '' }))
Write-Host ('[baseline] real ZCode.exe processes: ' + $baselineZcodePids.Count)

# ------------------------------------------------- stage 1: scratch ---------
Write-Host ''
Write-Host '=== stage 1: credential-copied scratch home ==='
$copied = @()
$skipped = @()
foreach ($name in $script:credFiles) {
    $from = Join-Path $realHome $name
    $to = Join-Path (Join-Path $zcodeHomeDir 'v2') $name
    if (Test-Path -LiteralPath $from -PathType Leaf) {
        Copy-Item -LiteralPath $from -Destination $to -Force
        $copied += $name
    } else {
        $skipped += $name
    }
}
$credEvidence = [ordered]@{ source = $realHome; destination = (Join-Path $zcodeHomeDir 'v2'); copied = $copied; skipped = $skipped }
Write-Host ('[creds] copied ' + $copied.Count + '/' + $script:credFiles.Count + $(if ($skipped.Count -gt 0) { ' (skipped: ' + ($skipped -join ', ') + ')' } else { '' }))
if ($copied.Count -eq 0) {
    Write-Host 'REFUSING TO RUN: no credential file could be copied; the instance would boot to the login screen'
    exit 2
}

# ------------------------------------------------- stage 1b: privacy scrub --
# The copied setting.json carries the real client's recentProjects and
# lastWorkspaceSession history, and the isolated instance renders that list in
# its sidebar; an unscrubbed capture would publish the owner's private project
# names. That history is UI state the turn does not need, so it is blanked in
# the SCRATCH copy only - the real file is never written. The scrub also walks
# every copied file for local filesystem paths and reports the key paths (never
# the values), so a future leak is visible in the evidence rather than assumed
# away. Node is used for exact JSON semantics.
Write-Host ''
Write-Host '=== stage 1b: privacy scrub of the scratch history ==='
$scrubSource = @'
const fs = require('fs');
const path = require('path');
const dir = process.argv[2];
const files = process.argv.slice(3);
const CLEAR = { 'setting.json': ['recentProjects', 'lastWorkspaceSession'] };
const report = { files: {}, cleared: [], localPathHits: [] };
function isLocalPath(v) { return typeof v === 'string' && (/^[A-Za-z]:[\\/]/.test(v) || /^\\\\/.test(v)); }
function walk(value, keyPath, file, depth) {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value === 'string') { if (isLocalPath(value)) report.localPathHits.push({ file: file, key: keyPath }); return; }
  if (Array.isArray(value)) { for (let i = 0; i < value.length; i += 1) walk(value[i], keyPath + '[]', file, depth + 1); return; }
  if (typeof value === 'object') {
    for (const k of Object.keys(value)) walk(value[k], keyPath ? keyPath + '.' + k : k, file, depth + 1);
  }
}
for (const name of files) {
  const file = path.join(dir, name);
  let doc = null;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { report.files[name] = { parsed: false }; continue; }
  report.files[name] = { parsed: true, topLevelKeys: Object.keys(doc).length };
  const clearKeys = CLEAR[name] || [];
  for (const key of clearKeys) {
    if (Array.isArray(doc[key])) {
      report.cleared.push({ file: name, key: key, before: doc[key].length, after: 0 });
      if (doc[key].length > 0) doc[key] = [];
    }
  }
  if (clearKeys.length > 0) fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  // Scanned after the scrub, so what is reported is what the instance can still
  // read: a local path surviving anywhere else in the copied config.
  walk(doc, '', name, 0);
}
process.stdout.write(JSON.stringify(report));
'@
$scrubPath = Join-Path $logDir 'scrub-history.cjs'
[System.IO.File]::WriteAllText($scrubPath, $scrubSource, (New-Object System.Text.ASCIIEncoding))
$scrubArgs = @($scrubPath, (Join-Path $zcodeHomeDir 'v2')) + $copied
$scrub = Invoke-Redirected -FilePath $nodeExe -Arguments $scrubArgs -Name 'scrub-history' -Env @{}
Write-Host ('[scrub] exit code: ' + $scrub.exitCode)
$scrubReport = $null
try { $scrubReport = $scrub.stdout.Trim() | ConvertFrom-Json } catch { Fail-Step ('could not parse the scrub report: ' + $_.Exception.Message) }
if ($null -eq $scrubReport) {
    Fail-Step 'the privacy scrub produced no report'
} else {
    Write-Host ('[scrub] cleared: ' + (($scrubReport.cleared | ForEach-Object { $_.file + ':' + $_.key + ' ' + $_.before + ' -> ' + $_.after }) -join '; '))
    $historyKeys = @('recentProjects', 'lastWorkspaceSession')
    $historyCleared = @($scrubReport.cleared | Where-Object { $historyKeys -contains $_.key })
    $settingCopy = Join-Path (Join-Path $zcodeHomeDir 'v2') 'setting.json'
    if (-not (Test-Path -LiteralPath $settingCopy -PathType Leaf)) {
        Add-DriverCheck -Name 'driver.scratch-history-scrubbed' -Expectation 'the scratch setting.json has empty recentProjects and lastWorkspaceSession before launch' -Observed @{ settingPresent = $false } -Pass $false -Reason 'the real store has no setting.json to copy, so there was no history to scrub'
    } else {
        Add-DriverCheck -Name 'driver.scratch-history-scrubbed' -Expectation 'the scratch setting.json has empty recentProjects and lastWorkspaceSession before launch' -Observed @{ cleared = $scrubReport.cleared; settingParsed = [bool]$scrubReport.files.'setting.json'.parsed } -Pass ($historyCleared.Count -eq $historyKeys.Count -and @($historyCleared | Where-Object { [int]$_.after -ne 0 }).Count -eq 0)
    }
    $localHits = @($scrubReport.localPathHits)
    Add-DriverCheck -Name 'driver.no-local-paths-in-copied-config' -Expectation 'no copied credential file carries a local filesystem path string' -Observed @{ localPathHits = $localHits; files = $scrubReport.files } -Pass ($localHits.Count -eq 0)
    foreach ($h in $localHits) { Note ('copied config carries a local path at ' + $h.file + ' key ' + $h.key + ' (the value is not recorded)') }
}

$instanceEnv = @{
    APPDATA                        = $appdataDir
    USERPROFILE                    = $userhomeDir
    HOME                           = $homeDir
    ZCODE_HOME                     = $zcodeHomeDir
    ZCODE_DATA_BASE_DIR            = $homeDir
    ZCODE_DESKTOP_HOME_DIR         = $zcodeHomeDir
    ZCODE_DESKTOP_USER_DATA_DIR    = $profileDir
    ZCODE_DESKTOP_SESSION_DATA_DIR = $sessionDir
    ZCODE_BEAUTIFY_DATA_DIR        = $beautifyDir
    ZCODE_TARKOV_DATA_DIR          = $userdataDir
}

# ------------------------------------------------- stage 2: service ---------
Write-Host ''
Write-Host '=== stage 2: start the repository service (serve) ==='
$serveArgs = '"' + (Join-Path $repo 'dist\cli.js') + '" serve --port ' + $CdpPort + ' --api-port ' + $ApiPort
$serveProc = Start-WithEnv -FilePath $nodeExe -Arguments $serveArgs -Env $instanceEnv -OutFile (Join-Path $logDir 'serve.out.txt') -ErrFile (Join-Path $logDir 'serve.err.txt') -WorkingDirectory $repo
$servePid = $serveProc.Id
Note ('serve started: pid ' + $servePid + ' (CDP ' + $CdpPort + ', API ' + $ApiPort + ')')
$health = Wait-ForHealth -Port $ApiPort -TimeoutSec 30
if ($health) {
    Note ('service health: ' + $health)
    Add-DriverCheck -Name 'driver.service-healthy' -Expectation 'the repository serve answers /api/health within 30s' -Observed $health -Pass $true
} else {
    Fail-Step ('the service never answered on http://127.0.0.1:' + $ApiPort + '/api/health')
    Add-DriverCheck -Name 'driver.service-healthy' -Expectation 'the repository serve answers /api/health within 30s' -Observed 'no answer' -Pass $false
    Write-Host '----- serve stdout -----'
    Write-Host (Read-TextFile (Join-Path $logDir 'serve.out.txt'))
    Write-Host '----- serve stderr -----'
    Write-Host (Read-TextFile (Join-Path $logDir 'serve.err.txt'))
}

# ------------------------------------------------- stage 3: instance --------
Write-Host ''
Write-Host '=== stage 3: launch the isolated ZCode instance ==='
$zcodeArgs = '--remote-debugging-port=' + $CdpPort + ' --user-data-dir="' + $profileDir + '"'
$zcodeProc = Start-WithEnv -FilePath $zcodeExe -Arguments $zcodeArgs -Env $instanceEnv -OutFile (Join-Path $logDir 'zcode.out.txt') -ErrFile (Join-Path $logDir 'zcode.err.txt') -WorkingDirectory $T
$zcodePid = $zcodeProc.Id
Note ('ZCode started: pid ' + $zcodePid + ' --user-data-dir=' + $profileDir)
$cdpReady = Wait-ForPageTarget -Port $CdpPort -TimeoutSec 90
$cdpVersionRaw = $cdpReady.version
if ($cdpReady.pageCount -lt 1) {
    Fail-Step ('no CDP page target appeared on http://127.0.0.1:' + $CdpPort + '/json/list within 90s')
} else {
    Note ('CDP page target up (' + $cdpReady.pageCount + ' page target(s), ' + $cdpReady.targetCount + ' target(s) total)')
}

# ------------------------------------------------- stage 4: renderer --------
Write-Host ''
Write-Host '=== stage 4: renderer + API acceptance (tools\verify-v02.mjs) ==='
$verifyArgs = @(
    (Join-Path $repo 'tools\verify-v02.mjs'),
    '--port', [string]$CdpPort,
    '--api-port', [string]$ApiPort,
    '--out-dir', $outDir,
    '--evidence', $rendererEvidencePath,
    '--scratch', $T,
    '--data-dir', $userdataDir,
    '--repo', $repo,
    '--width', [string]$Width,
    '--height', [string]$Height,
    '--accent', $accent,
    '--background', $background,
    '--full-height', [string]$fullHeight,
    '--compact-height', [string]$compactHeight
)
$verify = Invoke-Redirected -FilePath $nodeExe -Arguments $verifyArgs -Name 'verify-v02' -Env @{}
Write-Host ('[renderer] exit code: ' + $verify.exitCode)
Write-Host ('[renderer] ' + $verify.stdout.Trim())
if ($verify.stderr -and $verify.stderr.Trim().Length -gt 0) { Write-Host ('[renderer] stderr: ' + $verify.stderr.Trim()) }
if (Test-Path -LiteralPath $rendererEvidencePath -PathType Leaf) {
    try { $mjs = (Read-TextFile $rendererEvidencePath) | ConvertFrom-Json } catch { Fail-Step ('cannot parse the renderer evidence: ' + $_.Exception.Message) }
} else {
    Fail-Step 'the renderer half wrote no evidence file'
}
if ($verify.exitCode -eq 2) { Fail-Step 'the renderer half refused to run (see its output above)' }

# ------------------------------------------------- stage 5: close -----------
Write-Host ''
Write-Host '=== stage 5: close the scratch instance (the real one is never touched) ==='
$closeArgs = @((Join-Path $repo 'tools\verify-v02.mjs'), '--mode', 'close', '--port', [string]$CdpPort, '--evidence', (Join-Path $logDir 'cdp-close.json'))
$close = Invoke-Redirected -FilePath $nodeExe -Arguments $closeArgs -Name 'verify-v02-close' -Env @{}
Write-Host ('[close] exit code: ' + $close.exitCode + ' ' + $close.stdout.Trim())
$closeResult = $close.stdout.Trim()
$closedDeadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $closedDeadline -and (Test-PortOpen -Port $CdpPort)) { Start-Sleep -Milliseconds 500 }
$leftover = Get-ScratchZcodeProcesses
if (@($leftover).Count -gt 0) {
    Note ('stopping ' + @($leftover).Count + ' ZCode.exe process(es) whose command line carries BOTH the scratch profile and --remote-debugging-port=' + $CdpPort)
    foreach ($pr in $leftover) { Write-Host ('  pid ' + $pr.ProcessId + ' : ' + $pr.CommandLine) }
    foreach ($pr in $leftover) { Stop-Process -Id $pr.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 5
}
$leftoverAfter = Get-ScratchZcodeProcesses
if (@($leftoverAfter).Count -gt 0) { Fail-Step (@($leftoverAfter).Count.ToString() + ' scratch ZCode.exe process(es) survived Browser.close and the targeted stop') }
if (Test-PortOpen -Port $CdpPort) { Fail-Step ('the scratch CDP port ' + $CdpPort + ' is still open after the close') } else { Note 'scratch CDP port is closed' }
Add-DriverCheck -Name 'driver.instance-closed' -Expectation 'the isolated instance is gone and its CDP port is closed' -Observed @{ leftoverPids = @($leftoverAfter | ForEach-Object { $_.ProcessId }); portOpen = (Test-PortOpen -Port $CdpPort) } -Pass ($leftoverAfter.Count -eq 0 -and -not (Test-PortOpen -Port $CdpPort))

# ------------------------------------------------- stage 6: stop serve ------
Write-Host ''
Write-Host '=== stage 6: stop the service this harness started ==='
$serveLeft = Get-ServeProcesses
foreach ($pr in $serveLeft) {
    Note ('stopping node pid ' + $pr.ProcessId + ' (--api-port ' + $ApiPort + ')')
    Stop-Process -Id $pr.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 3
$serveLeftAfter = Get-ServeProcesses
$serveStillServing = Wait-ForHealth -Port $ApiPort -TimeoutSec 5
if (@($serveLeftAfter).Count -gt 0 -or $serveStillServing) {
    Fail-Step ('the service is still up after the stop (' + @($serveLeftAfter).Count + ' process(es), health=' + [string]([bool]$serveStillServing) + ')')
} else {
    Note 'service stopped and its API port is quiet'
}
Add-DriverCheck -Name 'driver.service-stopped' -Expectation 'the serve process started by this harness is stopped' -Observed @{ pids = @($serveLeft | ForEach-Object { $_.ProcessId }); remaining = @($serveLeftAfter | ForEach-Object { $_.ProcessId }); healthAnswered = [bool]$serveStillServing } -Pass (@($serveLeftAfter).Count -eq 0 -and -not $serveStillServing)

# ------------------------------------------------- stage 7: tripwire --------
Write-Host ''
Write-Host '=== stage 7: real-profile tripwire ==='
$afterStamp = Get-CredentialStamp -Dir $realHome
$credDiffs = Compare-CredentialStamp -Before $beforeStamp -After $afterStamp
$afterZcodePids = @(Get-Process -Name ZCode -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id | Sort-Object)
$missingPids = @($baselineZcodePids | Where-Object { $afterZcodePids -notcontains $_ })
if ($missingPids.Count -gt 0) {
    Fail-Step ('real ZCode.exe pid(s) disappeared during the run: ' + ($missingPids -join ','))
} else {
    Note ('all ' + $baselineZcodePids.Count + ' baseline ZCode.exe pids survived')
}
if ($credDiffs.Count -eq 0) {
    Note 'real credential files unchanged (size + mtime)'
    Add-DriverCheck -Name 'driver.real-profile-untouched' -Expectation 'the six real credential files are unchanged (size + mtime)' -Observed @{ diffs = @(); before = $beforeStamp; after = $afterStamp } -Pass $true
} else {
    $nonSetting = @($credDiffs | Where-Object { $_ -notmatch '^setting\.json:' })
    if ($nonSetting.Count -eq 0) {
        Add-DriverCheck -Name 'driver.real-profile-untouched' -Expectation 'the six real credential files are unchanged (size + mtime)' -Observed @{ diffs = $credDiffs; before = $beforeStamp; after = $afterStamp } -Pass $false -Reason 'setting.json changed while the isolated instance ran; the real client persists window/session state there (docs/dev/zcode-runtime-signals.md section 1.1) and this harness cannot attribute the write'
        Note ('tripwire: setting.json changed (recorded as not-tested): ' + ($credDiffs -join '; '))
    } else {
        Fail-Step ('real credential files changed: ' + ($credDiffs -join '; '))
        Add-DriverCheck -Name 'driver.real-profile-untouched' -Expectation 'the six real credential files are unchanged (size + mtime)' -Observed @{ diffs = $credDiffs } -Pass $false
    }
}

# ------------------------------------------------- evidence + cleanup ------
$screenshotRecords = @()
$rendererSummary = $null
$rendererChecks = @()
if ($mjs) {
    if ($mjs.screenshots) { $screenshotRecords = @($mjs.screenshots) }
    if ($mjs.summary) { $rendererSummary = $mjs.summary }
    if ($mjs.checks) { $rendererChecks = @($mjs.checks) }
}
$allChecks = @()
foreach ($c in $rendererChecks) { $allChecks += $c }
foreach ($c in $script:driverChecks) { $allChecks += $c }
$passed = @($allChecks | Where-Object { $_.status -eq 'pass' }).Count
$failed = @($allChecks | Where-Object { $_.status -eq 'fail' }).Count
$notTestedCount = @($allChecks | Where-Object { $_.status -eq 'not-tested' }).Count

$evidence = [ordered]@{
    tool = 'tools/verify-v02.ps1'
    journey = 'v0.2 client: isolated credential-copied instance + repository serve -> injection, teardown, banner layout, media, dock, pet, settings, custom palette, editable greeting -> screenshots'
    startedAt = $startedAt
    finishedAt = (Get-Date).ToUniversalTime().ToString('o')
    harness = [ordered]@{ driver = (Join-Path $repo 'tools\verify-v02.ps1'); renderer = (Join-Path $repo 'tools\verify-v02.mjs'); scratchRoot = $T; keepTemp = [bool]$KeepTemp }
    ports = [ordered]@{ cdp = $CdpPort; api = $ApiPort }
    repo = $repo
    zcode = $(if ($mjs -and $mjs.zcodeVersion) { [ordered]@{ browser = [string]$mjs.zcodeVersion.browser; userAgent = [string]$mjs.zcodeVersion.userAgent; protocol = [string]$mjs.zcodeVersion.protocol; pageTarget = $mjs.pageTarget; pluginVersion = $mjs.pluginVersion } } else { [ordered]@{ cdpVersion = $cdpVersionRaw } })
    viewport = $(if ($mjs -and $mjs.viewport) { $mjs.viewport } else { $null })
    palette = [ordered]@{ accent = $accent; background = $background; fullBandHeight = $fullHeight; compactBandHeight = $compactHeight }
    credentials = $credEvidence
    privacy = [ordered]@{ scrubReport = $scrubReport; rendererScan = 'tools/verify-v02.mjs scans the visible text for the private-project denylist at every capture' }
    service = [ordered]@{ pid = $servePid; health = $health; stdout = (Read-TextFile (Join-Path $logDir 'serve.out.txt')); stderr = (Read-TextFile (Join-Path $logDir 'serve.err.txt')) }
    instance = [ordered]@{ pid = $zcodePid; profile = $profileDir; args = $zcodeArgs; close = $closeResult }
    checks = $allChecks
    summary = [ordered]@{ passed = $passed; failed = $failed; notTested = $notTestedCount; total = $allChecks.Count; renderer = $rendererSummary }
    failedChecks = @($allChecks | Where-Object { $_.status -eq 'fail' } | ForEach-Object { [ordered]@{ name = $_.name; expectation = $_.expectation; observed = $_.observed } })
    notTestedChecks = @($allChecks | Where-Object { $_.status -eq 'not-tested' } | ForEach-Object { [ordered]@{ name = $_.name; expectation = $_.expectation; observed = $_.observed; reason = $_.reason } })
    screenshots = $screenshotRecords
    appearance = $(if ($mjs -and $mjs.appearance) { $mjs.appearance } else { $null })
    fixture = $(if ($mjs) { $mjs.fixture } else { $null })
    notes = $(if ($mjs) { $mjs.notes } else { @() })
    environmentFacts = $(if ($mjs -and $mjs.environmentFacts) { $mjs.environmentFacts } else { @() })
    realProfile = [ordered]@{ unchanged = ($credDiffs.Count -eq 0); diffs = $credDiffs; before = $beforeStamp; after = $afterStamp; baselineZcodePids = $baselineZcodePids; afterZcodePids = $afterZcodePids; missingZcodePids = $missingPids }
    driverFailures = @($script:failures)
}
try {
    [System.IO.File]::WriteAllText($finalEvidencePath, ($evidence | ConvertTo-Json -Depth 14), (New-Object System.Text.UTF8Encoding($false)))
    Write-Host ('[evidence] written: ' + $finalEvidencePath)
} catch {
    Fail-Step ('could not write the evidence JSON: ' + $_.Exception.Message)
    $failed = $failed + 1
}

if (-not $KeepTemp) {
    Remove-Item -LiteralPath $T -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $T) { Fail-Step ('the scratch tree could not be removed: ' + $T) } else { Note ('scratch tree removed: ' + $T) }
} else {
    Note ('scratch tree kept (-KeepTemp): ' + $T)
}

# ---------------------------------------------------------------- summary ---
Write-Host ''
Write-Host '=== summary ==='
Write-Host ('passed   : ' + $passed)
Write-Host ('failed   : ' + $failed)
Write-Host ('notTested: ' + $notTestedCount)
Write-Host ('driver failures: ' + $script:failures.Count)
foreach ($f in $script:failures) { Write-Host ('  - ' + $f) }
if ($mjs) {
    $rendererFailed = @($rendererChecks | Where-Object { $_.status -eq 'fail' })
    foreach ($c in $rendererFailed) { Write-Host ('  [check] ' + $c.name + ' observed=' + (($c.observed | ConvertTo-Json -Compress -Depth 4))) }
    $rendererNotTested = @($rendererChecks | Where-Object { $_.status -eq 'not-tested' })
    foreach ($c in $rendererNotTested) { Write-Host ('  [not-tested] ' + $c.name + ': ' + $c.reason) }
}
Write-Host ('real profile unchanged: ' + [string]($credDiffs.Count -eq 0))
if ($failed -gt 0 -or $script:failures.Count -gt 0) {
    Write-Host 'RESULT: FAIL (harness level; ROOT decides the gate)'
    exit 1
}
Write-Host 'RESULT: PASS (harness level; ROOT decides the gate)'
exit 0
