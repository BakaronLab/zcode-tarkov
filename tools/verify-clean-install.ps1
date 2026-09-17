#Requires -Version 5.1
<#
  verify-clean-install.ps1 - end-to-end acceptance harness for the zcode-tarkov
  user-level lifecycle: clean install -> launch the installed build -> Tarkov
  theme visible in the live renderer -> screenshots -> close the scratch
  instance -> uninstall (dry run + real + idempotency) -> real-profile proof.

  It exercises the real scripts and the real ZCode.exe, but only inside a
  scratch tree below $env:TEMP, with APPDATA and USERPROFILE redirected and
  ZCODE_DESKTOP_USER_DATA_DIR / ZCODE_DESKTOP_SESSION_DATA_DIR pointing at
  scratch directories, so the running user instance and the real profile are
  never touched.

  Fail-closed guard: refuses to run unless every path it writes is under
  $env:TEMP, and refuses to stop a process that is not provably the scratch
  instance (ZCode.exe whose command line carries the scratch CDP port).

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\verify-clean-install.ps1
    powershell ... -CdpPort 9444 -ApiPort 9333 -KeepTemp

  Exit codes: 0 every step passed, 1 at least one assertion failed or a step
  was refused, 2 the harness refused to run (safety guard).
#>
[CmdletBinding()]
param(
    [string]$SourceDir = '',
    [int]$CdpPort = 9444,
    [int]$ApiPort = 9333,
    [switch]$KeepTemp
)

$ErrorActionPreference = 'Continue'
$script:failures = New-Object System.Collections.ArrayList
$script:notTested = New-Object System.Collections.ArrayList

function Note {
    param([string]$Text)
    Write-Host ('[note] ' + $Text)
}

function Fail-Step {
    param([string]$Text)
    [void]$script:failures.Add($Text)
    Write-Host ('[FAIL] ' + $Text)
}

function NotTested {
    param([string]$Text)
    [void]$script:notTested.Add($Text)
    Write-Host ('[NOT TESTED] ' + $Text)
}

$repo = $SourceDir
if ([string]::IsNullOrWhiteSpace($repo)) { $repo = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')) }
try { $repo = [System.IO.Path]::GetFullPath($repo) } catch { }

$tempRoot = [System.IO.Path]::GetFullPath($env:TEMP)
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
$T = Join-Path $tempRoot ('zct-verify-' + $stamp)

# ---------------------------------------------------------------- safety ----
$guardTargets = [ordered]@{
    installDir = Join-Path $T 'app'
    linksDir   = Join-Path $T 'links'
    dataDir    = Join-Path $T 'data'
    appdataDir = Join-Path $T 'appdata'
    homeDir    = Join-Path $T 'home'
    profileDir = Join-Path $T 'zcode-profile'
    sessionDir = Join-Path $T 'zcode-session'
    logDir     = Join-Path $T 'logs'
    tempRoot   = $T
}
$blocked = @(
    [System.IO.Path]::GetFullPath((Join-Path $env:USERPROFILE 'Desktop')),
    [System.IO.Path]::GetFullPath((Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu')),
    [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs\zcode-tarkov')),
    [System.IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.zcode'))
)
$guardMessages = @()
foreach ($key in $guardTargets.Keys) {
    $p = [System.IO.Path]::GetFullPath($guardTargets[$key])
    if (-not $p.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        $guardMessages += ($key + '=' + $p + ' is NOT under TEMP (' + $tempRoot + ')')
    }
    foreach ($b in $blocked) {
        if ($p.Equals($b, [System.StringComparison]::OrdinalIgnoreCase) -or $p.StartsWith($b + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
            $guardMessages += ($key + '=' + $p + ' is inside the real-profile location ' + $b)
        }
    }
}
if ($guardMessages.Count -gt 0) {
    Write-Host 'REFUSING TO RUN: the harness would touch the real profile.'
    foreach ($m in $guardMessages) { Write-Host ('  - ' + $m) }
    exit 2
}
foreach ($required in @('install.ps1', 'uninstall.ps1', 'repair.ps1', 'dist\cli.js', 'launcher\zcode-tarkov-launch.ps1', 'launcher\zcode-tarkov-discovery.ps1', 'launcher\zcode-tarkov-shortcuts.ps1', 'src\themes\tarkov.ts', 'tools\verify-clean-install.mjs')) {
    if (-not (Test-Path -LiteralPath (Join-Path $repo $required) -PathType Leaf)) {
        Write-Host ('REFUSING TO RUN: missing ' + (Join-Path $repo $required))
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

foreach ($d in $guardTargets.Values) {
    if (-not (Test-Path -LiteralPath $d -PathType Container)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}
$installDir = [System.IO.Path]::GetFullPath($guardTargets.installDir)
$linksDir   = [System.IO.Path]::GetFullPath($guardTargets.linksDir)
$dataDir    = [System.IO.Path]::GetFullPath($guardTargets.dataDir)
$appdataDir = [System.IO.Path]::GetFullPath($guardTargets.appdataDir)
$homeDir    = [System.IO.Path]::GetFullPath($guardTargets.homeDir)
$profileDir = [System.IO.Path]::GetFullPath($guardTargets.profileDir)
$sessionDir = [System.IO.Path]::GetFullPath($guardTargets.sessionDir)
$logDir     = [System.IO.Path]::GetFullPath($guardTargets.logDir)
$appdataStartup = Join-Path $appdataDir 'Microsoft\Windows\Start Menu\Programs\Startup'
New-Item -ItemType Directory -Path $appdataStartup -Force | Out-Null
$tempLink = Join-Path $linksDir 'ZCode Tarkov.lnk'
$tempAutostart = Join-Path $appdataStartup 'zcode-beautify.vbs'

Write-Host ('[harness] scratch root: ' + $T)
Write-Host ('[harness] repo:         ' + $repo)

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

function Wait-ForCdp {
    param([int]$Port, [int]$TimeoutSec)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $Port + '/json/version') -UseBasicParsing -TimeoutSec 3
            if ($r.StatusCode -eq 200) { return $r.Content }
        } catch { }
        Start-Sleep -Milliseconds 1000
    }
    return $null
}

function Read-TextFile {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
    try { return [System.IO.File]::ReadAllText($Path) } catch { return '' }
}

# The CDP endpoint answers /json/version as soon as the browser process is up,
# but the renderer page target only appears a moment later (measured ~0.8s vs
# ~2.5s on a cold scratch profile). The theme command needs the page target, so
# wait for that, not for the version endpoint.
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
                if ($pages.Count -gt 0) { return [ordered]@{ version = $version; pageCount = $pages.Count; targetCount = $targets.Count } }
            }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    return [ordered]@{ version = $version; pageCount = 0; targetCount = 0 }
}
function Get-FileRecord {
    param([string]$Path)
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        $item = Get-Item -LiteralPath $Path
        return [ordered]@{ path = $Path; exists = $true; sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash; length = $item.Length; lastWriteUtc = $item.LastWriteTimeUtc.ToString('o') }
    }
    return [ordered]@{ path = $Path; exists = $false; sha256 = $null; length = $null; lastWriteUtc = $null }
}

function Get-DirListing {
    param([string]$Dir, [string]$Filter)
    $out = New-Object System.Collections.ArrayList
    if (Test-Path -LiteralPath $Dir -PathType Container) {
        $items = @(Get-ChildItem -LiteralPath $Dir -Force -ErrorAction SilentlyContinue)
        if ($Filter) { $items = @($items | Where-Object { $_.Name -like $Filter }) }
        foreach ($i in ($items | Sort-Object Name)) {
            [void]$out.Add([ordered]@{ name = $i.Name; length = $i.Length; lastWriteUtc = $i.LastWriteTimeUtc.ToString('o') })
        }
    }
    return $out.ToArray()
}

function Get-ProfileSnapshot {
    $svc = $null
    $c = Get-NetTCPConnection -State Listen -LocalPort 9223 -ErrorAction SilentlyContinue
    if ($c) {
        $p = Get-Process -Id $c[0].OwningProcess -ErrorAction SilentlyContinue
        $svc = [ordered]@{ pid = [int]$c[0].OwningProcess; name = $(if ($p) { $p.ProcessName } else { $null }) }
    }
    $z = @(Get-Process -Name ZCode -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id | Sort-Object)
    $hkcu = New-Object System.Collections.ArrayList
    foreach ($k in @('HKCU:\Software\Classes\zcode\shell\open\command', 'HKCU:\Software\Classes\Directory\shell\ZCode.OpenInZCode\command', 'HKCU:\Software\Classes\Drive\shell\ZCode.OpenInZCode\command')) {
        $v = $null
        if (Test-Path -LiteralPath $k) { $v = [string](Get-ItemProperty -LiteralPath $k -ErrorAction SilentlyContinue).'(default)' }
        [void]$hkcu.Add([ordered]@{ key = $k; default = $v })
    }
    return [ordered]@{
        tag                    = $null
        capturedAt             = (Get-Date).ToUniversalTime().ToString('o')
        realDesktopTarkovLnk   = Get-FileRecord (Join-Path $env:USERPROFILE 'Desktop\ZCode Tarkov.lnk')
        realStartMenuZCodeLnk  = Get-FileRecord (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\ZCode.lnk')
        realStartupVbs         = Get-FileRecord (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\zcode-beautify.vbs')
        realDesktopListing     = Get-DirListing (Join-Path $env:USERPROFILE 'Desktop') ''
        realStartMenuLnkList   = Get-DirListing (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs') '*.lnk'
        realStartupListing     = Get-DirListing (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup') ''
        localAppDataZctExists  = (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'Programs\zcode-tarkov'))
        service9223            = $svc
        zcodePids              = $z
        hkcuHandlers           = $hkcu.ToArray()
    }
}

function Compare-Snapshots {
    param($Before, $After)
    $diffs = New-Object System.Collections.ArrayList
    foreach ($n in @('realDesktopTarkovLnk', 'realStartMenuZCodeLnk', 'realStartupVbs')) {
        $b = $Before[$n]; $a = $After[$n]
        if ([string]$b.sha256 -ne [string]$a.sha256) { [void]$diffs.Add($n + ' sha256 changed: ' + [string]$b.sha256 + ' -> ' + [string]$a.sha256) }
        if ([bool]$b.exists -ne [bool]$a.exists) { [void]$diffs.Add($n + ' existence changed') }
    }
    if ([bool]$Before.localAppDataZctExists -ne [bool]$After.localAppDataZctExists) { [void]$diffs.Add('%LOCALAPPDATA%\Programs\zcode-tarkov existence changed: ' + $Before.localAppDataZctExists + ' -> ' + $After.localAppDataZctExists) }
    $bp = $Before.service9223; $ap = $After.service9223
    if ($null -eq $bp -or $null -eq $ap -or [int]$bp.pid -ne [int]$ap.pid) { [void]$diffs.Add('service pid on 9223 changed: ' + ($(if ($bp) { $bp.pid } else { 'none' })) + ' -> ' + ($(if ($ap) { $ap.pid } else { 'none' }))) }
    foreach ($zpid in $Before.zcodePids) { if ($After.zcodePids -notcontains $zpid) { [void]$diffs.Add('baseline ZCode.exe pid disappeared: ' + $zpid) } }
    for ($i = 0; $i -lt $Before.hkcuHandlers.Count; $i++) {
        $b = $Before.hkcuHandlers[$i]; $a = $After.hkcuHandlers[$i]
        if ([string]$b.default -ne [string]$a.default) { [void]$diffs.Add('HKCU handler value changed at ' + $b.key) }
    }
    foreach ($n in @('realDesktopListing', 'realStartMenuLnkList', 'realStartupListing')) {
        $b = ($Before[$n] | ForEach-Object { $_.name + '|' + $_.length } ) -join ';'
        $a = ($After[$n] | ForEach-Object { $_.name + '|' + $_.length } ) -join ';'
        if ($b -ne $a) { [void]$diffs.Add($n + ' listing changed') }
    }
    return $diffs.ToArray()
}

# Runs the child with the given environment and captures its output through a
# cmd.exe file redirection. A plain Start-Process -RedirectStandardOutput -Wait
# hangs here: install.ps1's detached `node ... serve` grandchild inherits the
# pipe and keeps it open, so the async reader never sees EOF. A .cmd file with
# `> file 2> file` uses a real file handle and cmd.exe waits only for its direct
# child, so a detached grandchild cannot block the harness.
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
    # .NET Process directly: Start-Process -Wait also waits for child processes,
    # so a detached `node ... serve` grandchild keeps it blocked. WaitForExit()
    # waits for cmd.exe only, which waits for its direct child only.
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
function Start-Redirected {
    param([string]$FilePath, [string[]]$Arguments, [hashtable]$Env)
    $saved = @{}
    foreach ($k in $Env.Keys) {
        $saved[$k] = [System.Environment]::GetEnvironmentVariable($k, 'Process')
        [System.Environment]::SetEnvironmentVariable($k, $(if ($null -eq $Env[$k]) { $null } else { [string]$Env[$k] }), 'Process')
    }
    $p = Start-Process -FilePath $FilePath -ArgumentList $Arguments -PassThru
    foreach ($k in $saved.Keys) { [System.Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') }
    return $p
}

function Get-ZctNodeProcesses {
    $result = New-Object System.Collections.ArrayList
    try {
        $all = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue)
        foreach ($item in $all) {
            if ($item.CommandLine -and $item.CommandLine.Contains($installDir)) { [void]$result.Add($item) }
        }
    } catch { }
    return ,$result.ToArray()
}

function Get-ScratchZcodeProcesses {
    $result = New-Object System.Collections.ArrayList
    try {
        $all = @(Get-CimInstance Win32_Process -Filter "Name = 'ZCode.exe'" -ErrorAction SilentlyContinue)
        foreach ($item in $all) {
            if ($item.CommandLine -and $item.CommandLine.Contains('--remote-debugging-port=' + $CdpPort)) { [void]$result.Add($item) }
        }
    } catch { }
    return ,$result.ToArray()
}

# ------------------------------------------------------- palette of record --
# Expected palette values are read from the source of truth in src\themes\tarkov.ts
# (never hardcoded in this harness).
$tarkovSrc = [string](Get-Content -LiteralPath (Join-Path $repo 'src\themes\tarkov.ts') -Raw)
function Get-PaletteValue {
    param([string]$Key, [string]$Text)
    if ($Text -match ($Key + '\s*:\s*"(#[0-9a-fA-F]{6})"')) { return $Matches[1] }
    return $null
}
$palette = [ordered]@{
    accent     = Get-PaletteValue 'accent' $tarkovSrc
    background = Get-PaletteValue 'background' $tarkovSrc
    text       = Get-PaletteValue 'text' $tarkovSrc
}
if (-not $palette.accent -or -not $palette.text) { Write-Host 'REFUSING TO RUN: could not read the palette from src\themes\tarkov.ts'; exit 2 }

# ------------------------------------------------------------ stage 0 base ---
Write-Host ''
Write-Host '=== stage 0: baseline snapshot of the real profile ==='
$baseline = Get-ProfileSnapshot
$baseline.tag = 'baseline'
$baseline | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $logDir 'baseline.json') -Encoding Ascii
Write-Host ('[baseline] Desktop ZCode Tarkov.lnk  : ' + [string]$baseline.realDesktopTarkovLnk.sha256)
Write-Host ('[baseline] Start Menu ZCode.lnk      : ' + [string]$baseline.realStartMenuZCodeLnk.sha256)
Write-Host ('[baseline] Startup zcode-beautify.vbs: ' + [string]$baseline.realStartupVbs.sha256)
Write-Host ('[baseline] service on 9223           : ' + $(if ($baseline.service9223) { $baseline.service9223.pid.ToString() + '/' + $baseline.service9223.name } else { 'none' }))
Write-Host ('[baseline] ZCode.exe processes       : ' + $baseline.zcodePids.Count)
Write-Host ('[baseline] LOCALAPPDATA Programs\zcode-tarkov exists: ' + [string]$baseline.localAppDataZctExists)

# -------------------------------------------------------------- stage 1 -----
Write-Host ''
Write-Host '=== stage 1: clean install into the scratch tree ==='
$installArgs = @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $repo 'install.ps1'),
    '-InstallDir', $installDir,
    '-ShortcutDir', $linksDir,
    '-DataDir', $dataDir,
    '-CdpPort', [string]$CdpPort,
    '-ApiPort', [string]$ApiPort,
    '-SourceDir', $repo
)
$installEnv = @{
    APPDATA = $appdataDir
    USERPROFILE = $homeDir
    ZCODE_BEAUTIFY_DATA_DIR = $null
    ZCODE_DESKTOP_USER_DATA_DIR = $null
    ZCODE_DESKTOP_SESSION_DATA_DIR = $null
    ZCODE_WINDOWS_APP_INSTALL_DIR = 'C:\Program Files\ZCode'
}
$install = Invoke-Redirected -FilePath 'powershell.exe' -Arguments $installArgs -Name 'install' -Env $installEnv
Write-Host ('[install] exit code: ' + $install.exitCode)
Write-Host '----- install report -----'
Write-Host $install.stdout
if ($install.stderr -and $install.stderr.Trim().Length -gt 0) { Write-Host '----- install stderr -----'; Write-Host $install.stderr }
if ($install.exitCode -ne 0) { Fail-Step ('install.ps1 exited ' + $install.exitCode + ' (expected 0)') }

$settingsPath = Join-Path $installDir 'settings.json'
$settingsRaw = ''
$settings = $null
if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
    $settingsRaw = [string](Get-Content -LiteralPath $settingsPath -Raw)
    try { $settings = $settingsRaw | ConvertFrom-Json } catch { Fail-Step ('settings.json is not parseable: ' + $_.Exception.Message) }
    Write-Host '----- settings.json -----'
    Write-Host $settingsRaw
} else {
    Fail-Step ('settings.json was not created at ' + $settingsPath)
}
$shortcutRecord = Get-FileRecord $tempLink
$autostartRecord = Get-FileRecord $tempAutostart
if ($shortcutRecord.exists) { Note ('shortcut created: ' + $tempLink) } else { Fail-Step ('the launcher shortcut was not created at ' + $tempLink) }
if ($autostartRecord.exists) { Note ('autostart entry created: ' + $tempAutostart) } else { Fail-Step ('the autostart entry was not created at ' + $tempAutostart) }
if ($settings) {
    if ([string]$settings.dataDir -ne $dataDir) { Fail-Step ('settings.dataDir is "' + [string]$settings.dataDir + '", expected "' + $dataDir + '" (the -DataDir parameter must pin it)') }
    if ([int]$settings.cdpPort -ne $CdpPort) { Fail-Step ('settings.cdpPort is ' + [string]$settings.cdpPort + ', expected ' + $CdpPort) }
    if ([int]$settings.apiPort -ne $ApiPort) { Fail-Step ('settings.apiPort is ' + [string]$settings.apiPort + ', expected ' + $ApiPort) }
    if ([string]$settings.product -ne 'zcode-tarkov') { Fail-Step ('settings.product is "' + [string]$settings.product + '"') }
}
$installedUninstallHash = $null
$installedUninstallPath = Join-Path $installDir 'uninstall.ps1'
if (Test-Path -LiteralPath $installedUninstallPath -PathType Leaf) { $installedUninstallHash = (Get-FileHash -LiteralPath $installedUninstallPath -Algorithm SHA256).Hash }
Note ('installed uninstall.ps1 sha256 (captured at install time): ' + [string]$installedUninstallHash)
$serviceHealth = $null
try {
    $h = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $ApiPort + '/api/health') -UseBasicParsing -TimeoutSec 3
    if ($h.StatusCode -eq 200) { $serviceHealth = $h.Content }
} catch { }
$tempNodeProcs = Get-ZctNodeProcesses
Note ('temp install node.exe processes: ' + @($tempNodeProcs).Count + ' [' + (@($tempNodeProcs | ForEach-Object { $_.ProcessId }) -join ', ') + ']')
if ($serviceHealth) { Note ('temp service health: ' + $serviceHealth) } else { Note ('temp service health: no answer on api port ' + $ApiPort) }
$dataListingAfterInstall = Get-DirListing $dataDir ''
Write-Host ''
Write-Host '=== stage 2: launch the installed build (isolated scratch instance) ==='
$launchEnv = @{
    APPDATA = $appdataDir
    USERPROFILE = $homeDir
    ZCODE_DESKTOP_USER_DATA_DIR = $profileDir
    ZCODE_DESKTOP_SESSION_DATA_DIR = $sessionDir
    ZCODE_BEAUTIFY_DATA_DIR = $null
}
$launcherPath = Join-Path $installDir 'launcher\zcode-tarkov-launch.ps1'
$launcher = Invoke-Redirected -FilePath 'powershell.exe' -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $launcherPath, '-NoPrompt') -Name 'launcher' -Env $launchEnv
Write-Host ('[launcher] exit code: ' + $launcher.exitCode)
Write-Host '----- launcher output -----'
Write-Host $launcher.stdout
if ($launcher.stderr -and $launcher.stderr.Trim().Length -gt 0) { Write-Host '----- launcher stderr -----'; Write-Host $launcher.stderr }
$launcherLogPath = Join-Path $dataDir 'launcher.log'
if (Test-Path -LiteralPath $launcherLogPath -PathType Leaf) { Write-Host '----- launcher.log -----'; Write-Host ([string](Get-Content -LiteralPath $launcherLogPath -Raw)) }

$launcherStartedZcode = $false
$launcherBlockedBy = $null
if (Test-PortOpen -Port $CdpPort) {
    $launcherStartedZcode = $true
    Note 'the launcher brought the CDP port up'
} else {
    $launcherBlockedBy = 'launcher exited ' + $launcher.exitCode + ' and port ' + $CdpPort + ' is closed'
    NotTested ('launcher start path (' + $launcherBlockedBy + '); reproduced with a direct ZCode.exe start. Launcher output: ' + $launcher.stdout.Trim())
}

$directLaunchUsed = $false
if (-not $launcherStartedZcode) {
    # The Chromium singleton lock is established from the browser process's user
    # data directory before ZCODE_DESKTOP_USER_DATA_DIR is applied, so without
    # an explicit --user-data-dir the scratch process can be treated as a second
    # instance of the user's running ZCode: it notifies the real instance and
    # exits with RESULT_CODE_NORMAL_EXIT_PROCESS_NOTIFIED (0xFFFF7003), or worse,
    # takes over the real profile's lock. The switch keeps this instance fully
    # independent (measured on ZCode 3.11.2).
    Write-Host '[harness] reproducing the launch directly: Start-Process ZCode.exe --remote-debugging-port=' + $CdpPort
    $direct = Start-Redirected -FilePath $zcodeExe -Arguments @('--remote-debugging-port=' + $CdpPort, ('--user-data-dir=' + $profileDir)) -Env $launchEnv
    $directLaunchUsed = $true
    Note ('direct ZCode.exe start: pid ' + $direct.Id + ' (--user-data-dir=' + $profileDir + ')')
}
$cdpReady = Wait-ForPageTarget -Port $CdpPort -TimeoutSec 60
$cdpVersionRaw = $cdpReady.version
if ($cdpReady.pageCount -lt 1) {
    Fail-Step ('no CDP page target appeared on http://127.0.0.1:' + $CdpPort + '/json/list within 60s (version answered: ' + $cdpVersionRaw + ')')
} else {
    Note ('CDP page target up (' + $cdpReady.pageCount + ' page target(s), ' + $cdpReady.targetCount + ' target(s) total); /json/version: ' + $cdpVersionRaw)
}

# -------------------------------------------------------------- stage 3 -----
Write-Host ''
Write-Host '=== stage 3: apply the Tarkov theme through the installed build ==='
$themeArgs = @((Join-Path $installDir 'dist\cli.js'), 'theme', 'tarkov', '--port', [string]$CdpPort)
$theme = Invoke-Redirected -FilePath $nodeExe -Arguments $themeArgs -Name 'theme' -Env @{ ZCODE_BEAUTIFY_DATA_DIR = $dataDir; APPDATA = $appdataDir; USERPROFILE = $homeDir }
Write-Host ('[theme] exit code: ' + $theme.exitCode)
Write-Host ('[theme] stdout: ' + $theme.stdout.Trim())
if ($theme.stderr -and $theme.stderr.Trim().Length -gt 0) { Write-Host ('[theme] stderr: ' + $theme.stderr.Trim()) }
if ($theme.exitCode -ne 0) { Fail-Step ('theme command exited ' + $theme.exitCode) }

$cdpEvidencePath = Join-Path $logDir 'cdp-evidence.json'
$outDir = Join-Path $repo 'docs\images'
$verifyArgs = @(
    (Join-Path $repo 'tools\verify-clean-install.mjs'),
    '--port', [string]$CdpPort,
    '--mode', 'verify',
    '--out-dir', $outDir,
    '--evidence', $cdpEvidencePath,
    '--timeout-ms', '45000',
    '--palette', ('accent=' + $palette.accent),
    '--palette', ('background=' + $palette.background),
    '--palette', ('text=' + $palette.text)
)
$verify = Invoke-Redirected -FilePath $nodeExe -Arguments $verifyArgs -Name 'cdp-verify' -Env @{ ZCODE_BEAUTIFY_DATA_DIR = $dataDir; APPDATA = $appdataDir; USERPROFILE = $homeDir }
Write-Host ('[cdp] exit code: ' + $verify.exitCode)
Write-Host ('[cdp] ' + $verify.stdout.Trim())
if ($verify.stderr -and $verify.stderr.Trim().Length -gt 0) { Write-Host ('[cdp] stderr: ' + $verify.stderr.Trim()) }
$cdp = $null
if (Test-Path -LiteralPath $cdpEvidencePath -PathType Leaf) {
    try { $cdp = (Read-TextFile $cdpEvidencePath) | ConvertFrom-Json } catch { Fail-Step ('cannot parse CDP evidence: ' + $_.Exception.Message) }
    foreach ($a in $cdp.assertions) {
        Write-Host ('[cdp] ' + $(if ($a.pass) { 'PASS' } else { 'FAIL' }) + ' ' + $a.id + ' expected=' + [string]$a.expected + ' observed=' + [string]$a.observed)
    }
    if ($cdp.summary.failed -gt 0) { Fail-Step ($cdp.summary.failed.ToString() + ' CDP assertion(s) failed') }
} else {
    Fail-Step 'no CDP evidence file was written'
}

# -------------------------------------------------------------- stage 4 -----
Write-Host ''
Write-Host '=== stage 4: close the scratch instance (the real one is not touched) ==='
$closeArgs = @((Join-Path $repo 'tools\verify-clean-install.mjs'), '--port', [string]$CdpPort, '--mode', 'close', '--evidence', (Join-Path $logDir 'cdp-close.json'))
$close = Invoke-Redirected -FilePath $nodeExe -Arguments $closeArgs -Name 'cdp-close' -Env @{ APPDATA = $appdataDir; USERPROFILE = $homeDir }
Write-Host ('[close] exit code: ' + $close.exitCode + ' ' + $close.stdout.Trim())
$closedDeadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $closedDeadline -and (Test-PortOpen -Port $CdpPort)) { Start-Sleep -Milliseconds 500 }
$leftover = Get-ScratchZcodeProcesses
if (@($leftover).Count -gt 0) {
    Note ('stopping ' + @($leftover).Count + ' ZCode.exe process(es) whose command line carries --remote-debugging-port=' + $CdpPort)
    foreach ($pr in $leftover) { Write-Host ('  pid ' + $pr.ProcessId + ' : ' + $pr.CommandLine) }
    foreach ($pr in $leftover) { Stop-Process -Id $pr.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 5
}
$leftoverAfter = Get-ScratchZcodeProcesses
if (@($leftoverAfter).Count -gt 0) { Fail-Step (@($leftoverAfter).Count.ToString() + ' scratch ZCode.exe process(es) survived Browser.close and the targeted stop') }
if (Test-PortOpen -Port $CdpPort) { Fail-Step ('the scratch CDP port ' + $CdpPort + ' is still open after the close') } else { Note 'scratch CDP port is closed' }
$afterZcode = @(Get-Process -Name ZCode -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id | Sort-Object)
$missing = @($baseline.zcodePids | Where-Object { $afterZcode -notcontains $_ })
if ($missing.Count -gt 0) { Fail-Step ('real ZCode.exe pid(s) disappeared during the journey: ' + ($missing -join ',')) } else { Note ('all ' + $baseline.zcodePids.Count + ' baseline ZCode.exe pids survived the scratch instance') }

# -------------------------------------------------------------- stage 5 -----
Write-Host ''
Write-Host '=== stage 5: uninstall (dry run, real, idempotency) ==='
$uninstallPath = Join-Path $installDir 'uninstall.ps1'
if (-not (Test-Path -LiteralPath $uninstallPath -PathType Leaf)) { Fail-Step ('the installed uninstall.ps1 is missing at ' + $uninstallPath) }
$uninstallEnv = @{
    APPDATA = $appdataDir
    USERPROFILE = $homeDir
    ZCODE_BEAUTIFY_DATA_DIR = $null
    ZCODE_DESKTOP_USER_DATA_DIR = $null
    ZCODE_DESKTOP_SESSION_DATA_DIR = $null
    ZCODE_WINDOWS_APP_INSTALL_DIR = 'C:\Program Files\ZCode'
}
$uninstallBase = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $uninstallPath, '-InstallDir', $installDir, '-DataDir', $dataDir, '-CdpPort', [string]$CdpPort, '-ApiPort', [string]$ApiPort, '-ShortcutDir', $linksDir)
$unDry = Invoke-Redirected -FilePath 'powershell.exe' -Arguments ($uninstallBase + @('-DryRun')) -Name 'uninstall-dryrun' -Env $uninstallEnv
Write-Host ('[uninstall -DryRun] exit code: ' + $unDry.exitCode)
Write-Host '----- uninstall -DryRun plan -----'
Write-Host $unDry.stdout
if ($unDry.stderr -and $unDry.stderr.Trim().Length -gt 0) { Write-Host '----- uninstall -DryRun stderr -----'; Write-Host $unDry.stderr }

$unReal = Invoke-Redirected -FilePath 'powershell.exe' -Arguments ($uninstallBase + @('-KeepLegacyShortcut', '-KeepOfficialShortcuts')) -Name 'uninstall-real' -Env $uninstallEnv
Write-Host ('[uninstall] exit code: ' + $unReal.exitCode)
Write-Host '----- uninstall report -----'
Write-Host $unReal.stdout
if ($unReal.stderr -and $unReal.stderr.Trim().Length -gt 0) { Write-Host '----- uninstall stderr -----'; Write-Host $unReal.stderr }
if ($unReal.exitCode -ne 0) { Fail-Step ('uninstall.ps1 exited ' + $unReal.exitCode + ' (expected 0)') }

Write-Host '--- post-uninstall assertions ---'
if (Test-Path -LiteralPath $installDir) { Fail-Step ('the install directory still exists: ' + $installDir) } else { Note 'install directory removed' }
if (Test-Path -LiteralPath $tempAutostart) { Fail-Step ('the temp autostart entry still exists: ' + $tempAutostart) } else { Note 'temp autostart entry removed' }
if (Test-Path -LiteralPath $tempLink) { Fail-Step ('the temp shortcut still exists: ' + $tempLink) } else { Note 'temp shortcut removed' }
if (Test-Path -LiteralPath $dataDir) { $dataItems = @((Get-DirListing $dataDir '') | ForEach-Object { $_.name }); Note ('data directory kept (default): ' + $dataDir + ' -> [' + ($dataItems -join ', ') + ']') } else { Fail-Step ('the data directory was removed without -RemoveData: ' + $dataDir) }
$survivingNode = Get-ZctNodeProcesses
if (@($survivingNode).Count -gt 0) { Fail-Step (@($survivingNode).Count.ToString() + ' temp install node.exe process(es) survived the uninstall') } else { Note 'no temp install node.exe process survived' }
if (Test-PortOpen -Port $ApiPort) { Fail-Step ('api port ' + $ApiPort + ' still answers after the uninstall') } else { Note ('api port ' + $ApiPort + ' is closed') }
if ($unReal.stdout -notmatch 'Not touched') { Note 'the uninstall report does not contain the "Not touched" section; check the captured report' }

# The installed uninstall.ps1 lives inside <InstallDir> and is removed with it,
# which is part of the removal contract. The second run therefore uses the
# repository copy (same file; the hashes are recorded in the evidence) so the
# script itself still resolves its launcher helpers.
$repoUninstallPath = Join-Path $repo 'uninstall.ps1'
$repoUninstallHash = (Get-FileHash -LiteralPath $repoUninstallPath -Algorithm SHA256).Hash
Note ('installed uninstall.ps1 sha256 (captured at install time): ' + [string]$installedUninstallHash + '; repo uninstall.ps1 sha256: ' + [string]$repoUninstallHash)
if ($installedUninstallHash -and $installedUninstallHash -ne $repoUninstallHash) { Fail-Step 'the installed uninstall.ps1 differs from the repository copy' }
$idemBase = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $repoUninstallPath, '-InstallDir', $installDir, '-DataDir', $dataDir, '-CdpPort', [string]$CdpPort, '-ApiPort', [string]$ApiPort, '-ShortcutDir', $linksDir)
$unIdem = Invoke-Redirected -FilePath 'powershell.exe' -Arguments ($idemBase + @('-KeepLegacyShortcut', '-KeepOfficialShortcuts', '-Json')) -Name 'uninstall-idempotent' -Env $uninstallEnv

Write-Host ('[uninstall idempotent -Json] exit code: ' + $unIdem.exitCode)
Write-Host ('[uninstall idempotent -Json] ' + $unIdem.stdout.Trim())
if ($unIdem.exitCode -ne 0) { Fail-Step ('the second uninstall exited ' + $unIdem.exitCode + ' (expected 0; uninstall must be idempotent)') }

# -------------------------------------------------------------- stage 6 -----
Write-Host ''
Write-Host '=== stage 6: after snapshot + real-profile comparison ==='
$after = Get-ProfileSnapshot
$after.tag = 'after'
$after | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $logDir 'after.json') -Encoding Ascii
$diffs = Compare-Snapshots -Before $baseline -After $after
if ($diffs.Count -gt 0) {
    foreach ($d in $diffs) { Fail-Step ('real profile changed: ' + $d) }
} else {
    Note 'real profile is unchanged (shortcut hashes, Startup hash, service pid on 9223, baseline ZCode pids, HKCU handler values, directory listings)'
}

# -------------------------------------------------------------- evidence ----
$gitStatus = ''
try { $gitStatus = ([string[]](& git -C $repo status --porcelain 2>&1) -join "`n") } catch { $gitStatus = 'git status failed: ' + $_.Exception.Message }
$uninstallLeftUntouched = @()
if ($unReal.stdout) { $uninstallLeftUntouched = @([regex]::Matches($unReal.stdout, '(?m)^\[(kept|info|warn)\] .*$') | ForEach-Object { $_.Value }) }

$evidence = [ordered]@{
    timestamp = (Get-Date).ToUniversalTime().ToString('o')
    journey = 'v0.1.0 clean install -> launcher -> Tarkov theme -> close -> uninstall -> idempotency'
    harness = [ordered]@{ driver = (Join-Path $repo 'tools\verify-clean-install.ps1'); cdp = (Join-Path $repo 'tools\verify-clean-install.mjs'); scratchRoot = $T }
    zcodeBuild = $(if ($cdp -and $cdp.version) { [ordered]@{ browser = [string]$cdp.version.Browser; userAgent = [string]$cdp.version.'User-Agent'; protocolVersion = [string]$cdp.version.'Protocol-Version' } } else { $null })
    install = [ordered]@{
        report = ($install.stdout -split "`r?`n")
        exitCode = $install.exitCode
        settings = $settings
        settingsRaw = $settingsRaw
        shortcut = $shortcutRecord
        autostartEntry = $autostartRecord
        nodeProcesses = @($tempNodeProcs | ForEach-Object { [ordered]@{ pid = $_.ProcessId; commandLine = $_.CommandLine } })
        serviceHealth = $serviceHealth
    }
    launcher = [ordered]@{
        exitCode = $launcher.exitCode
        output = ($launcher.stdout -split "`r?`n")
        blockedBy = $launcherBlockedBy
        directLaunchUsed = $directLaunchUsed
        launcherLog = (Read-TextFile $launcherLogPath)
    }
    theme = [ordered]@{ exitCode = $theme.exitCode; stdout = $theme.stdout.Trim(); stderr = $theme.stderr.Trim() }
    assertions = $(if ($cdp) { $cdp.assertions } else { @() })
    screenshots = $(if ($cdp) { $cdp.screenshots } else { @() })
    screenshotAnalysis = $(if ($cdp) { $cdp.screenshotAnalysis } else { @() })
    cdpSummary = $(if ($cdp) { $cdp.summary } else { $null })
    windowRaise = $(if ($cdp) { $cdp.windowRaise } else { $null })
    notTested = @($script:notTested)
    realProfile = [ordered]@{
        unchanged = ($diffs.Count -eq 0)
        diffs = @($diffs)
        baseline = [ordered]@{ desktopLnkSha256 = $baseline.realDesktopTarkovLnk.sha256; startMenuLnkSha256 = $baseline.realStartMenuZCodeLnk.sha256; startupVbsSha256 = $baseline.realStartupVbs.sha256; service9223Pid = $baseline.service9223.pid; zcodePidCount = $baseline.zcodePids.Count; localAppDataZctExists = $baseline.localAppDataZctExists }
        after = [ordered]@{ desktopLnkSha256 = $after.realDesktopTarkovLnk.sha256; startMenuLnkSha256 = $after.realStartMenuZCodeLnk.sha256; startupVbsSha256 = $after.realStartupVbs.sha256; service9223Pid = $after.service9223.pid; zcodePidCount = $after.zcodePids.Count; localAppDataZctExists = $after.localAppDataZctExists }
    }
    uninstall = [ordered]@{
        dryRunExitCode = $unDry.exitCode
        dryRunReport = ($unDry.stdout -split "`r?`n")
        exitCode = $unReal.exitCode
        report = ($unReal.stdout -split "`r?`n")
        installedUninstallSha256 = $installedUninstallHash
        repoUninstallSha256 = $repoUninstallHash
        idempotentExitCode = $unIdem.exitCode
        idempotentJson = $unIdem.stdout.Trim()
        keptOrInfoRows = $uninstallLeftUntouched
    }
    failures = @($script:failures)
    finalGitStatusPorcelain = $gitStatus
}
$evidenceJson = $evidence | ConvertTo-Json -Depth 12
[System.IO.File]::WriteAllText((Join-Path $repo 'docs\images\clean-install-evidence.json'), $evidenceJson, (New-Object System.Text.UTF8Encoding($false)))
Write-Host ''
Write-Host ('[evidence] written: ' + (Join-Path $repo 'docs\images\clean-install-evidence.json'))

# ---------------------------------------------------------------- cleanup ---
if (-not $KeepTemp) {
    Remove-Item -LiteralPath $T -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $T) { Fail-Step ('the scratch tree could not be removed: ' + $T) } else { Note ('scratch tree removed: ' + $T) }
} else {
    Note ('scratch tree kept (-KeepTemp): ' + $T)
}

# ---------------------------------------------------------------- summary ---
Write-Host ''
Write-Host '=== summary ==='
Write-Host ('failures : ' + $script:failures.Count)
foreach ($f in $script:failures) { Write-Host ('  - ' + $f) }
Write-Host ('not tested: ' + $script:notTested.Count)
foreach ($n in $script:notTested) { Write-Host ('  - ' + $n) }
if ($cdp) { Write-Host ('CDP assertions: ' + $cdp.summary.passed + '/' + $cdp.summary.total + ' passed') }
Write-Host ('real profile unchanged: ' + [string]($diffs.Count -eq 0))
if ($script:failures.Count -eq 0) { Write-Host 'RESULT: PASS (harness level; ROOT decides the gate)'; exit 0 }
Write-Host 'RESULT: FAIL'; exit 1
