#Requires -Version 5.1
#
# zcode-tarkov-launch.ps1
#
# The installed launcher. Lives at <InstallDir>\launcher\zcode-tarkov-launch.ps1
# and is normally started through zcode-tarkov-launch.vbs, which a double-click
# on the "ZCode Tarkov" shortcut reaches without ever flashing a console window.
#
# What it does, in order:
#   1. read <InstallDir>\settings.json (exit 4 when missing or unusable)
#   2. resolve ZCode.exe (settings cache, env, App Paths, known paths, scan)
#   3. refresh the cached exe path when the resolution moved (best effort)
#   4. if the CDP endpoint identifies itself and ZCode runs: skip the start
#   5. if ZCode runs without the debug port: ask before restarting it
#   5b. if another program holds the port: report the fix, still start ZCode
#   6. otherwise start ZCode detached with --remote-debugging-port
#   7. make sure the resident theme service is healthy (never fatal)
#   8. append one line to launcher.log and exit
#
# Parameters
#   -NoPrompt   never show a dialog and never terminate a process. Used by tests
#               and non-interactive callers.
#   -Quiet      no stdout unless something fails.
#
# Exit codes
#   0  ZCode runs with the debug port and the theme service is healthy
#   2  degraded: ZCode is running and usable, but the debug port did not come up
#      (or another program holds it) or the service did not, so the theme cannot
#      be applied
#   3  ZCode is running (or was started) without an active debug port: quit it
#      completely and start it again from the shortcut
#   4  not installed correctly, or ZCode could not be located: re-run repair.ps1
#   1  unexpected error (the script fails soft and never blocks ZCode)
#
# Safety: user-level only. It never elevates, never touches ZCode's installation
# files or its official shortcuts, and the only process it may terminate is
# ZCode itself, after an explicit Yes in the restart dialog (never with
# -NoPrompt). Fail-soft: the worst case is ZCode starting without the theme.
#
[CmdletBinding()]
param(
    [switch]$NoPrompt,
    [switch]$Quiet
)

$ErrorActionPreference = 'Continue'

$InstallDir = Split-Path -Path $PSScriptRoot -Parent
$settingsPath = Join-Path $InstallDir 'settings.json'
$discoveryPath = Join-Path $PSScriptRoot 'zcode-tarkov-discovery.ps1'
$settings = $null
$exitCode = 0

function Write-Info {
    param([string]$Message)
    if (-not $Quiet) { Write-Host $Message }
}

function Write-Always {
    param([string]$Message)
    Write-Host $Message
}

# Severity order for the exit code: 0 < 2 < 3. The worst problem wins.
function Raise-Exit {
    param([int]$Code)
    if ($Code -gt $script:exitCode) { $script:exitCode = $Code }
}

function Show-Alert {
    param([string]$Text)
    Write-Always $Text
    if ($NoPrompt) { return }
    try {
        $shell = New-Object -ComObject WScript.Shell
        [void]$shell.Popup($Text, 0, 'ZCode Tarkov', 64)   # 64 = information icon
    } catch {
        # no interactive session: the stdout copy above is enough
    }
}

function Confirm-Restart {
    param([string]$Text)
    if ($NoPrompt) { return $false }
    try {
        $shell = New-Object -ComObject WScript.Shell
        # 4 = Yes/No buttons, 48 = warning icon; 6 = Yes, 7 = No
        $answer = $shell.Popup($Text, 0, 'ZCode Tarkov', 52)
        return ($answer -eq 6)
    } catch {
        return $false
    }
}

# One ASCII line per run: timestamp, exit code, resolved exe, port states.
# Best effort: a logging failure never changes the outcome of a launch.
function Write-LauncherLog {
    param([int]$Code, [string]$CdpState, [string]$ApiState, [string]$PidText, [string]$ZcodePath, [string]$Note)
    try {
        $dir = $InstallDir
        if ($settings -and $settings.dataDir) { $dir = [string]$settings.dataDir }
        if (-not (Test-Path -LiteralPath $dir -PathType Container)) {
            New-Item -ItemType Directory -Path $dir -Force -ErrorAction Stop | Out-Null
        }
        $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        $line = $stamp + ' exit=' + $Code + ' zcode="' + $ZcodePath + '" cdp=' + $CdpState + ' api=' + $ApiState + ' pid=' + $PidText + ' note=' + $Note
        Add-Content -LiteralPath (Join-Path $dir 'launcher.log') -Value $line -Encoding Ascii -ErrorAction Stop
    } catch {
        # ignore: logging is diagnostic only
    }
}

function Exit-With {
    param([int]$Code, [string]$CdpState, [string]$ApiState, [string]$PidText, [string]$ZcodePath, [string]$Note)
    Write-LauncherLog -Code $Code -CdpState $CdpState -ApiState $ApiState -PidText $PidText -ZcodePath $ZcodePath -Note $Note
    if ($Code -eq 0) {
        Write-Info ('ZCode is running with the debug port (' + $CdpState + '); theme service ' + $ApiState + '.')
    }
    exit $Code
}

# JSON string literal, used when the launcher refreshes settings.json. Kept
# byte-compatible with what install.ps1 writes (same schema, 2-space indent).
function ConvertTo-JsonString {
    param([string]$Value)
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('"')
    foreach ($c in $Value.ToCharArray()) {
        $code = [int]$c
        if ($c -eq '"') { [void]$sb.Append('\"') }
        elseif ($c -eq '\') { [void]$sb.Append('\\') }
        elseif ($code -lt 32) { [void]$sb.Append('\u' + $code.ToString('x4')) }
        else { [void]$sb.Append($c) }
    }
    [void]$sb.Append('"')
    return $sb.ToString()
}

function Write-SettingsFile {
    param([string]$Path, $Settings)

    $lines = New-Object System.Collections.ArrayList
    [void]$lines.Add('{')
    [void]$lines.Add('  "product": ' + (ConvertTo-JsonString ([string]$Settings.product)) + ',')
    [void]$lines.Add('  "version": ' + (ConvertTo-JsonString ([string]$Settings.version)) + ',')
    [void]$lines.Add('  "installDir": ' + (ConvertTo-JsonString ([string]$Settings.installDir)) + ',')
    [void]$lines.Add('  "nodePath": ' + (ConvertTo-JsonString ([string]$Settings.nodePath)) + ',')
    [void]$lines.Add('  "cliPath": ' + (ConvertTo-JsonString ([string]$Settings.cliPath)) + ',')
    [void]$lines.Add('  "cdpPort": ' + ([string][int]$Settings.cdpPort) + ',')
    [void]$lines.Add('  "apiPort": ' + ([string][int]$Settings.apiPort) + ',')
    if ([string]::IsNullOrWhiteSpace([string]$Settings.dataDir)) {
        [void]$lines.Add('  "dataDir": null,')
    } else {
        [void]$lines.Add('  "dataDir": ' + (ConvertTo-JsonString ([string]$Settings.dataDir)) + ',')
    }
    [void]$lines.Add('  "zcodeExe": ' + (ConvertTo-JsonString ([string]$Settings.zcodeExe)) + ',')
    [void]$lines.Add('  "zcodeInstallDir": ' + (ConvertTo-JsonString ([string]$Settings.zcodeInstallDir)) + ',')
    [void]$lines.Add('  "zcodeResolvedBy": ' + (ConvertTo-JsonString ([string]$Settings.zcodeResolvedBy)) + ',')
    [void]$lines.Add('  "launcherKind": ' + (ConvertTo-JsonString ([string]$Settings.launcherKind)) + ',')

    $shortcutList = @($Settings.shortcuts | Where-Object { $null -ne $_ })
    if ($shortcutList.Count -eq 0) {
        [void]$lines.Add('  "shortcuts": [],')
    } else {
        [void]$lines.Add('  "shortcuts": [')
        for ($i = 0; $i -lt $shortcutList.Count; $i++) {
            $sep = ','
            if ($i -eq $shortcutList.Count - 1) { $sep = '' }
            [void]$lines.Add('    ' + (ConvertTo-JsonString ([string]$shortcutList[$i])) + $sep)
        }
        [void]$lines.Add('  ],')
    }
    [void]$lines.Add('  "installedAt": ' + (ConvertTo-JsonString ([string]$Settings.installedAt)) + ',')
    [void]$lines.Add('  "updatedAt": ' + (ConvertTo-JsonString ([string]$Settings.updatedAt)))
    [void]$lines.Add('}')

    $text = ($lines -join "`r`n") + "`r`n"
    [System.IO.File]::WriteAllText($Path, $text, (New-Object System.Text.UTF8Encoding($false)))
}

# The recorded executable can go stale when ZCode moves or updates; refresh it
# in place, but never fail the launch because of it.
function Update-CachedExe {
    param($Exe)
    $changed = ([string]$settings.zcodeExe -ne [string]$Exe.Path) -or ([string]$settings.zcodeInstallDir -ne [string]$Exe.InstallDir) -or ([string]$settings.zcodeResolvedBy -ne [string]$Exe.ResolvedBy)
    if (-not $changed) { return }
    try {
        $settings.zcodeExe = [string]$Exe.Path
        $settings.zcodeInstallDir = [string]$Exe.InstallDir
        $settings.zcodeResolvedBy = [string]$Exe.ResolvedBy
        $settings.updatedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        Write-SettingsFile -Path $settingsPath -Settings $settings
        Write-Info ('Refreshed the cached ZCode path in settings.json: ' + [string]$Exe.Path + '.')
    } catch {
        # best effort only
    }
}

# ---------------------------------------------------------------- 1. settings --
if (-not (Test-Path -LiteralPath $discoveryPath -PathType Leaf)) {
    Write-Always ('zcode-tarkov: the installation is incomplete (' + $discoveryPath + ' is missing). Re-run repair.ps1 to restore it.')
    Write-LauncherLog -Code 4 -CdpState '-' -ApiState '-' -PidText '-' -ZcodePath '(unknown)' -Note 'discovery-missing'
    exit 4
}
try {
    . $discoveryPath
} catch {
    Write-Always ('zcode-tarkov: cannot load ' + $discoveryPath + ': ' + $_.Exception.Message + ' Re-run repair.ps1 to restore the installation.')
    Write-LauncherLog -Code 4 -CdpState '-' -ApiState '-' -PidText '-' -ZcodePath '(unknown)' -Note 'discovery-unloadable'
    exit 4
}

if (-not (Test-Path -LiteralPath $settingsPath -PathType Leaf)) {
    Write-Always ('zcode-tarkov is not installed correctly: ' + $settingsPath + ' is missing. Re-run repair.ps1 to rebuild the installation.')
    Write-LauncherLog -Code 4 -CdpState '-' -ApiState '-' -PidText '-' -ZcodePath '(unknown)' -Note 'settings-missing'
    exit 4
}
try {
    $raw = [System.IO.File]::ReadAllText($settingsPath)
    $settings = $raw | ConvertFrom-Json -ErrorAction Stop
} catch {
    Write-Always ('zcode-tarkov: cannot read ' + $settingsPath + ': ' + $_.Exception.Message + ' Re-run repair.ps1 to rebuild the installation.')
    Write-LauncherLog -Code 4 -CdpState '-' -ApiState '-' -PidText '-' -ZcodePath '(unknown)' -Note 'settings-unreadable'
    exit 4
}

$missingKeys = @()
foreach ($key in @('nodePath', 'cliPath', 'cdpPort', 'apiPort')) {
    if ($null -eq $settings -or $null -eq $settings.PSObject.Properties[$key]) { $missingKeys += $key }
}
if ($null -eq $settings -or $missingKeys.Count -gt 0) {
    Write-Always ('zcode-tarkov: ' + $settingsPath + ' is incomplete (missing: ' + ($missingKeys -join ', ') + '). Re-run repair.ps1 to rebuild the installation.')
    Write-LauncherLog -Code 4 -CdpState '-' -ApiState '-' -PidText '-' -ZcodePath '(unknown)' -Note 'settings-incomplete'
    exit 4
}

$port = 0
$apiPort = 0
try {
    $port = [int]$settings.cdpPort
    $apiPort = [int]$settings.apiPort
} catch {
    Write-Always ('zcode-tarkov: ' + $settingsPath + ' has unusable port values. Re-run repair.ps1.')
    Write-LauncherLog -Code 4 -CdpState '-' -ApiState '-' -PidText '-' -ZcodePath '(unknown)' -Note 'settings-bad-ports'
    exit 4
}
if ($port -lt 1 -or $port -gt 65535 -or $apiPort -lt 1 -or $apiPort -gt 65535) {
    Write-Always ('zcode-tarkov: ' + $settingsPath + ' has port values outside 1..65535. Re-run repair.ps1.')
    Write-LauncherLog -Code 4 -CdpState '-' -ApiState '-' -PidText '-' -ZcodePath '(unknown)' -Note 'settings-bad-ports'
    exit 4
}

# ------------------------------------------------- 2. locate ZCode + 3. cache ---
$exe = Find-ZcodeExe -Cached ([string]$settings.zcodeExe)
if ($null -eq $exe) {
    Show-Alert ('ZCode could not be located: ZCode.exe was not found in the usual install locations or at the path recorded in settings.json.' + "`r`n`r`n" + 'Run repair.ps1 (in ' + $InstallDir + ') to re-detect ZCode, or start ZCode from its own shortcut. The theme will not be applied.')
    Write-LauncherLog -Code 4 -CdpState ($port.ToString() + ':not-probed') -ApiState ($apiPort.ToString() + ':not-probed') -PidText '-' -ZcodePath '(not found)' -Note 'zcode-not-found'
    exit 4
}
Update-CachedExe -Exe $exe

$cdpState = $port.ToString() + ':closed'
$apiState = $apiPort.ToString() + ':not-checked'
$pidText = '-'
$note = 'ok'

# ------------------------------------------ 4. already running with the port? --
# An open TCP port proves nothing: 9222 is also Chromium's standard debug port,
# so a foreign listener must not be mistaken for ZCode (the shortcut would then
# silently do nothing). The real already-running path needs the CDP endpoint to
# identify itself (Get-CdpIdentity, shared with repair.ps1) AND a ZCode process.
$portOpen = Test-PortOpen -Port $port
$cdpIdentity = $null
if ($portOpen) {
    # Boundary case: the port is bound a moment before /json/version answers, so
    # one miss is retried once before the listener is called foreign.
    for ($i = 0; $i -lt 2; $i++) {
        $cdpIdentity = Get-CdpIdentity -Port $port
        if ($null -ne $cdpIdentity) { break }
        Start-Sleep -Milliseconds 400
    }
}
$zcodeRunning = @(Get-Process -Name ZCode -ErrorAction SilentlyContinue)
$foreignListener = $false

if ($portOpen -and $null -ne $cdpIdentity -and $zcodeRunning.Count -gt 0) {
    $cdpState = $port.ToString() + ':open'
    Write-Info ('ZCode is already listening on the debug port ' + $port + '.')
} else {
    if ($portOpen) {
        # Another program owns the port (or no ZCode process is behind it). Fail
        # soft: ZCode is still started, but success is not claimed and the exit
        # code names the fix.
        $foreignListener = $true
        $cdpState = $port.ToString() + ':in-use-by-another-program'
        $note = 'cdp-port-in-use-by-another-program'
        Raise-Exit 2
        $fix = 'zcode-tarkov: port ' + $port + ' is in use by another program (the listener there is not a ZCode DevTools endpoint), so ZCode cannot open its debug port on it and the theme will not be applied.' + "`r`n`r`n" + 'ZCode is started anyway. To fix it, reinstall with a different -CdpPort, for example:' + "`r`n" + '  powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -CdpPort 9333' + "`r`n`r`n" + '(repair.ps1 -CdpPort 9333 only probes another port; it does not rewrite the recorded cdpPort.)'
        Show-Alert $fix
    } else {
        # ------------------------------- 5. running without the port: restart? ----
        $running = $zcodeRunning
        if ($running.Count -gt 0) {
            $advice = 'ZCode is already running without the debug port ' + $port + ', which is fixed at process start: quit ZCode completely (tray icon included) and start it again from the ZCode Tarkov shortcut. Nothing was changed.'
            if ($NoPrompt) {
                Write-Always $advice
                Write-LauncherLog -Code 3 -CdpState $cdpState -ApiState ($apiPort.ToString() + ':not-checked') -PidText '-' -ZcodePath $exe.Path -Note 'running-without-cdp'
                exit 3
            }
            $question = 'ZCode is running without the theme backend (debug port ' + $port + ').' + "`r`n`r`n" + 'Restart ZCode now so the theme can be applied?' + "`r`n`r`n" + 'Unsaved conversation content will be lost.'
            if (-not (Confirm-Restart $question)) {
                Write-Always $advice
                Write-LauncherLog -Code 3 -CdpState $cdpState -ApiState ($apiPort.ToString() + ':not-checked') -PidText '-' -ZcodePath $exe.Path -Note 'restart-declined'
                exit 3
            }
            # The only place this launcher terminates anything, and only after Yes.
            try {
                Stop-Process -Name ZCode -Force -ErrorAction Stop
                $note = 'restarted-zcode'
            } catch {
                Write-Always ('ZCode could not be stopped: ' + $_.Exception.Message)
                $note = 'stop-failed'
            }
            # The single-instance lock is released asynchronously.
            for ($i = 0; $i -lt 40; $i++) {
                if (@(Get-Process -Name ZCode -ErrorAction SilentlyContinue).Count -eq 0) { break }
                Start-Sleep -Milliseconds 250
            }
        }
    }

    # ------------------------------------- 6. start detached with the port ----
    # $env: assignments are inherited by every child process started afterwards;
    # this is how ZCode and the resident service below learn where ZCode and the
    # theme data live.
    $env:ZCODE_WINDOWS_APP_INSTALL_DIR = [string]$exe.InstallDir
    if ($settings.dataDir) { $env:ZCODE_BEAUTIFY_DATA_DIR = [string]$settings.dataDir }

    $started = $false
    try {
        Start-Process -FilePath ([string]$exe.Path) -ArgumentList ('--remote-debugging-port=' + $port) -WorkingDirectory ([string]$exe.InstallDir)
        $started = $true
        Write-Info ('Starting ZCode with the debug port ' + $port + ' ...')
    } catch {
        Write-Always ('Warning: ZCode could not be started: ' + $_.Exception.Message)
        Raise-Exit 2
        $note = 'start-failed'
    }

    if ($started -and -not $foreignListener) {
        # The wait asks the endpoint to identify itself instead of a bare TCP
        # connect: a foreign listener on the port must not be able to fake
        # success. The loop is bounded (50 x ~0.5-0.9s).
        $up = $false
        for ($i = 0; $i -lt 50; $i++) {
            Start-Sleep -Milliseconds 500
            if ($null -ne (Get-CdpIdentity -Port $port -TimeoutMs 400)) { $up = $true; break }
        }
        if ($up) {
            # A competing instance wins the single-instance lock by binding the
            # port briefly and quitting again, which would look like success.
            Start-Sleep -Seconds 2
            if ($null -ne (Get-CdpIdentity -Port $port)) {
                $cdpState = $port.ToString() + ':open'
            } else {
                $cdpState = $port.ToString() + ':raced'
                Show-Alert ('The debug port ' + $port + ' came up and closed again: another ZCode instance took over through the single-instance lock, so this instance runs without the theme backend.' + "`r`n`r`n" + 'Quit ZCode completely (including its tray icon) and start it again from the ZCode Tarkov shortcut.')
                Raise-Exit 3
                $note = 'raced-single-instance-lock'
            }
        } else {
            $cdpState = $port.ToString() + ':unreachable'
            # Fail soft, no dialog: ZCode is still running and usable, but without
            # the theme until it is restarted properly.
            Write-Always ('Warning: ZCode was started but the debug port ' + $port + ' did not open; the theme cannot be applied until ZCode is restarted from the ZCode Tarkov shortcut.')
            Raise-Exit 2
            $note = 'cdp-port-not-opened'
        }
    } elseif ($foreignListener) {
        # The port is held by another program, so ZCode cannot bind it: waiting
        # would only delay the exit-2 report that was already printed above.
        Write-Info ('Not waiting for the debug port ' + $port + ': it belongs to another program.')
    }
}

# ------------------------------------------------------ 7. resident service ----
$health = Get-ServiceHealth -ApiPort $apiPort
if ($null -ne $health) {
    $pidText = [string]$health.pid
    $apiState = $apiPort.ToString() + ':healthy'
    Write-Info ('Theme service already running (pid ' + $pidText + ').')
} else {
    $serviceStarted = $false
    if (-not (Test-Path -LiteralPath ([string]$settings.nodePath) -PathType Leaf)) {
        Write-Always ('Warning: node.exe was not found at ' + [string]$settings.nodePath + '; the theme service could not be started, so the theme will not re-inject by itself. Re-run repair.ps1.')
        Raise-Exit 2
        $apiState = $apiPort.ToString() + ':no-node'
        $note = 'service-no-node'
    } else {
        # Same child environment as above; inherited by the spawned process.
        $env:ZCODE_WINDOWS_APP_INSTALL_DIR = [string]$exe.InstallDir
        if ($settings.dataDir) { $env:ZCODE_BEAUTIFY_DATA_DIR = [string]$settings.dataDir }
        $serviceArgs = '"' + [string]$settings.cliPath + '" serve --port ' + $port + ' --api-port ' + $apiPort + ' --detach'
        try {
            Start-Process -FilePath ([string]$settings.nodePath) -ArgumentList $serviceArgs -WindowStyle Hidden
            $serviceStarted = $true
        } catch {
            Write-Always ('Warning: the theme service could not be started: ' + $_.Exception.Message + ' The theme will not re-inject by itself.')
            Raise-Exit 2
            $apiState = $apiPort.ToString() + ':start-failed'
            $note = 'service-start-failed'
        }
    }

    if ($serviceStarted) {
        for ($i = 0; $i -lt 30; $i++) {
            Start-Sleep -Milliseconds 500
            $health = Get-ServiceHealth -ApiPort $apiPort
            if ($null -ne $health) { break }
        }
        if ($null -ne $health) {
            $pidText = [string]$health.pid
            $apiState = $apiPort.ToString() + ':started'
            Write-Info ('Theme service started (pid ' + $pidText + ').')
        } else {
            Write-Always ('Warning: the theme service did not answer on port ' + $apiPort + ' within 15s; the theme will not re-inject by itself. Re-run repair.ps1 if this persists.')
            Raise-Exit 2
            $apiState = $apiPort.ToString() + ':unreachable'
            $note = 'service-unreachable'
        }
    }
}

# ------------------------------------------------------------ 8. log + exit ----
Exit-With -Code $exitCode -CdpState $cdpState -ApiState $apiState -PidText $pidText -ZcodePath ([string]$exe.Path) -Note $note
