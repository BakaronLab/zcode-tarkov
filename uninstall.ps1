#Requires -Version 5.1
#
# zcode-tarkov uninstaller (user-level, idempotent)
#
# Purpose
#   Reverses what install.ps1 and the launcher created: it stops the resident
#   theme service that runs from this install, removes the sign-in autostart
#   entry the CLI registered, deletes the "ZCode Tarkov" launcher shortcuts it
#   wrote, restores official ZCode launcher entries that an earlier playtest
#   build had added --remote-debugging-port to, and removes the install
#   directory that carries our settings.json marker. With -RemoveData it also
#   deletes the files the CLI stored in its old data directory.
#
#   The v0.2 user data root - music, sounds, voice, pet art, status texts and
#   prefs.json below %LOCALAPPDATA%\zcode-tarkov\data - is a different matter:
#   it holds files the user put there, so it is always kept and only deleted
#   when -PurgeUserData says so explicitly. An uninstall must never be able to
#   destroy a media library by being run.
#
#   Every destructive step is identity-verified first (marker file, exact path,
#   exact argument token, inspected command line). When identity cannot be
#   proven, that step is refused, reported loudly, and the rest of the sweep
#   continues.
#
# Usage
#   powershell -NoProfile -ExecutionPolicy Bypass -File uninstall.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File uninstall.ps1 -DryRun
#   powershell -NoProfile -ExecutionPolicy Bypass -File uninstall.ps1 -RemoveData
#   powershell -NoProfile -ExecutionPolicy Bypass -File uninstall.ps1 -PurgeUserData
#   powershell -NoProfile -ExecutionPolicy Bypass -File uninstall.ps1 -InstallDir <dir> -ApiPort 19333 -ShortcutDir <dir>
#
#   -InstallDir            default %LOCALAPPDATA%\Programs\zcode-tarkov
#   -DataDir               default: settings.json, then the CLI's own location
#   -CdpPort / -ApiPort    0 = read settings.json, then 9222 / 9223
#   -ShortcutDir           extra directories to sweep for "ZCode Tarkov.lnk"
#   -RemoveData            also delete the CLI's known files in the old data dir
#   -PurgeUserData         also delete the v0.2 user data root
#                          (%LOCALAPPDATA%\zcode-tarkov\data, or
#                          ZCODE_TARKOV_DATA_DIR): music, sounds, voice, pet,
#                          status and prefs.json. Without this switch the whole
#                          root is kept untouched, bit for bit.
#   -KeepLegacyShortcut    keep a "ZCode Tarkov.lnk" that points straight at
#                          ZCode.exe (the older playtest launcher entry)
#   -KeepOfficialShortcuts keep official shortcuts and handler values untouched
#   -DryRun                report the whole plan; write and stop nothing
#   -Force                 remove an install directory that carries no
#                          zcode-tarkov settings.json, delete a directory
#                          reparse point instead of refusing it, and skip the
#                          %LOCALAPPDATA%/%TEMP% location guard (the same
#                          override applies to the -PurgeUserData guards; a
#                          drive root is still never deleted)
#   -Json                  print only a machine-readable JSON summary
#
# Exit codes
#   0  the sweep completed (warnings are allowed)
#   1  a step refused or failed and needs the user's attention
#
# Safety
#   User-level only. This script never elevates (-Verb RunAs is never used),
#   never writes to machine-wide locations (C:\Program Files, %ProgramData%,
#   %PUBLIC%), never writes HKLM, PATH or any persistent environment variable,
#   and never modifies ZCode's installation files (it only reads them).
#
#   It removes only content zcode-tarkov created; it never touches ZCode's
#   installation, its profile, or its official shortcuts. A process is only
#   stopped when its name is node.exe AND its command line runs this install's
#   CLI bundle AND it carries the serve/watch token, so a port that belongs to
#   something else is never killed by number. An official shortcut is never
#   deleted: at most the --remote-debugging-port token for the configured cdp
#   port (or the historical 9222) that a playtest build injected into it is
#   removed again. A recursive delete never follows a directory reparse point
#   (junction/symlink): the link is skipped and reported instead.
#
#   The v0.2 user data root holds files the user put there, so it is not part
#   of the default sweep at all: only -PurgeUserData deletes it, and a reparse
#   point at the root itself is refused (a recursive delete through a junction
#   would destroy the link target), as is a path that is a drive root.
#
#   It never reads from stdin, never pauses and never prompts.
#
[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\zcode-tarkov'),
    [string]$DataDir,
    [int]$CdpPort = 0,
    [int]$ApiPort = 0,
    [string[]]$ShortcutDir = @(),
    [switch]$RemoveData,
    [switch]$PurgeUserData,
    [switch]$KeepLegacyShortcut,
    [switch]$KeepOfficialShortcuts,
    [switch]$DryRun,
    [switch]$Force,
    [switch]$Json
)

$ErrorActionPreference = 'Continue'

# --------------------------------------------------------------- normalizing --
try { $InstallDir = [System.IO.Path]::GetFullPath($InstallDir) } catch { }
if ($InstallDir.EndsWith('\') -and $InstallDir.Length -gt 3) { $InstallDir = $InstallDir.TrimEnd('\') }
if (-not [string]::IsNullOrWhiteSpace($DataDir)) {
    try { $DataDir = [System.IO.Path]::GetFullPath($DataDir) } catch { }
    if ($DataDir.EndsWith('\') -and $DataDir.Length -gt 3) { $DataDir = $DataDir.TrimEnd('\') }
}

$settingsPath = Join-Path $InstallDir 'settings.json'
$cliPath = Join-Path $InstallDir 'dist\cli.js'
$autostartEntry = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\zcode-beautify.vbs'
$desktopDir = Join-Path $env:USERPROFILE 'Desktop'
$startMenuDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
# The five directories of the v0.2 user data root (MEDIA_KINDS in
# src/prefs/types.ts), reported individually so a user with a large music
# library can see that each one survived.
$userDataSubdirs = @('music', 'sounds', 'voice', 'pet', 'status')

$rows = New-Object System.Collections.ArrayList
$removedList = New-Object System.Collections.ArrayList
$keptList = New-Object System.Collections.ArrayList
$refusedList = New-Object System.Collections.ArrayList
$warningList = New-Object System.Collections.ArrayList
$failureList = New-Object System.Collections.ArrayList
$notTouched = New-Object System.Collections.ArrayList

function Add-Row {
    param([string]$Tag, [string]$Class, [string]$What, [string]$Detail)
    [void]$rows.Add(@{ Tag = $Tag; Class = $Class; What = $What; Detail = $Detail })
    $entry = [string]$What + ' - ' + [string]$Detail
    if ($Class -eq 'removed') { [void]$removedList.Add($entry) }
    elseif ($Class -eq 'kept') { [void]$keptList.Add($entry) }
    elseif ($Class -eq 'refused') { [void]$refusedList.Add($entry) }
    elseif ($Class -eq 'warn') { [void]$warningList.Add($entry) }
    elseif ($Class -eq 'fail') { [void]$failureList.Add($entry) }
}

function Add-Removed {
    param([string]$What, [string]$Detail)
    if ($DryRun) { Add-Row -Tag '[removed]' -Class 'removed' -What $What -Detail ('dry run: would remove ' + $Detail) }
    else { Add-Row -Tag '[removed]' -Class 'removed' -What $What -Detail $Detail }
}

function Add-Absent {
    param([string]$What, [string]$Detail)
    Add-Row -Tag '[absent] ' -Class 'absent' -What $What -Detail $Detail
}

function Add-Kept {
    param([string]$What, [string]$Detail)
    Add-Row -Tag '[kept]   ' -Class 'kept' -What $What -Detail $Detail
}

function Add-Refused {
    param([string]$What, [string]$Detail)
    Add-Row -Tag '[refused]' -Class 'refused' -What $What -Detail $Detail
}

function Add-Failed {
    param([string]$What, [string]$Detail)
    Add-Row -Tag '[fail]   ' -Class 'fail' -What $What -Detail $Detail
}

function Add-Info {
    param([string]$What, [string]$Detail)
    Add-Row -Tag '[info]   ' -Class 'info' -What $What -Detail $Detail
}

# True when $Path lives below one of the given roots (used as a guard against a
# bad -InstallDir that points at a repository or a drive root).
function Test-ZctPathUnder {
    param([string]$Path, [string[]]$Roots)
    foreach ($root in $Roots) {
        if ([string]::IsNullOrWhiteSpace($root)) { continue }
        $base = $root
        try { $base = [System.IO.Path]::GetFullPath($base) } catch { }
        if (-not $base.EndsWith('\')) { $base = $base + '\' }
        if ($Path.StartsWith($base, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
    }
    return $false
}

# Where the CLI would keep its data when settings.json does not say (mirrors
# dataDir() in src/core/launch.ts, including the legacy directory names).
function Get-ZctDefaultDataDir {
    if (-not [string]::IsNullOrWhiteSpace($env:ZCODE_BEAUTIFY_DATA_DIR)) { return $env:ZCODE_BEAUTIFY_DATA_DIR }
    $root = Join-Path $env:USERPROFILE '.zcode\cli\plugins\data'
    foreach ($name in @('zcode-tarkov@zcode-tarkov', 'zcode-tarkov', 'zcode-beautify@zcode-beautify', 'zcode-beautify')) {
        $candidate = Join-Path $root $name
        if (Test-Path -LiteralPath $candidate -PathType Container) { return $candidate }
    }
    return (Join-Path $root 'zcode-tarkov')
}

# Where the v0.2 user data root is: the directory that holds the user's music,
# sounds, voice, pet art, status texts and prefs.json. Mirrors dataRoot() in
# src/core/dataRoot.ts, including the ZCODE_TARKOV_DATA_DIR override, and falls
# back to %LOCALAPPDATA% (then %USERPROFILE%\AppData\Local) exactly like the
# runtime does. It is kept unless -PurgeUserData is given.
function Get-ZctUserDataRoot {
    if (-not [string]::IsNullOrWhiteSpace($env:ZCODE_TARKOV_DATA_DIR)) {
        $root = $env:ZCODE_TARKOV_DATA_DIR
        try { $root = [System.IO.Path]::GetFullPath($root) } catch { }
        if ($root.EndsWith('\') -and $root.Length -gt 3) { $root = $root.TrimEnd('\') }
        return $root
    }
    $base = $env:LOCALAPPDATA
    if ([string]::IsNullOrWhiteSpace($base)) {
        if ([string]::IsNullOrWhiteSpace($env:USERPROFILE)) { return '' }
        $base = Join-Path $env:USERPROFILE 'AppData\Local'
    }
    return (Join-Path $base 'zcode-tarkov\data')
}

function Write-Report {
    foreach ($row in $rows) {
        Write-Host ('{0} {1,-18} - {2}' -f [string]$row.Tag, [string]$row.What, [string]$row.Detail)
    }
}

function Write-Section {
    param([string]$Title, $Items)
    Write-Host ''
    if ($Items.Count -eq 0) {
        Write-Host ($Title + ': none')
        return
    }
    Write-Host ($Title + ':')
    $index = 0
    foreach ($item in $Items) {
        $index = $index + 1
        Write-Host ('  ' + $index + '. ' + [string]$item)
    }
}

function Complete-Uninstall {
    $ok = (($failureList.Count -eq 0) -and ($refusedList.Count -eq 0))
    $code = 0
    if (-not $ok) { $code = 1 }
    if ($Json) {
        [ordered]@{
            ok            = $ok
            dryRun        = [bool]$DryRun
            removed       = @($removedList.ToArray())
            kept          = @($keptList.ToArray())
            refused       = @($refusedList.ToArray())
            notTouched    = @($notTouched.ToArray())
            dataDir       = $script:resolvedDataDir
            userDataDir   = $script:resolvedUserDataDir
            purgeUserData = [bool]$PurgeUserData
            installDir    = $InstallDir
            warnings      = @($warningList.ToArray())
            failures      = @($failureList.ToArray())
        } | ConvertTo-Json -Depth 6
    } else {
        Write-Host ''
        Write-Host 'zcode-tarkov uninstall'
        Write-Host ''
        Write-Report
        Write-Section -Title 'Removed' -Items $removedList
        Write-Section -Title 'Kept (with the reason)' -Items $keptList
        Write-Section -Title 'Refused (needs attention)' -Items $refusedList
        Write-Section -Title 'Not touched' -Items $notTouched
        Write-Host ''
        if ($DryRun) {
            Write-Host ('Result: dry run, nothing was written. ' + $removedList.Count + ' item(s) would be removed, ' + $keptList.Count + ' kept, ' + $refusedList.Count + ' refused.')
        } elseif ($ok) {
            Write-Host ('Result: uninstalled (' + $removedList.Count + ' item(s) removed, ' + $keptList.Count + ' kept, warnings: ' + $warningList.Count + ').')
        } else {
            Write-Host ('Result: INCOMPLETE - ' + $refusedList.Count + ' refused and ' + $failureList.Count + ' failed item(s) are listed above.')
        }
        if ($script:resolvedDataDir) {
            Write-Host ''
            Write-Host ('Old CLI data directory (v0.1 config, recovery and logs): ' + $script:resolvedDataDir)
            if ($RemoveData) {
                Write-Host '  -RemoveData was given; see the rows above for what was deleted or left.'
            } else {
                Write-Host ('  It was kept. To delete it too: Remove-Item -LiteralPath "' + $script:resolvedDataDir + '" -Recurse -Force')
            }
        }
        if ($script:resolvedUserDataDir) {
            Write-Host ''
            Write-Host ('User data root (music, sounds, voice, pet, status, prefs.json): ' + $script:resolvedUserDataDir)
            if ($PurgeUserData) {
                if ($DryRun) {
                    Write-Host '  -PurgeUserData was given; a real run would delete it (the dry-run rows above list what would go).'
                } else {
                    Write-Host '  -PurgeUserData was given; see the rows above for what was deleted and what was left behind.'
                }
            } else {
                Write-Host '  It was kept untouched. To delete it too, re-run with -PurgeUserData.'
            }
        }
    }
    exit $code
}

# ---------------------------------------------------------------- helpers -----
# The shared helpers live next to this script (<InstallDir>\launcher\ in an
# installed tree, <repo>\launcher\ in the repository). Without them no shortcut
# or process can be identified, so those steps are refused instead of guessed.
$shortcutHelperAvailable = $false
$discoveryAvailable = $false
$helperPath = Join-Path $PSScriptRoot 'launcher\zcode-tarkov-shortcuts.ps1'
$discoveryPath = Join-Path $PSScriptRoot 'launcher\zcode-tarkov-discovery.ps1'
if (Test-Path -LiteralPath $helperPath -PathType Leaf) {
    try { . $helperPath; $shortcutHelperAvailable = $true } catch { Add-Failed 'helper' ('cannot load ' + $helperPath + ': ' + $_.Exception.Message) }
} else {
    Add-Failed 'helper' ('the shared shortcut helper is missing: ' + $helperPath)
}
if (Test-Path -LiteralPath $discoveryPath -PathType Leaf) {
    try { . $discoveryPath; $discoveryAvailable = $true } catch { Add-Failed 'helper' ('cannot load ' + $discoveryPath + ': ' + $_.Exception.Message) }
} else {
    Add-Failed 'helper' ('the discovery helper is missing: ' + $discoveryPath)
}

# ------------------------------------------------------------- 1. settings ----
$settings = $null
if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
    try {
        $settings = ([System.IO.File]::ReadAllText($settingsPath)) | ConvertFrom-Json -ErrorAction Stop
    } catch {
        $settings = $null
        Add-Row -Tag '[warn]   ' -Class 'warn' -What 'settings' -Detail ($settingsPath + ' cannot be read: ' + $_.Exception.Message)
    }
    if ($null -ne $settings) {
        if ([string]$settings.product -ne 'zcode-tarkov') {
            $settings = $null
            Add-Row -Tag '[warn]   ' -Class 'warn' -What 'settings' -Detail ($settingsPath + ' does not carry "product": "zcode-tarkov"; its values are ignored')
        } else {
            Add-Info 'settings' ($settingsPath + ' (version ' + [string]$settings.version + ')')
        }
    }
} else {
    Add-Row -Tag '[warn]   ' -Class 'warn' -What 'settings' -Detail ($settingsPath + ' is missing; continuing with the documented defaults and the sweeps')
}

# Values that were not given on the command line come from settings.json, then
# from the documented defaults (0 means "not given").
$resolvedCdpPort = $CdpPort
if ($resolvedCdpPort -le 0) { $resolvedCdpPort = 9222 }
$resolvedApiPort = $ApiPort
if ($resolvedApiPort -le 0) { $resolvedApiPort = 9223 }
if ($null -ne $settings) {
    if ($CdpPort -le 0) {
        try { if ([int]$settings.cdpPort -gt 0) { $resolvedCdpPort = [int]$settings.cdpPort } } catch { }
    }
    if ($ApiPort -le 0) {
        try { if ([int]$settings.apiPort -gt 0) { $resolvedApiPort = [int]$settings.apiPort } } catch { }
    }
}
$resolvedDataDir = $DataDir
if ([string]::IsNullOrWhiteSpace($resolvedDataDir) -and $null -ne $settings -and -not [string]::IsNullOrWhiteSpace([string]$settings.dataDir)) {
    $resolvedDataDir = [string]$settings.dataDir
}
if ([string]::IsNullOrWhiteSpace($resolvedDataDir)) { $resolvedDataDir = Get-ZctDefaultDataDir }
if (-not [string]::IsNullOrWhiteSpace($resolvedDataDir)) {
    try { $resolvedDataDir = [System.IO.Path]::GetFullPath($resolvedDataDir) } catch { }
    if ($resolvedDataDir.EndsWith('\') -and $resolvedDataDir.Length -gt 3) { $resolvedDataDir = $resolvedDataDir.TrimEnd('\') }
}
# Same rule for the v0.2 root; whether it is deleted is decided by
# -PurgeUserData in section 9, never by the settings or by -RemoveData.
$resolvedUserDataDir = Get-ZctUserDataRoot
Add-Info 'ports' ('cdp ' + $resolvedCdpPort + ', api ' + $resolvedApiPort + ' (from the command line, settings.json, or the defaults)')

# ------------------------------------------------- 2. our resident service ----
# A pid is only ever stopped when it is provably ours: node.exe, running from
# this install, with the "serve" token. A port number alone proves nothing.
# $stoppedPid is the service pid this run removed (or, in a dry run, would
# remove); it is excluded from the leftover sweep below.
$stoppedPid = 0
if (-not $shortcutHelperAvailable -or -not $discoveryAvailable) {
    Add-Refused 'service' 'the shared helpers could not be loaded, so the pid behind the api port cannot be identified; nothing was stopped'
} else {
    $health = Get-ServiceHealth -ApiPort $resolvedApiPort
    if ($null -eq $health) {
        Add-Absent 'service' ('nothing that identifies itself as zcode-tarkov answers on api port ' + $resolvedApiPort)
    } else {
        $candidatePid = 0
        try { $candidatePid = [int]$health.pid } catch { $candidatePid = 0 }
        $identity = Test-ZctProcessIsOurs -ProcessId $candidatePid -InstallDir $InstallDir -CliPath $cliPath -RequireServe
        if (-not $identity.Ok) {
            Add-Refused 'service' ('pid ' + $candidatePid + ' answers on api port ' + $resolvedApiPort + ' but is not this install (' + $identity.Reason + '); not stopped' + $(if ([string]::IsNullOrWhiteSpace([string]$identity.CommandLine)) { '' } else { '; its command line: ' + [string]$identity.CommandLine }))
        } elseif ($DryRun) {
            # The pid the service step is about to stop; excluded from the
            # leftover sweep below so a dry run does not report it twice.
            $stoppedPid = $candidatePid
            Add-Removed 'service' ('pid ' + $candidatePid + ' (api port ' + $resolvedApiPort + '): ' + [string]$identity.CommandLine)
        } else {
            try {
                Stop-Process -Id $candidatePid -Force -ErrorAction Stop
                $stoppedPid = $candidatePid
                Add-Row -Tag '[removed]' -Class 'removed' -What 'service' -Detail ('stopped pid ' + $candidatePid + ' (node.exe, ' + [string]$identity.CommandLine + ')')
                $closed = $false
                for ($i = 0; $i -lt 20; $i++) {
                    Start-Sleep -Milliseconds 500
                    if (-not (Test-PortOpen -Port $resolvedApiPort -TimeoutMs 250)) { $closed = $true; break }
                }
                if ($closed) { Add-Info 'service' ('api port ' + $resolvedApiPort + ' is closed now') }
                else { Add-Row -Tag '[warn]   ' -Class 'warn' -What 'service' -Detail ('api port ' + $resolvedApiPort + ' is still open 10s after stopping pid ' + $candidatePid) }
            } catch {
                Add-Failed 'service' ('cannot stop pid ' + $candidatePid + ': ' + $_.Exception.Message)
            }
        }
    }
}

# --------------------------------------------- 3. other leftovers from here --
if (-not $shortcutHelperAvailable) {
    Add-Refused 'leftover processes' 'the shared shortcut helper could not be loaded; no process was inspected'
} else {
    # Get-ZctInstallProcesses returns a status object. Ok = $false means the
    # process list could not be read at all (WMI/CIM unavailable), which is
    # reported as "could not inspect" - never as a verified absence.
    $leftovers = Get-ZctInstallProcesses -InstallDir $InstallDir -CliPath $cliPath -ExcludeProcessId $stoppedPid
    if (-not $leftovers.Ok) {
        Add-Refused 'leftover processes' ($leftovers.Reason + '; no process was inspected and none is claimed absent')
    } elseif (@($leftovers.Processes).Count -eq 0) {
        Add-Absent 'leftover processes' ('no other node.exe runs ' + $cliPath + ' with a serve or watch token')
    } else {
        foreach ($leftover in @($leftovers.Processes)) {
            $line = [string]$leftover.CommandLine
            if ($DryRun) {
                Add-Removed 'leftover process' ('pid ' + $leftover.ProcessId + ': ' + $line)
                continue
            }
            if (-not $Json) { Write-Host ('[stopping] pid ' + $leftover.ProcessId + ' - ' + $line) }
            try {
                Stop-Process -Id $leftover.ProcessId -Force -ErrorAction Stop
                Add-Row -Tag '[removed]' -Class 'removed' -What 'leftover process' -Detail ('stopped pid ' + $leftover.ProcessId + ': ' + $line)
            } catch {
                Add-Failed 'leftover process' ('cannot stop pid ' + $leftover.ProcessId + ' (' + $line + '): ' + $_.Exception.Message)
            }
        }
    }
}

# ------------------------------------------------------ 4. autostart entry ----
# The sign-in entry the CLI wrote is ours only when its content says so: either
# the header comment the CLI emits, or a CLI path that names zcode-tarkov or
# zcode-beautify. Anything else stays.
if (Test-Path -LiteralPath $autostartEntry -PathType Leaf) {
    $autostartContent = $null
    try { $autostartContent = [System.IO.File]::ReadAllText($autostartEntry) } catch { $autostartContent = $null }
    if ($null -eq $autostartContent) {
        Add-Refused 'autostart' ($autostartEntry + ' exists but could not be read; not removed')
    } elseif (($autostartContent -match '(?i)ZCode Beautify') -or ($autostartContent -match '(?i)zcode-(tarkov|beautify)')) {
        if ($DryRun) {
            Add-Removed 'autostart' $autostartEntry
        } else {
            try {
                Remove-Item -LiteralPath $autostartEntry -Force -ErrorAction Stop
                Add-Row -Tag '[removed]' -Class 'removed' -What 'autostart' -Detail ($autostartEntry + ' (content identifies it as the zcode-tarkov entry)')
            } catch {
                Add-Failed 'autostart' ('cannot remove ' + $autostartEntry + ': ' + $_.Exception.Message)
            }
        }
    } else {
        Add-Kept 'autostart' ($autostartEntry + ' exists but does not look like ours (it carries no zcode-tarkov identifier); not touched')
    }
} else {
    Add-Absent 'autostart' ($autostartEntry + ' is not present')
}

# ----------------------------------------------------------- 5. shortcuts -----
$shortcutDirs = New-Object System.Collections.ArrayList
$seenDirs = @{}
$addDir = {
    param([string]$Dir)
    if ([string]::IsNullOrWhiteSpace($Dir)) { return }
    $value = $Dir
    try { $value = [System.IO.Path]::GetFullPath($value) } catch { }
    if ($value.EndsWith('\') -and $value.Length -gt 3) { $value = $value.TrimEnd('\') }
    $key = $value.ToLowerInvariant()
    if ($seenDirs.ContainsKey($key)) { return }
    $seenDirs[$key] = $true
    [void]$script:shortcutDirs.Add($value)
}

# The directories recorded at install time. settings.shortcuts holds shortcut
# files ("...\ZCode Tarkov.lnk"), so the directory is the part that matters.
if ($null -ne $settings -and $null -ne $settings.shortcuts) {
    foreach ($recorded in @($settings.shortcuts)) {
        if ([string]::IsNullOrWhiteSpace([string]$recorded)) { continue }
        $value = [string]$recorded
        $parent = $value
        if (-not (Test-Path -LiteralPath $value -PathType Container)) {
            $parent = Split-Path -Path $value -Parent
        }
        & $addDir $parent
    }
}
foreach ($given in @($ShortcutDir)) { & $addDir $given }
& $addDir $desktopDir
& $addDir $startMenuDir

if (-not $shortcutHelperAvailable) {
    foreach ($dir in $shortcutDirs) {
        Add-Refused 'shortcut' (Join-Path $dir 'ZCode Tarkov.lnk' + ' cannot be identified without ' + $helperPath)
    }
} else {
    foreach ($dir in $shortcutDirs) {
        $linkPath = Join-Path $dir 'ZCode Tarkov.lnk'
        if (-not (Test-Path -LiteralPath $linkPath -PathType Leaf)) {
            Add-Absent 'shortcut' ($linkPath + ' is not present')
            continue
        }
        $link = Get-ZctLauncherShortcut -Path $linkPath
        if ($null -eq $link) {
            Add-Refused 'shortcut' ($linkPath + ' exists but could not be read; not removed')
            continue
        }
        if (Test-ZctShortcutIsOurs -Shortcut $link -InstallDir $InstallDir) {
            if ($DryRun) {
                Add-Removed 'shortcut' ($linkPath + ' (starts the zcode-tarkov launcher)')
            } else {
                try {
                    Remove-Item -LiteralPath $linkPath -Force -ErrorAction Stop
                    Add-Row -Tag '[removed]' -Class 'removed' -What 'shortcut' -Detail ($linkPath + ' (started ' + [string]$link.TargetPath + ' ' + [string]$link.Arguments + ')')
                } catch {
                    Add-Failed 'shortcut' ('cannot remove ' + $linkPath + ': ' + $_.Exception.Message)
                }
            }
            continue
        }
        # The project's own playtest tooling created "ZCode Tarkov.lnk" entries
        # that point straight at ZCode.exe with the debug port in the arguments.
        $leaf = [string]$link.TargetPath
        try { $leaf = [System.IO.Path]::GetFileName([string]$link.TargetPath) } catch { }
        $isLegacy = ($leaf -ieq 'ZCode.exe') -and ([string]$link.Arguments -match '(?i)--remote-debugging-port=')
        if ($isLegacy) {
            if ($KeepLegacyShortcut) {
                Add-Kept 'legacy shortcut' ($linkPath + ' (' + [string]$link.TargetPath + ' ' + [string]$link.Arguments + ') kept (-KeepLegacyShortcut)')
            } elseif ($DryRun) {
                Add-Removed 'legacy shortcut' ($linkPath + ' (' + [string]$link.TargetPath + ' ' + [string]$link.Arguments + ')')
            } else {
                try {
                    Remove-Item -LiteralPath $linkPath -Force -ErrorAction Stop
                    Add-Row -Tag '[removed]' -Class 'removed' -What 'legacy shortcut' -Detail ($linkPath + ' (pointed at ' + [string]$link.TargetPath + ' ' + [string]$link.Arguments + ')')
                } catch {
                    Add-Failed 'legacy shortcut' ('cannot remove ' + $linkPath + ': ' + $_.Exception.Message)
                }
            }
            continue
        }
        Add-Kept 'shortcut' ($linkPath + ' is not ours (target ' + [string]$link.TargetPath + '); not touched')
    }
}

# ------------------------------------- 6. official ZCode launcher entries -----
# Only the argument token we may have injected earlier is removed. These
# entries are ZCode's own and are never deleted here.
if ($KeepOfficialShortcuts) {
    Add-Kept 'official entries' 'skipped (-KeepOfficialShortcuts)'
} elseif (-not $shortcutHelperAvailable) {
    Add-Refused 'official entries' 'the shared shortcut helper could not be loaded; the official entries were not inspected'
} else {
    # Only the argument token this project could have injected is removed: the
    # configured cdp port plus the historical default 9222. A token naming any
    # other port is left alone.
    $flagPorts = @($resolvedCdpPort, 9222)
    foreach ($official in @((Join-Path $desktopDir 'ZCode.lnk'), (Join-Path $startMenuDir 'ZCode.lnk'))) {
        $result = Remove-ZctOfficialFlag -Path $official -Ports $flagPorts -DryRun:$DryRun
        $detail = $official + ': [' + [string]$result.Before + '] -> [' + [string]$result.After + ']'
        if ($result.Status -eq 'stripped') { Add-Row -Tag '[removed]' -Class 'removed' -What 'official flag' -Detail ('shortcut ' + $detail) }
        elseif ($result.Status -eq 'dry-run') { Add-Row -Tag '[removed]' -Class 'removed' -What 'official flag' -Detail ('dry run: would strip the flag from shortcut ' + $detail) }
        elseif ($result.Status -eq 'unchanged') { Add-Absent 'official flag' ('shortcut ' + $detail + ' contains no --remote-debugging-port token') }
        elseif ($result.Status -eq 'absent') { Add-Absent 'official flag' ('shortcut ' + $official + ' is not present') }
        elseif ($result.Status -eq 'skipped') { Add-Kept 'official flag' ('shortcut ' + $official + ' (' + [string]$result.Message + ')') }
        else { Add-Failed 'official flag' ('shortcut ' + $official + ': ' + [string]$result.Message) }
    }
    foreach ($handlerKey in @(Get-ZctOfficialHandlerKeys)) {
        $result = Remove-ZctOfficialHandlerFlag -Key $handlerKey -Ports $flagPorts -DryRun:$DryRun
        $detail = $handlerKey + ': [' + [string]$result.Before + '] -> [' + [string]$result.After + ']'
        if ($result.Status -eq 'stripped') { Add-Row -Tag '[removed]' -Class 'removed' -What 'official handler' -Detail $detail }
        elseif ($result.Status -eq 'dry-run') { Add-Row -Tag '[removed]' -Class 'removed' -What 'official handler' -Detail ('dry run: would strip the flag from ' + $detail) }
        elseif ($result.Status -eq 'unchanged') { Add-Absent 'official handler' ($handlerKey + ': no --remote-debugging-port token is present') }
        elseif ($result.Status -eq 'absent') { Add-Absent 'official handler' ($handlerKey + ' does not exist') }
        elseif ($result.Status -eq 'empty') { Add-Absent 'official handler' ($handlerKey + ': the default value is empty') }
        elseif ($result.Status -eq 'skipped') { Add-Kept 'official handler' ($handlerKey + ': ' + [string]$result.Message) }
        else { Add-Failed 'official handler' ($handlerKey + ': ' + [string]$result.Message) }
    }
}

# --------------------------------------------------------- 7. install dir -----
# Removed only when it carries our settings.json marker, and only below
# %LOCALAPPDATA% or %TEMP%. -Force overrides both. The delete never follows a
# directory reparse point: Windows PowerShell 5.1 would descend through a
# junction/symlink in Remove-Item -Recurse and delete the link target.
if (-not (Test-Path -LiteralPath $InstallDir -PathType Container)) {
    Add-Absent 'install dir' ($InstallDir + ' is not present')
} else {
    $hasMarker = $false
    if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
        try {
            $marker = ([System.IO.File]::ReadAllText($settingsPath)) | ConvertFrom-Json -ErrorAction Stop
            $hasMarker = ([string]$marker.product -eq 'zcode-tarkov')
        } catch { $hasMarker = $false }
    }
    $locationOk = Test-ZctPathUnder -Path $InstallDir -Roots @($env:LOCALAPPDATA, $env:TEMP)
    if ((Test-ZctIsReparsePoint -Path $InstallDir) -and -not $Force) {
        Add-Refused 'install dir' ($InstallDir + ' is a directory reparse point (junction/symlink); deleting through it could delete the link target. Refused (re-run with -Force only if you are sure)')
    } elseif (-not $hasMarker -and -not $Force) {
        Add-Refused 'install dir' ($InstallDir + ' does not contain a settings.json with "product": "zcode-tarkov"; not removed (re-run with -Force to remove it anyway)')
    } elseif (-not $locationOk -and -not $Force) {
        Add-Refused 'install dir' ($InstallDir + ' is outside %LOCALAPPDATA% and %TEMP%; refused (re-run with -Force only if you are sure)')
    } else {
        $tree = Get-ZctTreeFiles -Root $InstallDir
        $fileCount = @($tree.Files).Count
        $skippedLinks = @($tree.Skipped)
        if ($skippedLinks.Count -gt 0) {
            Add-Kept 'install dir links' ($skippedLinks.Count.ToString() + ' reparse point(s) inside the install directory were not followed: ' + ($skippedLinks -join ', '))
        }
        if ($DryRun) {
            Add-Removed 'install dir' ($InstallDir + ' (' + $fileCount + ' file(s), recursing without following reparse points)')
        } else {
            try {
                $left = @(Remove-ZctTreeSafe -Root $InstallDir)
                if (Test-Path -LiteralPath $InstallDir) {
                    if ($left.Count -gt 0) {
                        Add-Kept 'install dir' ($InstallDir + ' still holds ' + $left.Count + ' item(s) that a reparse-point-safe delete leaves in place (the reparse points and their parent directories): ' + ($left -join ', '))
                    } else {
                        Add-Failed 'install dir' ($InstallDir + ' still exists after the recursive removal')
                    }
                } else {
                    Add-Row -Tag '[removed]' -Class 'removed' -What 'install dir' -Detail ($InstallDir + ' (' + $fileCount + ' file(s) removed)')
                }
            } catch {
                Add-Failed 'install dir' ('cannot remove ' + $InstallDir + ': ' + $_.Exception.Message)
            }
        }
    }
}

# ------------------------------------------------------------ 8. data dir -----
# Kept by default: it holds the user's wallpaper and settings.
$knownDataFiles = @('config.json', 'config.backup.json', 'recovery.json', 'serve.log', 'launcher.log')
if ([string]::IsNullOrWhiteSpace($resolvedDataDir)) {
    Add-Absent 'data dir' 'the data directory could not be determined'
} elseif (-not (Test-Path -LiteralPath $resolvedDataDir -PathType Container)) {
    Add-Absent 'data dir' ($resolvedDataDir + ' is not present')
} elseif (-not $RemoveData) {
    Add-Kept 'data dir' ($resolvedDataDir + ' is kept (it holds the wallpaper and the settings); delete it with: Remove-Item -LiteralPath "' + $resolvedDataDir + '" -Recurse -Force')
} else {
    $dataRemoved = New-Object System.Collections.ArrayList
    foreach ($name in $knownDataFiles) {
        $candidate = Join-Path $resolvedDataDir $name
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        if ($DryRun) {
            [void]$dataRemoved.Add($name)
            continue
        }
        try {
            Remove-Item -LiteralPath $candidate -Force -ErrorAction Stop
            [void]$dataRemoved.Add($name)
        } catch {
            Add-Failed 'data dir' ('cannot remove ' + $candidate + ': ' + $_.Exception.Message)
        }
    }
    $wallpapers = @(Get-ChildItem -LiteralPath $resolvedDataDir -File -Filter 'wallpaper.*' -ErrorAction SilentlyContinue)
    foreach ($wallpaper in $wallpapers) {
        if ($DryRun) {
            [void]$dataRemoved.Add($wallpaper.Name)
            continue
        }
        try {
            Remove-Item -LiteralPath $wallpaper.FullName -Force -ErrorAction Stop
            [void]$dataRemoved.Add($wallpaper.Name)
        } catch {
            Add-Failed 'data dir' ('cannot remove ' + $wallpaper.FullName + ': ' + $_.Exception.Message)
        }
    }
    if ($dataRemoved.Count -gt 0) {
        if ($DryRun) { Add-Removed 'data dir' ($resolvedDataDir + ' would lose ' + $dataRemoved.Count + ' known file(s): ' + (@($dataRemoved.ToArray()) -join ', ')) }
        else { Add-Row -Tag '[removed]' -Class 'removed' -What 'data dir' -Detail ($dataRemoved.Count.ToString() + ' known file(s) in ' + $resolvedDataDir + ': ' + (@($dataRemoved.ToArray()) -join ', ')) }
    } else {
        Add-Absent 'data dir' ($resolvedDataDir + ' holds none of the files this script owns')
    }

    if (-not $DryRun) {
        $remaining = @(Get-ChildItem -LiteralPath $resolvedDataDir -Force -ErrorAction SilentlyContinue)
        if ($remaining.Count -eq 0) {
            try {
                Remove-Item -LiteralPath $resolvedDataDir -Force -ErrorAction Stop
                Add-Row -Tag '[removed]' -Class 'removed' -What 'data dir' -Detail ($resolvedDataDir + ' (empty after the known files were removed)')
            } catch {
                Add-Failed 'data dir' ('cannot remove the empty directory ' + $resolvedDataDir + ': ' + $_.Exception.Message)
            }
        } else {
            $names = @($remaining | ForEach-Object { $_.Name })
            Add-Kept 'data dir' ($resolvedDataDir + ' still holds ' + $names.Count + ' other item(s) (' + ($names -join ', ') + '); the directory was kept')
        }
    } else {
    }
}

# -------------------------------------------------------- 9. user data root ---
# The v0.2 state: music, sounds, voice, pet art, status texts and prefs.json
# below %LOCALAPPDATA%\zcode-tarkov\data, or the ZCODE_TARKOV_DATA_DIR override.
# It holds files the user put there, so it is kept by default and reported item
# by item - a user with 4 GB of music must be able to read this output and know
# it survived. Only -PurgeUserData deletes it, and even then the delete never
# follows a directory reparse point; a reparse point at the root itself is
# refused (a recursive delete through a junction would destroy the target).
if ([string]::IsNullOrWhiteSpace($resolvedUserDataDir)) {
    Add-Absent 'user data' 'the user data root could not be determined (%LOCALAPPDATA% and %USERPROFILE% are both unset)'
} elseif (-not (Test-Path -LiteralPath $resolvedUserDataDir -PathType Container)) {
    Add-Absent 'user data' ($resolvedUserDataDir + ' is not present')
} else {
    # Counted before any decision, with Get-ZctTreeFiles so a reparse point is
    # reported rather than walked into. The numbers are the evidence that the
    # library survived; no file's content is ever read.
    $userFileCount = 0
    $userBytes = 0
    $userSkippedLinks = @()
    if ($shortcutHelperAvailable) {
        $userTree = Get-ZctTreeFiles -Root $resolvedUserDataDir
        $userFiles = @($userTree.Files)
        $userFileCount = $userFiles.Count
        foreach ($file in $userFiles) { try { $userBytes = $userBytes + [int64]$file.Length } catch { } }
        $userSkippedLinks = @($userTree.Skipped)
    }
    $userSizeText = '{0:N1} MB' -f ($userBytes / 1MB)

    if (-not $PurgeUserData) {
        if ($shortcutHelperAvailable) {
            Add-Kept 'user data' ($resolvedUserDataDir + ' is kept (' + $userFileCount + ' file(s), ' + $userSizeText + '); delete it only if you mean to, with -PurgeUserData')
            # Per-directory counts, so the owner of every media kind can see its
            # files were not touched. Missing directories are simply not listed.
            foreach ($sub in $userDataSubdirs) {
                $subPath = Join-Path $resolvedUserDataDir $sub
                if (-not (Test-Path -LiteralPath $subPath -PathType Container)) { continue }
                $subTree = Get-ZctTreeFiles -Root $subPath
                $subFiles = @($subTree.Files)
                $subBytes = 0
                foreach ($file in $subFiles) { try { $subBytes = $subBytes + [int64]$file.Length } catch { } }
                Add-Kept ('user data\' + $sub) ($subFiles.Count.ToString() + ' file(s), ' + ('{0:N1} MB' -f ($subBytes / 1MB)) + ', kept at ' + $subPath)
            }
            $prefsPath = Join-Path $resolvedUserDataDir 'prefs.json'
            if (Test-Path -LiteralPath $prefsPath -PathType Leaf) { Add-Kept 'user data\prefs.json' ('your settings are kept at ' + $prefsPath) }
            if ($userSkippedLinks.Count -gt 0) {
                Add-Kept 'user data links' ($userSkippedLinks.Count.ToString() + ' reparse point(s) were not followed and are therefore untouched: ' + ($userSkippedLinks -join ', '))
            }
        } else {
            Add-Kept 'user data' ($resolvedUserDataDir + ' is kept; its file counts could not be read (' + $helperPath + ' did not load) and nothing there was deleted')
        }
        [void]$notTouched.Add('the user data root ' + $resolvedUserDataDir + ' (music, sounds, voice, pet, status and prefs.json; kept unless -PurgeUserData is given)')
    } else {
        # -PurgeUserData deletes, so the target is proven safe first: a drive
        # root is never allowed (-Force included), one of the personal
        # directories itself is refused unless -Force overrides the guard.
        $unsafeReason = ''
        $unsafeOverridable = $true
        if ($resolvedUserDataDir -eq [System.IO.Path]::GetPathRoot($resolvedUserDataDir)) {
            $unsafeReason = 'it is the root of a drive'
            $unsafeOverridable = $false
        } else {
            foreach ($protected in @($env:USERPROFILE, $env:LOCALAPPDATA, $env:APPDATA, $env:TEMP, $InstallDir)) {
                if ([string]::IsNullOrWhiteSpace($protected)) { continue }
                $value = $protected
                try { $value = [System.IO.Path]::GetFullPath($value) } catch { }
                if ($value.EndsWith('\') -and $value.Length -gt 3) { $value = $value.TrimEnd('\') }
                if ($resolvedUserDataDir -ieq $value) { $unsafeReason = 'it is ' + $value + ' itself'; break }
            }
        }
        if (-not $shortcutHelperAvailable) {
            Add-Refused 'user data' ('the shared shortcut helper could not be loaded, so the reparse-point-safe delete is unavailable; nothing was deleted from ' + $resolvedUserDataDir)
        } elseif ((Test-ZctIsReparsePoint -Path $resolvedUserDataDir) -and -not $Force) {
            Add-Refused 'user data' ($resolvedUserDataDir + ' is a directory reparse point (junction/symlink); deleting through it could delete the link target. Refused (re-run with -Force only if you are sure)')
        } elseif (-not [string]::IsNullOrWhiteSpace($unsafeReason) -and (-not $unsafeOverridable -or -not $Force)) {
            $unsafeHint = '; refused'
            if ($unsafeOverridable) { $unsafeHint = '; refused (re-run with -Force only if you are sure)' }
            Add-Refused 'user data' ('-PurgeUserData was given, but ' + $resolvedUserDataDir + ' is not a dedicated data directory (' + $unsafeReason + ')' + $unsafeHint)
        } else {
            # -PurgeUserData removes this project's own files, never the root's
            # other contents. The root is relocatable, and the documented reason
            # to relocate it is to keep media on a drive that already holds a
            # library, so a recursive delete of the root would take files this
            # project never created. The five media directories and prefs.json
            # are ours by construction; the root itself is removed only when
            # nothing else is left in it.
            $purgeDirs = @('music', 'sounds', 'voice', 'pet', 'status')
            $purgeFile = 'prefs.json'
            $removedItems = @()
            $skippedItems = @()
            $failedItems = @()
            foreach ($name in $purgeDirs) {
                $child = Join-Path $resolvedUserDataDir $name
                if (-not (Test-Path -LiteralPath $child)) { continue }
                if (Test-ZctIsReparsePoint -Path $child) {
                    $skippedItems += ($name + ' (a reparse point; deleting through it could delete the link target)')
                    continue
                }
                if ($DryRun) { $removedItems += $name; continue }
                try {
                    [void]@(Remove-ZctTreeSafe -Root $child)
                    if (Test-Path -LiteralPath $child) { $skippedItems += ($name + ' (left in place by the reparse-point-safe delete)') }
                    else { $removedItems += $name }
                } catch {
                    $failedItems += ($name + ': ' + $_.Exception.Message)
                }
            }
            $prefsPath = Join-Path $resolvedUserDataDir $purgeFile
            if (Test-Path -LiteralPath $prefsPath -PathType Leaf) {
                if ($DryRun) {
                    $removedItems += $purgeFile
                } else {
                    try {
                        Remove-Item -LiteralPath $prefsPath -Force -ErrorAction Stop
                        if (Test-Path -LiteralPath $prefsPath) { $skippedItems += ($purgeFile + ' (still present)') }
                        else { $removedItems += $purgeFile }
                    } catch {
                        $failedItems += ($purgeFile + ': ' + $_.Exception.Message)
                    }
                }
            }

            # Anything else in the root belongs to the user. Report it by name so
            # the output says what survived, rather than only what was deleted.
            $foreign = @()
            if (Test-Path -LiteralPath $resolvedUserDataDir) {
                try {
                    $foreign = @(Get-ChildItem -LiteralPath $resolvedUserDataDir -Force -ErrorAction Stop |
                        Where-Object { $purgeDirs -notcontains $_.Name -and $_.Name -ne $purgeFile } |
                        ForEach-Object { $_.Name })
                } catch { $foreign = @() }
            }

            if ($DryRun) {
                Add-Removed 'user data' ($userDetail + '; would remove ' + (($removedItems) -join ', ') + ' (this project''s own files only, never the root itself)')
                if ($foreign.Count -gt 0) {
                    Add-Kept 'user data' ($resolvedUserDataDir + ' also holds ' + $foreign.Count + ' entr(ies) this project did not create, which -PurgeUserData never removes: ' + ($foreign -join ', '))
                }
            } elseif ($failedItems.Count -gt 0) {
                Add-Failed 'user data' ('-PurgeUserData could not remove: ' + ($failedItems -join '; '))
            } else {
                Add-Row -Tag '[removed]' -Class 'removed' -What 'user data' -Detail ($userDetail + '; removed ' + ($removedItems -join ', ') + ' because -PurgeUserData was given')
            }
            if (-not $DryRun) {
                if ($skippedItems.Count -gt 0) {
                    Add-Kept 'user data' ($resolvedUserDataDir + ' still holds: ' + ($skippedItems -join '; '))
                }
                if ($foreign.Count -gt 0) {
                    Add-Kept 'user data' ($resolvedUserDataDir + ' was kept because it still holds ' + $foreign.Count + ' entr(ies) this project did not create: ' + ($foreign -join ', '))
                } elseif (Test-Path -LiteralPath $resolvedUserDataDir) {
                    # Ours are gone and nothing else is in it, so the empty root
                    # goes too rather than leaving a bare directory behind.
                    try {
                        Remove-Item -LiteralPath $resolvedUserDataDir -Force -ErrorAction Stop
                        Add-Row -Tag '[removed]' -Class 'removed' -What 'user data root' -Detail ($resolvedUserDataDir + ' removed (it was empty after the purge)')
                    } catch {
                        Add-Kept 'user data root' ($resolvedUserDataDir + ' is empty but could not be removed: ' + $_.Exception.Message)
                    }
                }
            }
        }
    }
}

# ------------------------------------------------------ 10. not-touched list --
$zcodeInstall = 'ZCode''s installation directory'
if ($null -ne $settings -and -not [string]::IsNullOrWhiteSpace([string]$settings.zcodeInstallDir)) {
    $zcodeInstall = 'ZCode''s installation directory (' + [string]$settings.zcodeInstallDir + ')'
}
[void]$notTouched.Add($zcodeInstall + ' and ZCode''s own profile: this script only ever reads them')
[void]$notTouched.Add('ZCode''s official shortcuts and its three HKCU handler values: at most the --remote-debugging-port token is removed, the entries themselves are never deleted')
[void]$notTouched.Add('the marketplace plugin cache (%USERPROFILE%\.zcode\cli\plugins): a plugin installed from the marketplace is removed in ZCode''s own plugin UI, not by this script')
[void]$notTouched.Add('every shortcut that is not ours: its file keeps its content (the rows above say which ones were skipped)')
if ($null -ne $settings -and -not [string]::IsNullOrWhiteSpace([string]$settings.dataDir) -and -not $RemoveData) {
    [void]$notTouched.Add('the data directory ' + [string]$settings.dataDir + ' (kept unless -RemoveData is given)')
}

Complete-Uninstall
