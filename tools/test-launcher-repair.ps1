#Requires -Version 5.1
<#
  test-launcher-repair.ps1 - bounded end-to-end test of the launcher repair
  (src/core/launchers.ts) against a scratch tree below $env:TEMP.

  It creates a fake ZCode.exe (plus a fake notepad.exe decoy and a fake
  NotZCode.exe decoy whose name merely ends with ZCode.exe), builds real .lnk
  files with WScript.Shell in scratch Desktop / Start Menu / pinned TaskBar
  directories plus scratch machine-wide directories, seeds scratch HKCU handler
  keys (one real-looking, one decoy whose executable token is NotZCode.exe), and
  drives the real repair through
  tools/launcher-repair-probe.mjs (the compiled .test-build/core/launchers.js)
  with USERPROFILE, APPDATA, PUBLIC and ProgramData redirected into the scratch
  tree.

  The pinned-TaskBar assertions are the regression guard for the ported
  upstream behaviour: the pinned taskbar is where a user actually clicks, and a
  repair that only covered the Start Menu would miss it.

  Nothing real is read or written: every scanned location is under $env:TEMP,
  and the registry key is a scratch-only prefix
  (HKCU:\Software\Classes\__zct_launcher_repair_test__\...) that is deleted in
  a finally block. The three real HKCU handler keys are never passed to the
  repair. Machine-wide shortcuts are reported, never written, and their files
  are proven byte-identical.

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\test-launcher-repair.ps1
    powershell ... -CdpPort 9444 -KeepTemp

  Exit codes: 0 every assertion passed, 1 at least one assertion failed,
  2 the harness refused to run (safety guard).
#>
[CmdletBinding()]
param(
    [string]$SourceDir = '',
    [int]$CdpPort = 9222,
    [switch]$KeepTemp
)

$ErrorActionPreference = 'Continue'
$script:passed = 0
$script:failures = New-Object System.Collections.ArrayList

function Assert-LauncherRepair {
    param([string]$Name, [bool]$Ok, [string]$Detail = '')
    $suffix = ''
    if (-not [string]::IsNullOrWhiteSpace($Detail)) { $suffix = ' - ' + $Detail }
    if ($Ok) {
        $script:passed = $script:passed + 1
        Write-Host ('PASS ' + $Name)
    } else {
        [void]$script:failures.Add($Name + $suffix)
        Write-Host ('FAIL ' + $Name + $suffix)
    }
}

function Read-TextFile {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
    try { return [System.IO.File]::ReadAllText($Path) } catch { return '' }
}

function Get-FileHashText {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '(absent)' }
    try { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop).Hash } catch { return '(unreadable)' }
}

# ------------------------------------------------------------------- schema ---
# Each shortcut gets its expected outcome so the assertions state the contract
# once instead of repeating paths. "scope" only matters for the machine-wide
# entries, which must be reported and never written.
$script:shortcutSpecs = New-Object System.Collections.ArrayList

function Add-ShortcutSpec {
    param([string]$Path, [string]$Role, [string]$Scope, [string]$Target, [string]$Arguments = '')
    [void]$script:shortcutSpecs.Add([pscustomobject]@{
        path = $Path; role = $Role; scope = $Scope; target = $Target; arguments = $Arguments
    })
}

function Get-SnapshotHash {
    param([string]$Snapshot, [string]$Path)
    $line = @($Snapshot -split "`n" | Where-Object { $_.StartsWith($Path + '|') })[0]
    if ($null -eq $line) { return '(not-found)' }
    return ($line -replace '^.*\|', '')
}

# ------------------------------------------------------------------- quoting ---
# PowerShell 5.1 mangles a native argument that contains both spaces and double
# quotes (it drops the quotes), which is exactly what a JSON options object is.
# Build the command line with the standard Windows rules instead, so node
# receives the JSON unchanged.
function ConvertTo-CommandLineArgument {
    param([string]$Value)
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('"')
    $backslashes = 0
    foreach ($ch in $Value.ToCharArray()) {
        if ($ch -eq '\') { $backslashes = $backslashes + 1; continue }
        if ($ch -eq '"') {
            [void]$sb.Append('\' * (($backslashes * 2) + 1))
            [void]$sb.Append('"')
        } else {
            [void]$sb.Append('\' * $backslashes)
            [void]$sb.Append($ch)
        }
        $backslashes = 0
    }
    [void]$sb.Append('\' * ($backslashes * 2))
    [void]$sb.Append('"')
    return $sb.ToString()
}

# ------------------------------------------------------------------ harness ---
$repo = $SourceDir
if ([string]::IsNullOrWhiteSpace($repo)) { $repo = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')) }
try { $repo = [System.IO.Path]::GetFullPath($repo) } catch { }

$tempRoot = [System.IO.Path]::GetFullPath($env:TEMP)
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
$T = Join-Path $tempRoot ('zct-launcher-repair-' + $stamp)

$homeDir = Join-Path $T 'home'
$appdataDir = Join-Path $T 'appdata'
$publicDir = Join-Path $T 'public'
$programDataDir = Join-Path $T 'programdata'
$fakeAppDir = Join-Path $T 'fakeapp'

$userDesktop = Join-Path $homeDir 'Desktop'
$userStartMenu = Join-Path $appdataDir 'Microsoft\Windows\Start Menu\Programs'
$userTaskBar = Join-Path $appdataDir 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'
$machineDesktop = Join-Path $publicDir 'Desktop'
$machineStartMenu = Join-Path $programDataDir 'Microsoft\Windows\Start Menu\Programs'

$fakeZcode = Join-Path $fakeAppDir 'ZCode.exe'
$fakeNotepad = Join-Path $fakeAppDir 'notepad.exe'
$fakeNotZcode = Join-Path $fakeAppDir 'NotZCode.exe'
$regPrefix = 'HKCU:\Software\Classes\__zct_launcher_repair_test__'
$regKey = Join-Path $regPrefix 'zcode\shell\open\command'
$regDecoyKey = Join-Path $regPrefix 'notzcode\shell\open\command'

$probePath = Join-Path $repo 'tools\launcher-repair-probe.mjs'
$testBuild = Join-Path $repo '.test-build\core\launchers.js'
$logDir = Join-Path $T 'logs'

# ------------------------------------------------------------------- safety ---
$guardTargets = [ordered]@{
    scratchRoot  = $T
    homeDir      = $homeDir
    appdataDir   = $appdataDir
    publicDir    = $publicDir
    programData  = $programDataDir
    fakeAppDir   = $fakeAppDir
    userDesktop  = $userDesktop
    userStartMenu = $userStartMenu
    userTaskBar  = $userTaskBar
    machineDesktop = $machineDesktop
    machineStartMenu = $machineStartMenu
}
$blocked = @(
    [System.IO.Path]::GetFullPath((Join-Path $env:USERPROFILE 'Desktop')),
    [System.IO.Path]::GetFullPath((Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu')),
    [System.IO.Path]::GetFullPath((Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar')),
    [System.IO.Path]::GetFullPath((Join-Path $env:PUBLIC 'Desktop')),
    [System.IO.Path]::GetFullPath((Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu'))
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
if (-not $regPrefix.StartsWith('HKCU:\', [System.StringComparison]::OrdinalIgnoreCase)) {
    Write-Host 'REFUSING TO RUN: the scratch registry prefix must stay under HKCU.'
    exit 2
}
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$nodeExe = ''
if ($null -ne $nodeCommand) { $nodeExe = [string]$nodeCommand.Source }
if ([string]::IsNullOrWhiteSpace($nodeExe) -or -not (Test-Path -LiteralPath $nodeExe -PathType Leaf)) {
    Write-Host 'REFUSING TO RUN: node.exe not found on PATH'
    exit 2
}
if (-not (Test-Path -LiteralPath $probePath -PathType Leaf)) {
    Write-Host ('REFUSING TO RUN: missing ' + $probePath)
    exit 2
}
if (-not (Test-Path -LiteralPath $testBuild -PathType Leaf)) {
    Write-Host '[harness] .test-build is missing; compiling it (tsc -p tsconfig.test.json)'
    Push-Location $repo
    $compileExit = 1
    try {
        & $nodeExe (Join-Path $repo 'node_modules\typescript\bin\tsc') -p tsconfig.test.json
        $compileExit = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    if ($compileExit -ne 0 -or -not (Test-Path -LiteralPath $testBuild -PathType Leaf)) {
        Write-Host 'REFUSING TO RUN: could not compile the test build (.test-build/core/launchers.js)'
        exit 2
    }
}

# The scan order the probe uses, and the one the production defaults use: user
# Desktop, user Start Menu, pinned TaskBar, machine Desktop, machine Start Menu.
# The pinned taskbar in the middle is the ported upstream behaviour.
$shortcutDirs = @(
    @{ path = $userDesktop; scope = 'user' },
    @{ path = $userStartMenu; scope = 'user' },
    @{ path = $userTaskBar; scope = 'user' },
    @{ path = $machineDesktop; scope = 'machine' },
    @{ path = $machineStartMenu; scope = 'machine' }
)
$registryKeys = @($regKey, $regDecoyKey)

# The child gets the scratch environment even though every location is passed
# explicitly: if a default ever leaked into the repair, it would still resolve
# inside the scratch tree.
$probeEnv = [ordered]@{
    USERPROFILE = $homeDir
    APPDATA = $appdataDir
    PUBLIC = $publicDir
    ProgramData = $programDataDir
}

function Invoke-LauncherRepairProbe {
    param([bool]$DryRun, [string]$Name)
    $options = [ordered]@{
        port = $CdpPort
        dryRun = $DryRun
        shortcutDirs = $shortcutDirs
        registryKeys = $registryKeys
    }
    $json = $options | ConvertTo-Json -Depth 6 -Compress
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $nodeExe
    $psi.Arguments = (ConvertTo-CommandLineArgument $probePath) + ' ' + (ConvertTo-CommandLineArgument $json)
    $psi.WorkingDirectory = $repo
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    foreach ($pair in $probeEnv.GetEnumerator()) { $psi.EnvironmentVariables[$pair.Key] = [string]$pair.Value }
    $proc = [System.Diagnostics.Process]::Start($psi)
    $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
    $stderrTask = $proc.StandardError.ReadToEndAsync()
    $proc.WaitForExit()
    $stdout = $stdoutTask.Result
    $stderr = $stderrTask.Result
    $exitCode = $proc.ExitCode
    $proc.Dispose()
    if (-not [string]::IsNullOrWhiteSpace($stderr)) { Write-Host ('[probe ' + $Name + ' stderr] ' + $stderr.Trim()) }
    $report = $null
    if (-not [string]::IsNullOrWhiteSpace($stdout)) {
        try { $report = $stdout | ConvertFrom-Json -ErrorAction Stop } catch { $report = $null }
    }
    return [pscustomobject]@{ name = $Name; exitCode = $exitCode; stdout = $stdout.Trim(); report = $report }
}

function Get-Fix {
    param($Report, [string]$Path)
    if ($null -eq $Report) { return $null }
    return @($Report.fixes | Where-Object { $_.path -eq $Path })[0]
}

function Get-FixStatus {
    param($Report, [string]$Path)
    $fix = Get-Fix $Report $Path
    if ($null -eq $fix) { return '(not reported)' }
    return [string]$fix.status
}

function Get-LnkArguments {
    param([string]$Path)
    try {
        $sc = (New-Object -ComObject WScript.Shell).CreateShortcut($Path)
        return [string]$sc.Arguments
    } catch {
        return '(unreadable)'
    }
}

function Get-LnkSnapshot {
    param([string[]]$Paths)
    $items = New-Object System.Collections.ArrayList
    foreach ($p in $Paths) { [void]$items.Add($p + '|' + (Get-FileHashText $p)) }
    return ($items -join "`n")
}

# -------------------------------------------------------------------- setup ---
function New-TestShortcut {
    param([string]$Path, [string]$TargetPath, [string]$Arguments = '')
    $wsh = New-Object -ComObject WScript.Shell
    $sc = $wsh.CreateShortcut($Path)
    $sc.TargetPath = $TargetPath
    if (-not [string]::IsNullOrEmpty($Arguments)) { $sc.Arguments = $Arguments }
    $sc.Save()
}

$exitCode = 0
try {
    foreach ($d in @($userDesktop, $userStartMenu, $userTaskBar, $machineDesktop, $machineStartMenu, $fakeAppDir, $logDir)) {
        if (-not (Test-Path -LiteralPath $d -PathType Container)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
    }
    [System.IO.File]::WriteAllText($fakeZcode, 'fake zcode' + "`r`n", (New-Object System.Text.ASCIIEncoding))
    [System.IO.File]::WriteAllText($fakeNotepad, 'fake notepad' + "`r`n", (New-Object System.Text.ASCIIEncoding))
    [System.IO.File]::WriteAllText($fakeNotZcode, 'fake not-zcode' + "`r`n", (New-Object System.Text.ASCIIEncoding))

    $userDesktopZcode = Join-Path $userDesktop 'ZCode Desktop.lnk'
    $userDesktopOk = Join-Path $userDesktop 'ZCode Already.lnk'
    $userDesktopDecoy = Join-Path $userDesktop 'Notepad Decoy.lnk'
    $userDesktopZcodeDecoy = Join-Path $userDesktop 'NotZCode Decoy.lnk'
    $userStartMenuZcode = Join-Path $userStartMenu 'ZCode Start Menu.lnk'
    $userStartMenuBroken = Join-Path $userStartMenu 'ZCode Broken.lnk'
    $userTaskBarZcode = Join-Path $userTaskBar 'ZCode Pinned.lnk'
    $machineDesktopZcode = Join-Path $machineDesktop 'ZCode Machine.lnk'
    $machineStartMenuZcode = Join-Path $machineStartMenu 'ZCode Machine Start Menu.lnk'

    New-TestShortcut -Path $userDesktopZcode -TargetPath $fakeZcode
    New-TestShortcut -Path $userDesktopOk -TargetPath $fakeZcode -Arguments ('--remote-debugging-port=' + $CdpPort)
    New-TestShortcut -Path $userDesktopDecoy -TargetPath $fakeNotepad
    New-TestShortcut -Path $userDesktopZcodeDecoy -TargetPath $fakeNotZcode
    New-TestShortcut -Path $userStartMenuZcode -TargetPath $fakeZcode
    New-TestShortcut -Path $userTaskBarZcode -TargetPath $fakeZcode
    New-TestShortcut -Path $machineDesktopZcode -TargetPath $fakeZcode
    New-TestShortcut -Path $machineStartMenuZcode -TargetPath $fakeZcode
    # A .lnk that is not a shortcut at all: the repair must skip it without
    # aborting the run.
    [System.IO.File]::WriteAllText($userStartMenuBroken, 'this is not a shortcut' + "`r`n", (New-Object System.Text.ASCIIEncoding))

    Add-ShortcutSpec -Path $userDesktopZcode -Role 'user-desktop' -Scope 'user' -Target $fakeZcode
    Add-ShortcutSpec -Path $userStartMenuZcode -Role 'user-start-menu' -Scope 'user' -Target $fakeZcode
    Add-ShortcutSpec -Path $userTaskBarZcode -Role 'user-pinned-taskbar' -Scope 'user' -Target $fakeZcode
    Add-ShortcutSpec -Path $userDesktopOk -Role 'user-already-ok' -Scope 'user' -Target $fakeZcode -Arguments ('--remote-debugging-port=' + $CdpPort)
    Add-ShortcutSpec -Path $userDesktopDecoy -Role 'decoy-foreign-target' -Scope 'user' -Target $fakeNotepad
    Add-ShortcutSpec -Path $userDesktopZcodeDecoy -Role 'decoy-zcode-suffix' -Scope 'user' -Target $fakeNotZcode
    Add-ShortcutSpec -Path $machineDesktopZcode -Role 'machine-desktop' -Scope 'machine' -Target $fakeZcode
    Add-ShortcutSpec -Path $machineStartMenuZcode -Role 'machine-start-menu' -Scope 'machine' -Target $fakeZcode

    # The registry path is exercised through a scratch-only prefix. The value is
    # a ZCode.exe command so the repair's identity gate lets it through.
    New-Item -Path $regKey -Force | Out-Null
    Set-ItemProperty -Path $regKey -Name '(default)' -Value ('"' + $fakeZcode + '" "%1"')
    $regBefore = [string](Get-Item -LiteralPath $regKey).GetValue('')

    # Second registry entry: a decoy whose executable token merely ends with
    # ZCode.exe. The identity gate must reject it, so the value stays untouched
    # and it is never reported. The expected fix count therefore does not grow.
    New-Item -Path $regDecoyKey -Force | Out-Null
    Set-ItemProperty -Path $regDecoyKey -Name '(default)' -Value '"C:\tools\NotZCode.exe" "%1"'
    $regDecoyBefore = [string](Get-Item -LiteralPath $regDecoyKey).GetValue('')

    $allLnkPaths = @(Get-ChildItem -LiteralPath $T -Recurse -Filter '*.lnk' -ErrorAction SilentlyContinue | Sort-Object -Property FullName | ForEach-Object { $_.FullName })
    $writablePaths = @($userDesktopZcode, $userStartMenuZcode, $userTaskBarZcode, $userDesktopOk, $regKey)
    $machinePaths = @($machineDesktopZcode, $machineStartMenuZcode)
    $allTrackedPaths = @($allLnkPaths)

    Write-Host ('[harness] scratch root: ' + $T)
    Write-Host ('[harness] repo:         ' + $repo)
    Write-Host ('[harness] node:         ' + $nodeExe)
    Write-Host ('[harness] shortcuts:    ' + $allLnkPaths.Count + ' scratch .lnk file(s), registry key ' + $regKey)

    # ------------------------------------------------------------ 1. dry run --
    Write-Host ''
    Write-Host '=== 1. dry run writes nothing and reports the planned changes ==='
    $beforeDry = Get-LnkSnapshot $allTrackedPaths
    $dry = Invoke-LauncherRepairProbe -DryRun $true -Name 'dry-run'
    Assert-LauncherRepair 'dry-exit0' ($dry.exitCode -eq 0) ('exit ' + $dry.exitCode)
    Assert-LauncherRepair 'dry-report-parsed' ($null -ne $dry.report) ('stdout: ' + $dry.stdout)
    if ($null -ne $dry.report) {
        Assert-LauncherRepair 'dry-no-error' ([string]::IsNullOrEmpty([string]$dry.report.error)) ('error: ' + [string]$dry.report.error)
        Assert-LauncherRepair 'dry-fix-count' (@($dry.report.fixes).Count -eq 7) ('fixes: ' + @($dry.report.fixes).Count + ' (expected 7)')
        foreach ($spec in $script:shortcutSpecs) {
            $status = Get-FixStatus $dry.report $spec.path
            if ($spec.role.StartsWith('decoy-')) {
                Assert-LauncherRepair ('dry-' + $spec.role + '-not-reported') ($status -eq '(not reported)') ('status=' + $status)
            } elseif ($spec.scope -eq 'machine') {
                $fix = Get-Fix $dry.report $spec.path
                Assert-LauncherRepair ('dry-' + $spec.role + '-reported-failed') ($status -eq 'failed') ('status=' + $status)
                Assert-LauncherRepair ('dry-' + $spec.role + '-machine-reason') ($null -ne $fix -and ([string]$fix.reason) -match 'machine-wide') ('reason=' + $(if ($null -ne $fix) { [string]$fix.reason } else { '(none)' }))
            } elseif ($spec.role -eq 'user-already-ok') {
                Assert-LauncherRepair 'dry-already-ok' ($status -eq 'already-ok') ('status=' + $status)
            } else {
                $fix = Get-Fix $dry.report $spec.path
                Assert-LauncherRepair ('dry-' + $spec.role + '-planned') ($status -eq 'updated' -and $null -ne $fix -and ([string]$fix.reason) -eq 'dry-run') ('status=' + $status)
            }
        }
        Assert-LauncherRepair 'dry-registry-planned' ((Get-FixStatus $dry.report $regKey) -eq 'updated') ('status=' + (Get-FixStatus $dry.report $regKey))
        Assert-LauncherRepair 'dry-registry-decoy-not-reported' ((Get-FixStatus $dry.report $regDecoyKey) -eq '(not reported)') ('status=' + (Get-FixStatus $dry.report $regDecoyKey))
    }
    Assert-LauncherRepair 'dry-wrote-nothing' ((Get-LnkSnapshot $allTrackedPaths) -eq $beforeDry) 'the .lnk files must be byte-identical after a dry run'
    Assert-LauncherRepair 'dry-registry-unchanged' (([string](Get-Item -LiteralPath $regKey).GetValue('')) -eq $regBefore) 'the scratch registry value must be unchanged after a dry run'
    Assert-LauncherRepair 'dry-registry-decoy-unchanged' (([string](Get-Item -LiteralPath $regDecoyKey).GetValue('')) -eq $regDecoyBefore) 'the scratch registry decoy value must be unchanged after a dry run'

    # --------------------------------------------------------- 2. real run ----
    Write-Host ''
    Write-Host '=== 2. a real run repairs the user entries and reports the machine ones ==='
    $beforeReal = Get-LnkSnapshot $allTrackedPaths
    $decoyZcodeArgumentsBefore = Get-LnkArguments $userDesktopZcodeDecoy
    $real = Invoke-LauncherRepairProbe -DryRun $false -Name 'real'
    Assert-LauncherRepair 'real-exit0' ($real.exitCode -eq 0) ('exit ' + $real.exitCode)
    Assert-LauncherRepair 'real-report-parsed' ($null -ne $real.report) ('stdout: ' + $real.stdout)
    if ($null -ne $real.report) {
        Assert-LauncherRepair 'real-no-error' ([string]::IsNullOrEmpty([string]$real.report.error)) ('error: ' + [string]$real.report.error)
        Assert-LauncherRepair 'real-fix-count' (@($real.report.fixes).Count -eq 7) ('fixes: ' + @($real.report.fixes).Count + ' (expected 7)')
        foreach ($spec in $script:shortcutSpecs) {
            if ($spec.scope -eq 'machine') {
                $fix = Get-Fix $real.report $spec.path
                Assert-LauncherRepair ('real-' + $spec.role + '-reported-failed') ((Get-FixStatus $real.report $spec.path) -eq 'failed') ('status=' + (Get-FixStatus $real.report $spec.path))
                Assert-LauncherRepair ('real-' + $spec.role + '-machine-reason') ($null -ne $fix -and ([string]$fix.reason) -match 'machine-wide') ('reason=' + $(if ($null -ne $fix) { [string]$fix.reason } else { '(none)' }))
            } elseif (-not $spec.role.StartsWith('decoy-') -and $spec.role -ne 'user-already-ok') {
                Assert-LauncherRepair ('real-' + $spec.role + '-updated') ((Get-FixStatus $real.report $spec.path) -eq 'updated') ('status=' + (Get-FixStatus $real.report $spec.path))
            }
        }
        Assert-LauncherRepair 'real-registry-updated' ((Get-FixStatus $real.report $regKey) -eq 'updated') ('status=' + (Get-FixStatus $real.report $regKey))
        Assert-LauncherRepair 'real-already-ok-status' ((Get-FixStatus $real.report $userDesktopOk) -eq 'already-ok') ('status=' + (Get-FixStatus $real.report $userDesktopOk))
        Assert-LauncherRepair 'real-decoy-zcode-suffix-not-reported' ((Get-FixStatus $real.report $userDesktopZcodeDecoy) -eq '(not reported)') ('status=' + (Get-FixStatus $real.report $userDesktopZcodeDecoy))
        Assert-LauncherRepair 'real-registry-decoy-not-reported' ((Get-FixStatus $real.report $regDecoyKey) -eq '(not reported)') ('status=' + (Get-FixStatus $real.report $regDecoyKey))
    }
    $expectedFlag = '--remote-debugging-port=' + $CdpPort
    Assert-LauncherRepair 'real-user-desktop-flag' ((Get-LnkArguments $userDesktopZcode) -match [regex]::Escape($expectedFlag)) ('arguments=' + (Get-LnkArguments $userDesktopZcode))
    Assert-LauncherRepair 'real-user-start-menu-flag' ((Get-LnkArguments $userStartMenuZcode) -match [regex]::Escape($expectedFlag)) ('arguments=' + (Get-LnkArguments $userStartMenuZcode))
    # This is the regression guard for the ported upstream behaviour: the
    # pinned taskbar shortcut is the one the user clicks.
    Assert-LauncherRepair 'real-user-pinned-taskbar-flag' ((Get-LnkArguments $userTaskBarZcode) -match [regex]::Escape($expectedFlag)) ('arguments=' + (Get-LnkArguments $userTaskBarZcode))
    Assert-LauncherRepair 'real-already-ok-untouched' ((Get-LnkArguments $userDesktopOk) -eq $expectedFlag) ('arguments=' + (Get-LnkArguments $userDesktopOk))
    Assert-LauncherRepair 'real-decoy-untouched' ((Get-FileHashText $userDesktopDecoy) -eq (Get-SnapshotHash $beforeReal $userDesktopDecoy)) 'the decoy shortcut must be byte-identical'
    # The ZCode-named decoy is the regression guard for the exact-file-name gate:
    # a leading-wildcard identity test would have written to it.
    Assert-LauncherRepair 'real-decoy-zcode-suffix-untouched' ((Get-FileHashText $userDesktopZcodeDecoy) -eq (Get-SnapshotHash $beforeReal $userDesktopZcodeDecoy)) 'the NotZCode.exe decoy shortcut must be byte-identical'
    Assert-LauncherRepair 'real-decoy-zcode-suffix-arguments' (((Get-LnkArguments $userDesktopZcodeDecoy) -eq $decoyZcodeArgumentsBefore) -and ((Get-LnkArguments $userDesktopZcodeDecoy) -eq '')) ('arguments=' + (Get-LnkArguments $userDesktopZcodeDecoy))
    Assert-LauncherRepair 'real-malformed-did-not-abort' (Test-Path -LiteralPath $userStartMenuBroken -PathType Leaf) 'the malformed .lnk must still exist and the run must have completed'
    Assert-LauncherRepair 'real-machine-desktop-unchanged' ((Get-FileHashText $machineDesktopZcode) -eq (Get-SnapshotHash $beforeReal $machineDesktopZcode)) 'the machine-wide Desktop shortcut must be byte-identical'
    Assert-LauncherRepair 'real-machine-start-menu-unchanged' ((Get-FileHashText $machineStartMenuZcode) -eq (Get-SnapshotHash $beforeReal $machineStartMenuZcode)) 'the machine-wide Start Menu shortcut must be byte-identical'
    Assert-LauncherRepair 'real-machine-arguments-unchanged' (((Get-LnkArguments $machineDesktopZcode) -eq '') -and ((Get-LnkArguments $machineStartMenuZcode) -eq '')) ('machine desktop=' + (Get-LnkArguments $machineDesktopZcode) + ' start menu=' + (Get-LnkArguments $machineStartMenuZcode))
    $regAfterReal = [string](Get-Item -LiteralPath $regKey).GetValue('')
    Assert-LauncherRepair 'real-registry-value-has-flag' ($regAfterReal -match [regex]::Escape($expectedFlag)) ('value=' + $regAfterReal)
    $regDecoyAfterReal = [string](Get-Item -LiteralPath $regDecoyKey).GetValue('')
    Assert-LauncherRepair 'real-registry-decoy-unchanged' ($regDecoyAfterReal -eq $regDecoyBefore) ('value=' + $regDecoyAfterReal)

    # -------------------------------------------------------- 3. second run ---
    Write-Host ''
    Write-Host '=== 3. a second run is idempotent ==='
    $beforeAgain = Get-LnkSnapshot $allTrackedPaths
    $again = Invoke-LauncherRepairProbe -DryRun $false -Name 'again'
    Assert-LauncherRepair 'again-exit0' ($again.exitCode -eq 0) ('exit ' + $again.exitCode)
    Assert-LauncherRepair 'again-report-parsed' ($null -ne $again.report) ('stdout: ' + $again.stdout)
    if ($null -ne $again.report) {
        $updatedAgain = @($again.report.fixes | Where-Object { $_.status -eq 'updated' })
        $updatedAgainPaths = (@($updatedAgain | ForEach-Object { $_.path }) -join '; ')
        Assert-LauncherRepair 'again-nothing-updated' ($updatedAgain.Count -eq 0) ('updated: ' + $updatedAgainPaths)
        foreach ($spec in $script:shortcutSpecs) {
            if ($spec.scope -eq 'machine') {
                Assert-LauncherRepair ('again-' + $spec.role + '-still-failed') ((Get-FixStatus $again.report $spec.path) -eq 'failed') ('status=' + (Get-FixStatus $again.report $spec.path))
            } elseif (-not $spec.role.StartsWith('decoy-')) {
                Assert-LauncherRepair ('again-' + $spec.role + '-already-ok') ((Get-FixStatus $again.report $spec.path) -eq 'already-ok') ('status=' + (Get-FixStatus $again.report $spec.path))
            }
        }
        Assert-LauncherRepair 'again-registry-already-ok' ((Get-FixStatus $again.report $regKey) -eq 'already-ok') ('status=' + (Get-FixStatus $again.report $regKey))
        Assert-LauncherRepair 'again-registry-decoy-not-reported' ((Get-FixStatus $again.report $regDecoyKey) -eq '(not reported)') ('status=' + (Get-FixStatus $again.report $regDecoyKey))
    }
    Assert-LauncherRepair 'again-files-unchanged' ((Get-LnkSnapshot $allTrackedPaths) -eq $beforeAgain) 'a converged run must not rewrite any shortcut'
    Assert-LauncherRepair 'again-registry-unchanged' (([string](Get-Item -LiteralPath $regKey).GetValue('')) -eq $regAfterReal) 'a converged run must not rewrite the registry value'
    Assert-LauncherRepair 'again-registry-decoy-unchanged' (([string](Get-Item -LiteralPath $regDecoyKey).GetValue('')) -eq $regDecoyBefore) 'a converged run must not rewrite the registry decoy value'

    Write-Host ''
    Write-Host '=== summary ==='
    Write-Host ('passed: ' + $script:passed)
    Write-Host ('failed: ' + $script:failures.Count)
    foreach ($f in $script:failures) { Write-Host ('  - ' + $f) }
    if ($script:failures.Count -eq 0) {
        Write-Host ('RESULT: PASS (' + $script:passed + ' assertion(s))')
    } else {
        Write-Host 'RESULT: FAIL'
        $exitCode = 1
    }
} catch {
    Write-Host ('FAIL harness-error - ' + $_.Exception.Message)
    Write-Host ('RESULT: FAIL')
    $exitCode = 1
} finally {
    # The scratch HKCU key and the scratch tree must not survive the run, even
    # on failure.
    try {
        if (Test-Path -LiteralPath $regPrefix) { Remove-Item -LiteralPath $regPrefix -Recurse -Force -ErrorAction SilentlyContinue }
    } catch { }
    if (Test-Path -LiteralPath $regPrefix) {
        Write-Host ('WARNING: could not remove the scratch registry key ' + $regPrefix)
        $exitCode = 1
    }
    if (-not $KeepTemp) {
        try { Remove-Item -LiteralPath $T -Recurse -Force -ErrorAction SilentlyContinue } catch { }
        if (Test-Path -LiteralPath $T) {
            Write-Host ('WARNING: could not remove the scratch tree ' + $T)
            $exitCode = 1
        }
    } else {
        Write-Host ('[harness] scratch tree kept (-KeepTemp): ' + $T)
    }
}

exit $exitCode
