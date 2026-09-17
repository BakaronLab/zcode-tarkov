#Requires -Version 5.1
<#
  test-lifecycle.ps1 - bounded, temp-only regression coverage for the
  zcode-tarkov user-level lifecycle scripts (install -> repair -> uninstall).

  It runs the real install.ps1 / repair.ps1 / uninstall.ps1 inside a scratch
  tree below $env:TEMP with APPDATA, USERPROFILE and ZCODE_BEAUTIFY_DATA_DIR
  redirected, -NoService everywhere and -ShortcutDir pointing at the scratch
  tree, so the real profile, the real shortcuts, the real HKCU handler values
  and the real resident service are never touched. The real uninstall always
  runs with -KeepOfficialShortcuts, so no real registry value can be written.

  Fail-closed guard: refuses to run unless every path it writes is under
  $env:TEMP, and refuses when a port it needs is already taken.

  Assertions:
    1. a clean install (payload, settings.json, shortcut, no autostart)
    2. install idempotency (the install converges, the shortcut list is stable)
    3. a foreign settings.json is refused; -Force adopts the directory without
       touching the foreign file's siblings
    4. repair.ps1 merges -ShortcutDir into the recorded list (never erases it)
    5. uninstall.ps1 -DryRun changes nothing
    6. a real uninstall removes the install tree and keeps the data directory
    7. a second uninstall reports [absent] instead of failing
    8. the real profile (shortcut hashes, service pid) is unchanged

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\test-lifecycle.ps1
    powershell ... -CdpPort 9445 -ApiPort 9446 -KeepTemp

  Exit codes: 0 every assertion passed, 1 at least one assertion failed,
  2 the harness refused to run (safety guard).
#>
[CmdletBinding()]
param(
    [string]$SourceDir = '',
    [int]$CdpPort = 9445,
    [int]$ApiPort = 9446,
    [switch]$KeepTemp
)

$ErrorActionPreference = 'Continue'
$script:passed = 0
$script:failures = New-Object System.Collections.ArrayList

function Assert-Lifecycle {
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

function Read-JsonFile {
    param([string]$Path)
    $raw = Read-TextFile $Path
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    try { return $raw | ConvertFrom-Json -ErrorAction Stop } catch { return $null }
}

# relpath|length|sha256 for every file below $Root, so "nothing changed" is
# provable instead of assumed.
function Get-TreeManifest {
    param([string]$Root)
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return '' }
    $items = New-Object System.Collections.ArrayList
    foreach ($file in @(Get-ChildItem -LiteralPath $Root -Recurse -Force -File -ErrorAction SilentlyContinue | Sort-Object -Property FullName)) {
        $hash = 'unreadable'
        try { $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256 -ErrorAction Stop).Hash } catch { }
        [void]$items.Add($file.FullName.Substring($Root.Length) + '|' + $file.Length + '|' + $hash)
    }
    return ($items -join "`n")
}

function Get-FileHashText {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '(absent)' }
    try { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop).Hash } catch { return '(unreadable)' }
}

# Runs the child through cmd.exe file redirection (the pattern
# tools\verify-clean-install.ps1 uses): a detached grandchild cannot hang the
# reader, and the child env is set only for the duration of the call.
function Invoke-Redirected {
    param([string[]]$Arguments, [string]$Name, [hashtable]$Env)
    $out = Join-Path $logDir ($Name + '.out.txt')
    $err = Join-Path $logDir ($Name + '.err.txt')
    $cmdPath = Join-Path $logDir ($Name + '.cmd')
    $quoted = New-Object System.Collections.ArrayList
    [void]$quoted.Add('"powershell.exe"')
    foreach ($a in $Arguments) {
        if ($a -match '[\s"]') { [void]$quoted.Add('"' + ($a -replace '"', '\"') + '"') } else { [void]$quoted.Add($a) }
    }
    $lines = @('@echo off', (($quoted -join ' ') + ' > "' + $out + '" 2> "' + $err + '"'), 'exit /b %ERRORLEVEL%')
    [System.IO.File]::WriteAllLines($cmdPath, $lines, (New-Object System.Text.ASCIIEncoding))
    $saved = @{}
    foreach ($key in $Env.Keys) {
        $saved[$key] = [System.Environment]::GetEnvironmentVariable($key, 'Process')
        [System.Environment]::SetEnvironmentVariable($key, $(if ($null -eq $Env[$key]) { $null } else { [string]$Env[$key] }), 'Process')
    }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'cmd.exe'
    $psi.Arguments = '/c "' + $cmdPath + '"'
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $proc = [System.Diagnostics.Process]::Start($psi)
    $proc.WaitForExit()
    $exitCode = $proc.ExitCode
    foreach ($key in $saved.Keys) { [System.Environment]::SetEnvironmentVariable($key, $saved[$key], 'Process') }
    Start-Sleep -Milliseconds 200
    return [ordered]@{ name = $Name; exitCode = $exitCode; stdout = (Read-TextFile $out); stderr = (Read-TextFile $err) }
}

function Test-PortBusy {
    param([int]$Port)
    $client = $null
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $client.Connect('127.0.0.1', $Port)
        return $true
    } catch {
        return $false
    } finally {
        if ($null -ne $client) { try { $client.Close() } catch { } }
    }
}

$repo = $SourceDir
if ([string]::IsNullOrWhiteSpace($repo)) { $repo = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')) }
try { $repo = [System.IO.Path]::GetFullPath($repo) } catch { }

$tempRoot = [System.IO.Path]::GetFullPath($env:TEMP)
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
$T = Join-Path $tempRoot ('zct-lifecycle-' + $stamp)

$installDir = Join-Path $T 'app'
$linksDir = Join-Path $T 'links'
$linksDir2 = Join-Path $T 'links2'
$missingLinksDir = Join-Path $T 'no-such-links'
$foreignDir = Join-Path $T 'foreign'
$foreignLinksDir = Join-Path $T 'foreign-links'
$dataDir = Join-Path $T 'data'
# The v0.2 user data root. The installers resolve it from ZCODE_TARKOV_DATA_DIR
# when it is set, so the child processes below are pointed at a scratch tree:
# without this the install/repair steps would create the real
# %LOCALAPPDATA%\zcode-tarkov\data as a side effect of running the test suite.
$userDataDir = Join-Path $T 'userdata'
$purgeUserDataDir = Join-Path $T 'userdata-purge'
$appdataDir = Join-Path $T 'appdata'
$homeDir = Join-Path $T 'home'
$logDir = Join-Path $T 'logs'
$settingsPath = Join-Path $installDir 'settings.json'

# ------------------------------------------------------------------ safety ---
$guardTargets = [ordered]@{
    scratchRoot = $T
    installDir  = $installDir
    linksDir    = $linksDir
    dataDir     = $dataDir
    userDataDir = $userDataDir
    purgeUserData = $purgeUserDataDir
    appdataDir  = $appdataDir
    homeDir     = $homeDir
    foreignDir  = $foreignDir
    logDir      = $logDir
}
$blocked = @(
    [System.IO.Path]::GetFullPath((Join-Path $env:USERPROFILE 'Desktop')),
    [System.IO.Path]::GetFullPath((Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu')),
    [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs\zcode-tarkov')),
    # The real user media root. Every scratch path above must be outside it: the
    # whole point of -PurgeUserData is that it removes a directory the user may
    # have filled with their own music, so the harness must never aim it at the
    # real one.
    [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'zcode-tarkov')),
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
foreach ($required in @('install.ps1', 'repair.ps1', 'uninstall.ps1', 'dist\cli.js', 'launcher\zcode-tarkov-launch.ps1', 'launcher\zcode-tarkov-discovery.ps1', 'launcher\zcode-tarkov-shortcuts.ps1')) {
    if (-not (Test-Path -LiteralPath (Join-Path $repo $required) -PathType Leaf)) {
        Write-Host ('REFUSING TO RUN: missing ' + (Join-Path $repo $required))
        exit 2
    }
}
$zcodeExe = ''
foreach ($candidate in @(
    (Join-Path ${env:ProgramFiles} 'ZCode\ZCode.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\ZCode\ZCode.exe'),
    $(if (-not [string]::IsNullOrWhiteSpace($env:ZCODE_WINDOWS_APP_INSTALL_DIR)) { Join-Path $env:ZCODE_WINDOWS_APP_INSTALL_DIR 'ZCode.exe' } else { $null })
)) {
    if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { $zcodeExe = $candidate; break }
}
if ([string]::IsNullOrWhiteSpace($zcodeExe)) {
    Write-Host 'REFUSING TO RUN: ZCode.exe not found in C:\Program Files\ZCode, %LOCALAPPDATA%\Programs\ZCode or %ZCODE_WINDOWS_APP_INSTALL_DIR%'
    exit 2
}
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$nodeExe = ''
if ($null -ne $nodeCommand) { $nodeExe = [string]$nodeCommand.Source }
if ([string]::IsNullOrWhiteSpace($nodeExe)) { $nodeExe = 'C:\Program Files\nodejs\node.exe' }
if (-not (Test-Path -LiteralPath $nodeExe -PathType Leaf)) {
    Write-Host ('REFUSING TO RUN: node.exe not found (' + $nodeExe + ')')
    exit 2
}
if (Test-PortBusy -Port $CdpPort) { Write-Host ('REFUSING TO RUN: cdp port ' + $CdpPort + ' is already in use'); exit 2 }
if (Test-PortBusy -Port $ApiPort) { Write-Host ('REFUSING TO RUN: api port ' + $ApiPort + ' is already in use'); exit 2 }

foreach ($d in @($T, $linksDir, $linksDir2, $foreignDir, $foreignLinksDir, $logDir)) {
    if (-not (Test-Path -LiteralPath $d -PathType Container)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
[System.IO.File]::WriteAllText((Join-Path $dataDir 'config.json'), '{"marker":"keep"}' + "`r`n", (New-Object System.Text.ASCIIEncoding))

$childEnv = @{
    APPDATA = $appdataDir
    USERPROFILE = $homeDir
    ZCODE_BEAUTIFY_DATA_DIR = $null
    # Pins the v0.2 data root into the scratch tree. install.ps1, repair.ps1 and
    # uninstall.ps1 all resolve it from this variable when it is present, which
    # is what keeps a test run from creating or deleting anything under the real
    # %LOCALAPPDATA%.
    ZCODE_TARKOV_DATA_DIR = $userDataDir
    ZCODE_WINDOWS_APP_INSTALL_DIR = $null
}
$autostartEntry = Join-Path $appdataDir 'Microsoft\Windows\Start Menu\Programs\Startup\zcode-beautify.vbs'

$installBase = @(
    (Join-Path $repo 'install.ps1'),
    '-InstallDir', $installDir,
    '-SourceDir', $repo,
    '-ShortcutDir', $linksDir,
    '-DataDir', $dataDir,
    '-NoService',
    '-CdpPort', [string]$CdpPort,
    '-ApiPort', [string]$ApiPort,
    '-ZcodeExe', $zcodeExe
)
$repairBase = @(
    (Join-Path $repo 'repair.ps1'),
    '-InstallDir', $installDir,
    '-NoService',
    '-CdpPort', [string]$CdpPort,
    '-ApiPort', [string]$ApiPort
)
$uninstallBase = @(
    (Join-Path $repo 'uninstall.ps1'),
    '-InstallDir', $installDir,
    '-DataDir', $dataDir,
    '-CdpPort', [string]$CdpPort,
    '-ApiPort', [string]$ApiPort,
    '-ShortcutDir', $linksDir,
    '-KeepLegacyShortcut'
)

$realDesktopLnk = Join-Path $env:USERPROFILE 'Desktop\ZCode Tarkov.lnk'
$realStartMenuLnk = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\ZCode.lnk'
$realStartupVbs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\zcode-beautify.vbs'
$realBefore = [ordered]@{
    desktopLnk = Get-FileHashText $realDesktopLnk
    startMenuLnk = Get-FileHashText $realStartMenuLnk
    startupVbs = Get-FileHashText $realStartupVbs
    service9223 = ''
}
$serviceListen = Get-NetTCPConnection -LocalPort 9223 -State Listen -ErrorAction SilentlyContinue
if ($null -ne $serviceListen) { $realBefore.service9223 = [string](@($serviceListen)[0].OwningProcess) }

Write-Host ('[harness] scratch root: ' + $T)
Write-Host ('[harness] repo:         ' + $repo)
Write-Host ('[harness] ports:        cdp ' + $CdpPort + ', api ' + $ApiPort + ' (both verified free)')
Write-Host ('[harness] real profile: desktop=' + $realBefore.desktopLnk + ' startmenu=' + $realBefore.startMenuLnk + ' startup=' + $realBefore.startupVbs + ' service9223=' + $realBefore.service9223)

# ------------------------------------------------------- 1. clean install ----
Write-Host ''
Write-Host '=== 1. clean install (-NoService, temp shortcut dir) ==='
$install1 = Invoke-Redirected -Arguments (@('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File') + $installBase) -Name 'install-1' -Env $childEnv
Write-Host ('[install-1] exit code: ' + $install1.exitCode)
Write-Host $install1.stdout
Assert-Lifecycle 'install-clean-exit0' ($install1.exitCode -eq 0) ('exit ' + $install1.exitCode)
$settings1 = Read-JsonFile $settingsPath
Assert-Lifecycle 'install-clean-settings' ($null -ne $settings1 -and [string]$settings1.product -eq 'zcode-tarkov') 'settings.json must exist and carry product zcode-tarkov'
Assert-Lifecycle 'install-clean-payload' ((Test-Path -LiteralPath (Join-Path $installDir 'dist\cli.js') -PathType Leaf) -and (Test-Path -LiteralPath (Join-Path $installDir 'launcher\zcode-tarkov-launch.ps1') -PathType Leaf) -and (Test-Path -LiteralPath (Join-Path $installDir 'uninstall.ps1') -PathType Leaf)) 'dist/cli.js, launcher and the copied uninstall.ps1 must exist'
$recordedLink = Join-Path $linksDir 'ZCode Tarkov.lnk'
Assert-Lifecycle 'install-clean-shortcut' (Test-Path -LiteralPath $recordedLink -PathType Leaf) ('expected ' + $recordedLink)
if ($null -ne $settings1) {
    Assert-Lifecycle 'install-clean-recorded-datadir' ([string]$settings1.dataDir -eq $dataDir) ('settings.dataDir=' + [string]$settings1.dataDir)
    Assert-Lifecycle 'install-clean-recorded-shortcut' (@($settings1.shortcuts) -contains $recordedLink) ('settings.shortcuts=' + (@($settings1.shortcuts) -join '; '))
} else {
    Assert-Lifecycle 'install-clean-recorded-datadir' $false 'settings.json is unreadable'
    Assert-Lifecycle 'install-clean-recorded-shortcut' $false 'settings.json is unreadable'
}
Assert-Lifecycle 'install-clean-no-autostart' (-not (Test-Path -LiteralPath $autostartEntry)) ('-NoService must not write ' + $autostartEntry)

# The v0.2 user data root. install.ps1 must create it (and its media
# subdirectories) from scratch, and must record where it put it.
$mediaKinds = @('music', 'sounds', 'voice', 'pet', 'status')
$missingDirs = @()
foreach ($kind in $mediaKinds) {
    if (-not (Test-Path -LiteralPath (Join-Path $userDataDir $kind) -PathType Container)) { $missingDirs += $kind }
}
Assert-Lifecycle 'install-creates-user-data-root' ($missingDirs.Count -eq 0) ('missing media directories: ' + ($missingDirs -join ', '))
# The installer's own report carries the resolved root; settings.json deliberately
# does not, because the launcher and the service both resolve the same platform
# default and a second copy could only disagree with it. What matters here is that
# the installer *says* where it put the user's data.
Assert-Lifecycle 'install-reports-user-data-root' ($install1.stdout -match [regex]::Escape($userDataDir)) ('the install report must name ' + $userDataDir)

# Seed user media, so the preservation assertions below have something to lose.
$mediaMarker = Join-Path $userDataDir 'music\harness-marker.mp3'
[System.IO.File]::WriteAllText($mediaMarker, 'harness-media' + "`r`n", (New-Object System.Text.ASCIIEncoding))
$prefsMarker = Join-Path $userDataDir 'prefs.json'
[System.IO.File]::WriteAllText($prefsMarker, '{"harness":true}' + "`r`n", (New-Object System.Text.ASCIIEncoding))
# A second, pristine root used only by the purge case, so the preservation case
# above still has its media to prove it kept.
New-Item -ItemType Directory -Path (Join-Path $purgeUserDataDir 'music') -Force | Out-Null
$purgeMarker = Join-Path $purgeUserDataDir 'music\purge-marker.mp3'
[System.IO.File]::WriteAllText($purgeMarker, 'purge-media' + "`r`n", (New-Object System.Text.ASCIIEncoding))

# ---------------------------------------------------------- 2. idempotency ---
Write-Host ''
Write-Host '=== 2. install idempotency ==='
$install2 = Invoke-Redirected -Arguments (@('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File') + $installBase) -Name 'install-2' -Env $childEnv
Write-Host ('[install-2] exit code: ' + $install2.exitCode)
$settings2 = Read-JsonFile $settingsPath
Assert-Lifecycle 'install-again-exit0' ($install2.exitCode -eq 0) ('exit ' + $install2.exitCode)
Assert-Lifecycle 'install-idempotent-installedat' ($null -ne $settings1 -and $null -ne $settings2 -and [string]$settings2.installedAt -eq [string]$settings1.installedAt) 'installedAt must be preserved across re-installs'
Assert-Lifecycle 'install-idempotent-shortcuts' ($null -ne $settings1 -and $null -ne $settings2 -and (@($settings2.shortcuts) -join ';') -eq (@($settings1.shortcuts) -join ';')) 'the recorded shortcut list must not change on a re-install'
Assert-Lifecycle 'install-idempotent-payload' (Test-Path -LiteralPath (Join-Path $installDir 'dist\cli.js') -PathType Leaf) 'the payload must still be complete'

# ------------------------------------------------- 3. foreign settings.json ---
Write-Host ''
Write-Host '=== 3. a foreign settings.json is refused (and -Force adopts it) ==='
$foreignSettingsPath = Join-Path $foreignDir 'settings.json'
$foreignContent = '{"product":"other-app","note":"not ours"}' + "`r`n"
[System.IO.File]::WriteAllText($foreignSettingsPath, $foreignContent, (New-Object System.Text.ASCIIEncoding))
[System.IO.File]::WriteAllText((Join-Path $foreignDir 'foreign-sibling.txt'), 'keep-me' + "`r`n", (New-Object System.Text.ASCIIEncoding))
$foreignBase = @(
    (Join-Path $repo 'install.ps1'),
    '-InstallDir', $foreignDir,
    '-SourceDir', $repo,
    '-ShortcutDir', $foreignLinksDir,
    '-DataDir', $dataDir,
    '-NoService',
    '-CdpPort', [string]$CdpPort,
    '-ApiPort', [string]$ApiPort,
    '-ZcodeExe', $zcodeExe
)
$installForeign = Invoke-Redirected -Arguments (@('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File') + $foreignBase) -Name 'install-foreign' -Env $childEnv
Write-Host ('[install-foreign] exit code: ' + $installForeign.exitCode)
Write-Host $installForeign.stdout
Assert-Lifecycle 'install-foreign-exit1' ($installForeign.exitCode -eq 1) ('exit ' + $installForeign.exitCode + ' (expected 1)')
Assert-Lifecycle 'install-foreign-message' (($installForeign.stdout -match 'settings\.json') -and ($installForeign.stdout -match 'other-app')) 'the refusal must name the file and what was found'
Assert-Lifecycle 'install-foreign-settings-unchanged' ((Read-TextFile $foreignSettingsPath) -eq $foreignContent) 'the foreign settings.json must not be overwritten'
Assert-Lifecycle 'install-foreign-sibling-kept' ((Read-TextFile (Join-Path $foreignDir 'foreign-sibling.txt')) -match 'keep-me') 'the foreign sibling file must survive the refusal'
Assert-Lifecycle 'install-foreign-nothing-copied' ((-not (Test-Path -LiteralPath (Join-Path $foreignDir 'dist'))) -and (-not (Test-Path -LiteralPath (Join-Path $foreignDir 'launcher')))) 'no payload may be copied into a refused directory'

$installForce = Invoke-Redirected -Arguments (@('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File') + $foreignBase + @('-Force')) -Name 'install-force' -Env $childEnv
Write-Host ('[install-force] exit code: ' + $installForce.exitCode)
$foreignSettingsAfter = Read-JsonFile $foreignSettingsPath
Assert-Lifecycle 'install-force-exit0' ($installForce.exitCode -eq 0) ('exit ' + $installForce.exitCode)
Assert-Lifecycle 'install-force-product' ($null -ne $foreignSettingsAfter -and [string]$foreignSettingsAfter.product -eq 'zcode-tarkov') 'settings.json must be ours after -Force'
Assert-Lifecycle 'install-force-sibling-kept' ((Read-TextFile (Join-Path $foreignDir 'foreign-sibling.txt')) -match 'keep-me') 'the foreign sibling file must survive the -Force adoption'

# ------------------------------------- 4. repair keeps the recorded shortcuts -
Write-Host ''
Write-Host '=== 4. repair -ShortcutDir merges instead of erasing ==='
$repairMissing = Invoke-Redirected -Arguments (@('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File') + $repairBase + @('-ShortcutDir', $missingLinksDir)) -Name 'repair-missing-links' -Env $childEnv
Write-Host ('[repair-missing-links] exit code: ' + $repairMissing.exitCode)
Write-Host $repairMissing.stdout
Assert-Lifecycle 'repair-missing-dir-exit0' ($repairMissing.exitCode -eq 0) ('exit ' + $repairMissing.exitCode)
$settings3 = Read-JsonFile $settingsPath
Assert-Lifecycle 'repair-missing-dir-list-kept' ($null -ne $settings3 -and (@($settings3.shortcuts) -contains $recordedLink)) ('settings.shortcuts=' + $(if ($null -ne $settings3) { @($settings3.shortcuts) -join '; ' } else { 'unreadable' }))
Assert-Lifecycle 'repair-missing-dir-shortcut-recreated' (Test-Path -LiteralPath $recordedLink -PathType Leaf) ('expected ' + $recordedLink)

$newLink = Join-Path $linksDir2 'ZCode Tarkov.lnk'
$repairMerge = Invoke-Redirected -Arguments (@('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File') + $repairBase + @('-ShortcutDir', $linksDir2)) -Name 'repair-merge' -Env $childEnv
Write-Host ('[repair-merge] exit code: ' + $repairMerge.exitCode)
$settings4 = Read-JsonFile $settingsPath
Assert-Lifecycle 'repair-merge-exit0' ($repairMerge.exitCode -eq 0) ('exit ' + $repairMerge.exitCode)
Assert-Lifecycle 'repair-merge-new-link' ($null -ne $settings4 -and (@($settings4.shortcuts) -contains $newLink)) ('settings.shortcuts=' + $(if ($null -ne $settings4) { @($settings4.shortcuts) -join '; ' } else { 'unreadable' }))
Assert-Lifecycle 'repair-merge-recorded-link' ($null -ne $settings4 -and (@($settings4.shortcuts) -contains $recordedLink)) 'the previously recorded link must stay recorded'
Assert-Lifecycle 'repair-merge-shortcut-written' (Test-Path -LiteralPath $newLink -PathType Leaf) ('expected ' + $newLink)

# ------------------------------------------------- 5. uninstall -DryRun ------
Write-Host ''
Write-Host '=== 5. uninstall -DryRun changes nothing ==='
$dataMarkerBefore = Read-TextFile (Join-Path $dataDir 'config.json')
$installManifestBefore = Get-TreeManifest $installDir
$linkManifestBefore = (Get-FileHashText $recordedLink) + '|' + (Get-FileHashText $newLink)
$unDry = Invoke-Redirected -Arguments (@('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File') + $uninstallBase + @('-DryRun')) -Name 'uninstall-dryrun' -Env $childEnv
Write-Host ('[uninstall-dryrun] exit code: ' + $unDry.exitCode)
Write-Host $unDry.stdout
Assert-Lifecycle 'uninstall-dryrun-exit0' ($unDry.exitCode -eq 0) ('exit ' + $unDry.exitCode)
Assert-Lifecycle 'uninstall-dryrun-tree-unchanged' ((Get-TreeManifest $installDir) -eq $installManifestBefore) 'the install tree must be byte-identical after -DryRun'
Assert-Lifecycle 'uninstall-dryrun-shortcuts-unchanged' (((Get-FileHashText $recordedLink) + '|' + (Get-FileHashText $newLink)) -eq $linkManifestBefore) 'the shortcuts must be untouched by -DryRun'
Assert-Lifecycle 'uninstall-dryrun-datadir-unchanged' ((Read-TextFile (Join-Path $dataDir 'config.json')) -eq $dataMarkerBefore) 'the data directory must be untouched by -DryRun'
Assert-Lifecycle 'uninstall-dryrun-datadir-kept' (Test-Path -LiteralPath $dataDir -PathType Container) 'the data directory must survive -DryRun'

# ---------------------------------------------------- 6. real uninstall ------
Write-Host ''
Write-Host '=== 6. real uninstall (data directory kept) ==='
$unReal = Invoke-Redirected -Arguments (@('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File') + $uninstallBase + @('-KeepOfficialShortcuts')) -Name 'uninstall-real' -Env $childEnv
Write-Host ('[uninstall-real] exit code: ' + $unReal.exitCode)
Write-Host $unReal.stdout
Assert-Lifecycle 'uninstall-real-exit0' ($unReal.exitCode -eq 0) ('exit ' + $unReal.exitCode)
Assert-Lifecycle 'uninstall-real-install-dir-gone' (-not (Test-Path -LiteralPath $installDir)) ('still present: ' + $installDir)
Assert-Lifecycle 'uninstall-real-shortcut-gone' (-not (Test-Path -LiteralPath $recordedLink)) ('still present: ' + $recordedLink)
Assert-Lifecycle 'uninstall-real-merged-shortcut-gone' (-not (Test-Path -LiteralPath $newLink)) ('still present: ' + $newLink)
Assert-Lifecycle 'uninstall-real-data-dir-kept' ((Test-Path -LiteralPath (Join-Path $dataDir 'config.json') -PathType Leaf) -and ((Read-TextFile (Join-Path $dataDir 'config.json')) -eq $dataMarkerBefore)) 'the data directory must be kept without -RemoveData'
Assert-Lifecycle 'uninstall-real-no-autostart' (-not (Test-Path -LiteralPath $autostartEntry)) 'no autostart entry may exist in the redirected APPDATA'
# The whole point of the v0.2 uninstaller: it removes the program and leaves the
# user's media and settings exactly as they were. A user with gigabytes of their
# own music must be able to uninstall without losing it.
Assert-Lifecycle 'uninstall-preserves-media' ((Test-Path -LiteralPath $mediaMarker -PathType Leaf) -and ((Read-TextFile $mediaMarker) -match 'harness-media')) 'user media must survive an uninstall'
Assert-Lifecycle 'uninstall-preserves-prefs' ((Test-Path -LiteralPath $prefsMarker -PathType Leaf) -and ((Read-TextFile $prefsMarker) -match 'harness')) 'prefs.json must survive an uninstall'
$keptDirs = @()
foreach ($kind in $mediaKinds) {
    if (-not (Test-Path -LiteralPath (Join-Path $userDataDir $kind) -PathType Container)) { $keptDirs += $kind }
}
Assert-Lifecycle 'uninstall-preserves-media-dirs' ($keptDirs.Count -eq 0) ('removed media directories: ' + ($keptDirs -join ', '))
Assert-Lifecycle 'uninstall-reports-preserved' ($unReal.stdout -match 'user data|userDataDir|preserv') 'the uninstaller must say what it kept and where'

# ------------------------------- 6b. uninstall -PurgeUserData deletes media --
Write-Host ''
Write-Host '=== 6b. uninstall -PurgeUserData removes the data root ==='
# A separate root for this case, reached through its own environment, so that
# "purge removed the root it was aimed at" and "purge did not touch any other
# root" are two independent observations rather than one.
$purgeEnv = $childEnv.Clone()
$purgeEnv['ZCODE_TARKOV_DATA_DIR'] = $purgeUserDataDir
$unPurge = Invoke-Redirected -Arguments (@('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File') + $uninstallBase + @('-KeepOfficialShortcuts', '-PurgeUserData')) -Name 'uninstall-purge' -Env $purgeEnv
Write-Host ('[uninstall-purge] exit code: ' + $unPurge.exitCode)
Write-Host $unPurge.stdout
Assert-Lifecycle 'uninstall-purge-exit0' ($unPurge.exitCode -eq 0) ('exit ' + $unPurge.exitCode)
Assert-Lifecycle 'uninstall-purge-root-gone' (-not (Test-Path -LiteralPath $purgeUserDataDir)) ('-PurgeUserData must remove an emptied data root; still present: ' + $purgeUserDataDir)
Assert-Lifecycle 'uninstall-purge-media-gone' (-not (Test-Path -LiteralPath $purgeMarker)) '-PurgeUserData must remove the media inside it too'
# And it must be precisely scoped: the other root is untouched.
Assert-Lifecycle 'uninstall-purge-left-other-root' (Test-Path -LiteralPath $mediaMarker -PathType Leaf) 'purging one root must not touch another'

# ------------------------------ 6c. -PurgeUserData never eats foreign files --
Write-Host ''
Write-Host '=== 6c. -PurgeUserData removes only this project''s own files ==='
# The documented reason to relocate the media root is to put it on a drive that
# already holds a library (ZCODE_TARKOV_DATA_DIR), so a purge must not be able
# to take anything this project did not create. This case gives the root both
# our directories and a foreign one, and asserts the foreign one survives with
# the root intact.
$sharedUserDataDir = Join-Path $T 'userdata-shared'
New-Item -ItemType Directory -Path (Join-Path $sharedUserDataDir 'music') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $sharedUserDataDir 'sounds') -Force | Out-Null
$sharedMarker = Join-Path $sharedUserDataDir 'music\shared-marker.mp3'
[System.IO.File]::WriteAllText($sharedMarker, 'shared-media' + "`r`n", (New-Object System.Text.ASCIIEncoding))
$sharedPrefs = Join-Path $sharedUserDataDir 'prefs.json'
[System.IO.File]::WriteAllText($sharedPrefs, '{"shared":true}' + "`r`n", (New-Object System.Text.ASCIIEncoding))
$foreignKeep = Join-Path $sharedUserDataDir 'my-own-albums'
New-Item -ItemType Directory -Path $foreignKeep -Force | Out-Null
$foreignMarker = Join-Path $foreignKeep 'irreplaceable.flac'
[System.IO.File]::WriteAllText($foreignMarker, 'not-ours' + "`r`n", (New-Object System.Text.ASCIIEncoding))

$sharedEnv = $childEnv.Clone()
$sharedEnv['ZCODE_TARKOV_DATA_DIR'] = $sharedUserDataDir
$unShared = Invoke-Redirected -Arguments (@('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File') + $uninstallBase + @('-KeepOfficialShortcuts', '-PurgeUserData')) -Name 'uninstall-purge-shared' -Env $sharedEnv
Write-Host ('[uninstall-purge-shared] exit code: ' + $unShared.exitCode)
Write-Host $unShared.stdout
Assert-Lifecycle 'purge-shared-exit0' ($unShared.exitCode -eq 0) ('exit ' + $unShared.exitCode)
Assert-Lifecycle 'purge-shared-removed-our-media' (-not (Test-Path -LiteralPath $sharedMarker)) 'our own media directory must be purged'
Assert-Lifecycle 'purge-shared-removed-prefs' (-not (Test-Path -LiteralPath $sharedPrefs)) 'our own prefs.json must be purged'
Assert-Lifecycle 'purge-shared-kept-foreign-file' ((Test-Path -LiteralPath $foreignMarker -PathType Leaf) -and ((Read-TextFile $foreignMarker) -match 'not-ours')) 'a file this project did not create must survive -PurgeUserData'
Assert-Lifecycle 'purge-shared-kept-root' (Test-Path -LiteralPath $sharedUserDataDir -PathType Container) 'the root must survive while it still holds foreign entries'
Assert-Lifecycle 'purge-shared-reports-what-it-kept' ($unShared.stdout -match 'did not create') 'the output must name what it left behind'

# ------------------------------------------------ 7. second uninstall --------
Write-Host ''
Write-Host '=== 7. second uninstall reports [absent] instead of failing ==='
$unAgain = Invoke-Redirected -Arguments (@('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File') + $uninstallBase + @('-KeepOfficialShortcuts')) -Name 'uninstall-again' -Env $childEnv
Write-Host ('[uninstall-again] exit code: ' + $unAgain.exitCode)
Write-Host $unAgain.stdout
Assert-Lifecycle 'uninstall-again-exit0' ($unAgain.exitCode -eq 0) ('exit ' + $unAgain.exitCode)
Assert-Lifecycle 'uninstall-again-absent' ($unAgain.stdout -match '\[absent\]') 'the second run must report what is already gone as [absent]'
Assert-Lifecycle 'uninstall-again-no-fail' (($unAgain.stdout -notmatch '\[fail\]') -and ($unAgain.stdout -notmatch 'INCOMPLETE')) 'the second run must not report a failure'

# ------------------------------------------------ 8. real profile untouched --
Write-Host ''
Write-Host '=== 8. the real profile is unchanged ==='
$serviceListenAfter = Get-NetTCPConnection -LocalPort 9223 -State Listen -ErrorAction SilentlyContinue
$servicePidAfter = ''
if ($null -ne $serviceListenAfter) { $servicePidAfter = [string](@($serviceListenAfter)[0].OwningProcess) }
$realAfter = (Get-FileHashText $realDesktopLnk) + '|' + (Get-FileHashText $realStartMenuLnk) + '|' + (Get-FileHashText $realStartupVbs)
$realExpected = [string]$realBefore.desktopLnk + '|' + [string]$realBefore.startMenuLnk + '|' + [string]$realBefore.startupVbs
Assert-Lifecycle 'real-profile-files-unchanged' ($realAfter -eq $realExpected) 'the real shortcuts and the real Startup entry must be byte-identical'
Assert-Lifecycle 'real-service-pid-unchanged' ($servicePidAfter -eq [string]$realBefore.service9223) ('9223 pid ' + $realBefore.service9223 + ' -> ' + $servicePidAfter)

# ---------------------------------------------------------------- cleanup ---
if (-not $KeepTemp) {
    try { Remove-Item -LiteralPath $T -Recurse -Force -ErrorAction SilentlyContinue } catch { }
    if (Test-Path -LiteralPath $T) { Assert-Lifecycle 'scratch-tree-removed' $false ('still present: ' + $T) } else { Assert-Lifecycle 'scratch-tree-removed' $true }
} else {
    Write-Host ('[harness] scratch tree kept (-KeepTemp): ' + $T)
}

# ---------------------------------------------------------------- summary ---
Write-Host ''
Write-Host '=== summary ==='
Write-Host ('passed: ' + $script:passed)
Write-Host ('failed: ' + $script:failures.Count)
foreach ($f in $script:failures) { Write-Host ('  - ' + $f) }
if ($script:failures.Count -eq 0) {
    Write-Host ('RESULT: PASS (' + $script:passed + ' assertion(s))')
    exit 0
}
Write-Host 'RESULT: FAIL'
exit 1
