#Requires -Version 5.1
#
# zcode-tarkov installer (user-level, idempotent)
#
# Purpose
#   Copy the zcode-tarkov payload into a per-user install directory, create the
#   "ZCode Tarkov" launcher shortcut and (unless -NoService) register the
#   resident theme service. This hides `node dist/cli.js ...` from the user: the
#   shortcut starts ZCode with the CDP debug port and keeps the theme applied.
#   It also creates the v0.2 user data root (%LOCALAPPDATA%\zcode-tarkov\data
#   with music, sounds, voice, pet and status). That root is where the user's
#   own files live (v0.1 kept them in ZCode's plugin data directory, which a
#   ZCode update may replace); the installer creates the folders and never
#   writes into or deletes anything that is already in them.
#
# Usage
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -DryRun
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -InstallDir <dir> -ShortcutDir <dir> -DataDir <dir> -NoService
#
#   -InstallDir    default %LOCALAPPDATA%\Programs\zcode-tarkov
#   -SourceDir     default: the directory holding this script (the repo/package)
#   -DataDir       optional: recorded in settings.json and passed to every child
#                  process as ZCODE_BEAUTIFY_DATA_DIR
#   -CdpPort       9222: the port ZCode is started with (--remote-debugging-port)
#   -ApiPort       9223: the port of the resident service control API
#   -ZcodeExe      optional explicit ZCode.exe; skips discovery
#   -ShortcutDir   default: the user Desktop and the user Start Menu Programs
#   -NoShortcuts   do not create or update shortcuts
#   -NoService     do not register autostart and do not start the service
#   -DryRun        resolve, validate and report; writes nothing, starts nothing
#   -Force         adopt an unexpected install directory, or replace a foreign
#                  shortcut that happens to use our name
#   -Json          print only a machine-readable result object
#
# Exit codes
#   0  installed (warnings are allowed)
#   1  refused or failed: nothing was installed
#
# Safety
#   User-level only. This script never elevates (-Verb RunAs is never used),
#   never writes to machine-wide locations (C:\Program Files, %ProgramData%,
#   the public desktop), never writes HKLM, a registry Run key, PATH or any
#   persistent environment variable, never modifies ZCode's installation files,
#   and never creates, changes or deletes an official ZCode shortcut. The entry
#   it creates is a separate file named "ZCode Tarkov.lnk". Everything written
#   lives in -InstallDir, in -ShortcutDir, in the user data root (only the five
#   media folders are created there, never filled), and (unless -NoService) in
#   the per-user autostart entry the plugin's own CLI registers.
#
#   It never reads from stdin, never pauses and never prompts.
#
[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\zcode-tarkov'),
    [string]$SourceDir = $PSScriptRoot,
    [string]$DataDir,
    [int]$CdpPort = 9222,
    [int]$ApiPort = 9223,
    [string]$ZcodeExe,
    [string[]]$ShortcutDir = @(
        (Join-Path $env:USERPROFILE 'Desktop'),
        (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs')
    ),
    [switch]$NoShortcuts,
    [switch]$NoService,
    [switch]$DryRun,
    [switch]$Force,
    [switch]$Json
)

$ErrorActionPreference = 'Continue'

# --------------------------------------------------------------- normalizing --
# Windows PowerShell 5.1: with [CmdletBinding()], $PSScriptRoot is still empty
# while parameter defaults are evaluated, so the default is filled in here.
if ([string]::IsNullOrWhiteSpace($SourceDir)) { $SourceDir = $PSScriptRoot }
try { $InstallDir = [System.IO.Path]::GetFullPath($InstallDir) } catch { }
try { $SourceDir = [System.IO.Path]::GetFullPath($SourceDir) } catch { }
if ($InstallDir.EndsWith('\') -and $InstallDir.Length -gt 3) { $InstallDir = $InstallDir.TrimEnd('\') }
if ($SourceDir.EndsWith('\') -and $SourceDir.Length -gt 3) { $SourceDir = $SourceDir.TrimEnd('\') }
if (-not [string]::IsNullOrWhiteSpace($DataDir)) {
    try { $DataDir = [System.IO.Path]::GetFullPath($DataDir) } catch { }
    if ($DataDir.EndsWith('\') -and $DataDir.Length -gt 3) { $DataDir = $DataDir.TrimEnd('\') }
}

# The v0.2 user data root: music, sounds, voice, pet art, status texts and
# prefs.json, in a directory this product owns rather than in ZCode's plugin
# data directory (which a ZCode update may replace). Same rule as dataRoot() in
# src/core/dataRoot.ts, including the ZCODE_TARKOV_DATA_DIR override the
# lifecycle harness and the CDP tools point at a scratch tree. The default is
# what every real install gets: nothing here relies on that variable being set.
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

$userDataRoot = Get-ZctUserDataRoot
# The five directories of the closed media set (MEDIA_KINDS in
# src/prefs/types.ts); created empty so the settings panel and the media
# pickers find them on a fresh install.
$userDataSubdirs = @('music', 'sounds', 'voice', 'pet', 'status')

$settingsPath = Join-Path $InstallDir 'settings.json'
$cliPath = Join-Path $InstallDir 'dist\cli.js'

$rows = New-Object System.Collections.ArrayList
$shortcuts = @()
$removed = @()
$version = ''
$zcode = $null
$autostart = [ordered]@{ status = 'not-run'; entryPath = $null }
$service = [ordered]@{ status = 'not-run'; pid = $null }

function Add-Row {
    param([string]$Status, [string]$What, [string]$Detail)
    [void]$rows.Add(@{ Status = $Status; What = $What; Detail = $Detail })
}

function Get-RowStrings {
    param([string]$Status)
    $out = New-Object System.Collections.ArrayList
    foreach ($row in $rows) {
        if ($row.Status -eq $Status) { [void]$out.Add([string]$row.What + ': ' + [string]$row.Detail) }
    }
    return $out.ToArray()
}

function Write-Report {
    foreach ($row in $rows) {
        $tag = '[info]'
        if ($row.Status -eq 'ok') { $tag = '[ok]  ' }
        elseif ($row.Status -eq 'warn') { $tag = '[warn]' }
        elseif ($row.Status -eq 'fail') { $tag = '[fail]' }
        Write-Host ('{0} {1,-18} - {2}' -f $tag, [string]$row.What, [string]$row.Detail)
    }
}

function Write-NextSteps {
    Write-Host ''
    Write-Host 'Next steps:'
    Write-Host '  1. Start ZCode from the "ZCode Tarkov" shortcut (Desktop / Start Menu).'
    # Only name a helper that was actually copied: install.ps1 is deliberately
    # not part of the payload, and repair.ps1 / uninstall.ps1 are optional.
    $repairPath = Join-Path $InstallDir 'repair.ps1'
    $uninstallPath = Join-Path $InstallDir 'uninstall.ps1'
    if (Test-Path -LiteralPath $repairPath -PathType Leaf) {
        Write-Host ('  2. If ZCode is moved or the install breaks: powershell -NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $repairPath)
    } else {
        Write-Host '  2. If ZCode is moved or the install breaks, run repair.ps1 from the zcode-tarkov source checkout (this build copied no repair.ps1).'
    }
    if (Test-Path -LiteralPath $uninstallPath -PathType Leaf) {
        Write-Host ('  3. To remove it again: powershell -NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $uninstallPath)
    } else {
        Write-Host '  3. To remove it again, run uninstall.ps1 from the zcode-tarkov source checkout (this build copied no uninstall.ps1).'
    }
}

function Get-ResultObject {
    $failureList = @(Get-RowStrings 'fail')
    $warningList = @(Get-RowStrings 'warn')
    return [ordered]@{
        ok              = ($failureList.Count -eq 0)
        version         = $version
        installDir      = $InstallDir
        userDataDir     = $userDataRoot
        zcodeExe        = $(if ($null -ne $zcode) { [string]$zcode.Path } else { $null })
        zcodeResolvedBy = $(if ($null -ne $zcode) { [string]$zcode.ResolvedBy } else { $null })
        cdpPort         = $CdpPort
        apiPort         = $ApiPort
        shortcuts       = @($shortcuts)
        autostart       = $autostart
        service         = $service
        warnings        = $warningList
        failures        = $failureList
        dryRun          = [bool]$DryRun
    }
}

# VBScript is deprecated on recent Windows builds and can be disabled; then the
# shortcut has to point at powershell.exe directly. On any doubt: powershell.
function Test-VbscriptAvailable {
    $tempRoot = $env:TEMP
    if ([string]::IsNullOrWhiteSpace($tempRoot)) { $tempRoot = [System.IO.Path]::GetTempPath() }
    $probe = Join-Path $tempRoot ('zct-vbs-probe-' + [Guid]::NewGuid().ToString('N') + '.vbs')
    try {
        [System.IO.File]::WriteAllText($probe, 'WScript.Quit 0' + "`r`n", [System.Text.Encoding]::ASCII)
        $cscript = Join-Path $env:SystemRoot 'System32\cscript.exe'
        if (-not (Test-Path -LiteralPath $cscript -PathType Leaf)) { return $false }
        $proc = Start-Process -FilePath $cscript -ArgumentList ('//nologo //E:vbscript "' + $probe + '"') -WindowStyle Hidden -Wait -PassThru
        return ($proc.ExitCode -eq 0)
    } catch {
        return $false
    } finally {
        try { Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue } catch { }
    }
}

# Shortcut ownership now lives in launcher\zcode-tarkov-shortcuts.ps1, which
# repair.ps1 and uninstall.ps1 load too (Test-ZctShortcutIsOurs /
# Test-ZctShortcutAdoptable), so the three scripts cannot disagree about which
# shortcut belongs to zcode-tarkov.

# Deterministic settings.json writer: BOM-free UTF-8, 2-space indent, the fixed
# schema every other script reads. The launcher carries a byte-compatible copy
# of this writer for its cached-path refresh.
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

function Complete-Install {
    param([int]$Code)
    $failureList = @(Get-RowStrings 'fail')
    $warningList = @(Get-RowStrings 'warn')
    if ($Json) {
        (Get-ResultObject) | ConvertTo-Json -Depth 6
    } else {
        Write-Report
        Write-Host ''
        if ($failureList.Count -gt 0) {
            Write-Host ('Result: FAILED - ' + $failureList.Count + ' item(s) above must be fixed; warnings: ' + $warningList.Count + '.')
        } else {
            Write-Host ('Result: installed zcode-tarkov ' + $version + ' into ' + $InstallDir + ' (warnings: ' + $warningList.Count + ').')
            Write-Host ('User data root (music, sounds, voice, pet, status, prefs.json): ' + $userDataRoot)
        }
        Write-NextSteps
    }
    exit $Code
}

# ------------------------------------------------------- preflight: settings --
# Read first: an existing settings.json supplies installedAt (preserved on
# re-install) and a cached zcodeExe that still exists. Only a file that carries
# our product marker may donate those values: a directory that merely contains a
# file named settings.json must not influence the install (and the adoption
# check below refuses it without -Force anyway).
$existingSettings = $null
if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
    try {
        $parsed = ([System.IO.File]::ReadAllText($settingsPath)) | ConvertFrom-Json -ErrorAction Stop
        if ($null -ne $parsed -and $parsed -isnot [System.Array] -and [string]$parsed.product -eq 'zcode-tarkov') {
            $existingSettings = $parsed
        }
    } catch { $existingSettings = $null }
}

# ------------------------------------------------------ preflight: platform ---
if ($env:OS -eq 'Windows_NT') {
    Add-Row -Status 'ok' -What 'platform' -Detail 'Windows'
} else {
    Add-Row -Status 'fail' -What 'platform' -Detail 'this installer supports Windows only'
}

# --------------------------------------------------- preflight: install dir ---
$installDirExisted = Test-Path -LiteralPath $InstallDir -PathType Container
if ($DryRun) {
    $detail = $InstallDir + ' does not exist yet (dry run: not created, writability not verified)'
    if ($installDirExisted) { $detail = $InstallDir + ' exists (dry run: not created, writability not verified)' }
    Add-Row -Status 'warn' -What 'install dir' -Detail $detail
} else {
    try {
        if (-not $installDirExisted) { New-Item -ItemType Directory -Path $InstallDir -Force -ErrorAction Stop | Out-Null }
        $probeFile = Join-Path $InstallDir ('.zct-write-probe-' + [Guid]::NewGuid().ToString('N'))
        [System.IO.File]::WriteAllText($probeFile, 'probe', [System.Text.Encoding]::ASCII)
        Remove-Item -LiteralPath $probeFile -Force -ErrorAction Stop
        $detail = $InstallDir
        if (-not $installDirExisted) { $detail = $detail + ' (created)' }
        Add-Row -Status 'ok' -What 'install dir' -Detail $detail
    } catch {
        Add-Row -Status 'fail' -What 'install dir' -Detail ($InstallDir + ' is not writable: ' + $_.Exception.Message)
    }
}
if ($installDirExisted) {
    # An existing settings.json is only an invitation when its *content* is ours:
    # a directory that merely contains a file of that name must not be extended
    # (the payload copy would overwrite it and the stale sweep would delete files
    # this project never created). Same rule and wording style as uninstall.ps1.
    if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
        if (-not $Force) {
            $adoptionProblem = $null
            try {
                $found = ([System.IO.File]::ReadAllText($settingsPath)) | ConvertFrom-Json -ErrorAction Stop
                $foundProduct = $null
                if ($null -ne $found -and $found -isnot [System.Array]) { $foundProduct = [string]$found.product }
                if ([string]::IsNullOrWhiteSpace($foundProduct)) {
                    $adoptionProblem = $settingsPath + ' carries no "product" key'
                } elseif ($foundProduct -ne 'zcode-tarkov') {
                    $adoptionProblem = $settingsPath + ' does not carry "product": "zcode-tarkov" (found product "' + $foundProduct + '")'
                }
            } catch {
                $adoptionProblem = $settingsPath + ' cannot be read: ' + $_.Exception.Message
            }
            if ($null -ne $adoptionProblem) {
                Add-Row -Status 'fail' -What 'install dir use' -Detail ($InstallDir + ' already exists and is not a zcode-tarkov install (' + $adoptionProblem + '); nothing was written (re-run with -Force to adopt it)')
            }
        }
    } else {
        $contents = @(Get-ChildItem -LiteralPath $InstallDir -Force -ErrorAction SilentlyContinue)
        if ($contents.Count -gt 0 -and -not $Force) {
            Add-Row -Status 'fail' -What 'install dir use' -Detail ($InstallDir + ' already exists and is not a zcode-tarkov install (' + $settingsPath + ' is missing); re-run with -Force to adopt it')
        }
    }
}

# ---------------------------------------------------------- preflight: node ---
$nodePath = $null
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if ($null -ne $nodeCommand) {
    $nodePath = [string]$nodeCommand.Source
    if ([string]::IsNullOrWhiteSpace($nodePath)) { $nodePath = [string]$nodeCommand.Definition }
}
if ([string]::IsNullOrWhiteSpace($nodePath) -or -not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
    $nodePath = $null
    foreach ($candidate in @('C:\Program Files\nodejs\node.exe')) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $nodePath = $candidate; break }
    }
}
if ([string]::IsNullOrWhiteSpace($nodePath) -and -not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    $candidate = Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { $nodePath = $candidate }
}
if ([string]::IsNullOrWhiteSpace($nodePath)) {
    Add-Row -Status 'fail' -What 'node' -Detail 'node.exe not found (checked PATH, C:\Program Files\nodejs, %LOCALAPPDATA%\Programs\nodejs)'
} else {
    $nodeVersion = ''
    try { $nodeVersion = ([string](& $nodePath --version 2>$null)).Trim() } catch { }
    Add-Row -Status 'ok' -What 'node' -Detail ($nodePath + ' ' + $nodeVersion)
}

# ---------------------------------------------------------- preflight: ZCode --
$discoveryPath = Join-Path $SourceDir 'launcher\zcode-tarkov-discovery.ps1'
if (-not (Test-Path -LiteralPath $discoveryPath -PathType Leaf)) {
    Add-Row -Status 'fail' -What 'zcode' -Detail ('the discovery script is missing: ' + $discoveryPath)
} else {
    $discoveryLoaded = $true
    try {
        . $discoveryPath
    } catch {
        $discoveryLoaded = $false
        Add-Row -Status 'fail' -What 'zcode' -Detail ('cannot load ' + $discoveryPath + ': ' + $_.Exception.Message)
    }
    if ($discoveryLoaded) {
        if (-not [string]::IsNullOrWhiteSpace($ZcodeExe)) {
            if (Test-Path -LiteralPath $ZcodeExe -PathType Leaf) {
                $full = $ZcodeExe
                try { $full = (Resolve-Path -LiteralPath $ZcodeExe -ErrorAction Stop).Path } catch { }
                $zcode = @{ Path = $full; InstallDir = (Split-Path -Path $full -Parent); ResolvedBy = 'param'; Candidates = @($ZcodeExe) }
            } else {
                Add-Row -Status 'fail' -What 'zcode' -Detail ('-ZcodeExe does not exist: ' + $ZcodeExe)
            }
        } else {
            # A cached path that still exists wins, otherwise full discovery.
            $cached = ''
            if ($existingSettings -and -not [string]::IsNullOrWhiteSpace([string]$existingSettings.zcodeExe)) { $cached = [string]$existingSettings.zcodeExe }
            $zcode = Find-ZcodeExe -Cached $cached
            if ($null -eq $zcode) {
                Add-Row -Status 'fail' -What 'zcode' -Detail 'ZCode.exe was not found (settings cache, ZCODE_WINDOWS_APP_INSTALL_DIR, App Paths, known paths, bounded scan)'
            }
        }
        if ($null -ne $zcode) {
            Add-Row -Status 'ok' -What 'zcode' -Detail ([string]$zcode.Path + ' (resolved by ' + [string]$zcode.ResolvedBy + ')')
        }
    }
}

# -------------------------------------------------------- preflight: payload --
$requiredPayload = @(
    'dist\cli.js',
    'dist\mcp\server.js',
    # The injected v0.2 client. It is required rather than optional: without it
    # the theme still applies, but audio, the dock, the pet, the status text and
    # the settings centre are all absent, which is a silently degraded install
    # rather than a visible failure.
    'dist\client.js',
    'launcher\zcode-tarkov-discovery.ps1',
    'launcher\zcode-tarkov-launch.ps1',
    'launcher\zcode-tarkov-launch.vbs',
    'launcher\zcode-tarkov-shortcuts.ps1',
    'LICENSE',
    'THIRD_PARTY_NOTICES.md'
)
$optionalPayload = @('repair.ps1', 'uninstall.ps1', 'README.md', 'README.zh-CN.md', 'CHANGELOG.md')

$missingRequired = @()
foreach ($relative in $requiredPayload) {
    if (-not (Test-Path -LiteralPath (Join-Path $SourceDir $relative) -PathType Leaf)) { $missingRequired += $relative }
}
$licenseFiles = @()
$licenseSource = Join-Path $SourceDir 'licenses'
if (Test-Path -LiteralPath $licenseSource -PathType Container) {
    $licenseFiles = @(Get-ChildItem -LiteralPath $licenseSource -File -ErrorAction SilentlyContinue)
}
if ($licenseFiles.Count -eq 0) { $missingRequired += 'licenses\*' }

$manifestPath = Join-Path $SourceDir '.zcode-plugin\plugin.json'
try { $version = [string](([System.IO.File]::ReadAllText($manifestPath)) | ConvertFrom-Json -ErrorAction Stop).version } catch { $version = '' }

if ($missingRequired.Count -gt 0) {
    Add-Row -Status 'fail' -What 'payload' -Detail ('missing below ' + $SourceDir + ': ' + ($missingRequired -join ', '))
} else {
    Add-Row -Status 'ok' -What 'payload' -Detail (($requiredPayload.Count + $licenseFiles.Count).ToString() + ' required file(s) present below ' + $SourceDir)
}
if ([string]::IsNullOrWhiteSpace($version)) {
    Add-Row -Status 'fail' -What 'version' -Detail ('cannot read "version" from ' + $manifestPath)
} else {
    Add-Row -Status 'ok' -What 'version' -Detail $version
}

# ----------------------------------------------------------- preflight: helper -
# The shortcut writer every lifecycle script shares. install.ps1 loads it from
# the source tree; repair.ps1 and uninstall.ps1 load the installed copy. Its
# presence is already covered by the payload row above, so this only reports a
# load failure.
$shortcutHelperPath = Join-Path $SourceDir 'launcher\zcode-tarkov-shortcuts.ps1'
$shortcutHelperLoaded = $false
if (Test-Path -LiteralPath $shortcutHelperPath -PathType Leaf) {
    try {
        . $shortcutHelperPath
        $shortcutHelperLoaded = $true
    } catch {
        Add-Row -Status 'fail' -What 'shortcut helper' -Detail ('cannot load ' + $shortcutHelperPath + ': ' + $_.Exception.Message)
    }
}

# ------------------------------------------------------------ preflight: ports --
if ($CdpPort -lt 1 -or $CdpPort -gt 65535) { Add-Row -Status 'fail' -What 'ports' -Detail ('-CdpPort must be 1..65535 (got ' + $CdpPort + ')') }
if ($ApiPort -lt 1 -or $ApiPort -gt 65535) { Add-Row -Status 'fail' -What 'ports' -Detail ('-ApiPort must be 1..65535 (got ' + $ApiPort + ')') }
if ($CdpPort -eq $ApiPort) { Add-Row -Status 'fail' -What 'ports' -Detail '-CdpPort and -ApiPort must differ' }

if (@(Get-RowStrings 'fail').Count -gt 0) {
    if (-not $Json) { Write-Host 'zcode-tarkov install: refused, nothing was installed.' }
    Complete-Install -Code 1
}

# ---------------------------------------------------------------- 1. payload ---
$plan = New-Object System.Collections.ArrayList
foreach ($relative in $requiredPayload) { [void]$plan.Add($relative) }
foreach ($relative in $optionalPayload) {
    if (Test-Path -LiteralPath (Join-Path $SourceDir $relative) -PathType Leaf) {
        [void]$plan.Add($relative)
    } else {
        Add-Row -Status 'warn' -What 'payload optional' -Detail ($relative + ' is not part of this source tree; skipped')
    }
}
foreach ($file in $licenseFiles) { [void]$plan.Add('licenses\' + $file.Name) }

if ($DryRun) {
    Add-Row -Status 'ok' -What 'payload copy' -Detail ('dry run: would copy ' + $plan.Count + ' file(s) into ' + $InstallDir)
} else {
    $copyFailed = $false
    foreach ($relative in $plan) {
        $source = Join-Path $SourceDir $relative
        $destination = Join-Path $InstallDir $relative
        $destinationDir = Split-Path -Path $destination -Parent
        try {
            if (-not (Test-Path -LiteralPath $destinationDir -PathType Container)) {
                New-Item -ItemType Directory -Path $destinationDir -Force -ErrorAction Stop | Out-Null
            }
            Copy-Item -LiteralPath $source -Destination $destination -Force -ErrorAction Stop
        } catch {
            Add-Row -Status 'fail' -What 'payload copy' -Detail ('cannot copy ' + $relative + ': ' + $_.Exception.Message)
            $copyFailed = $true
        }
    }
    if (-not $copyFailed) {
        Add-Row -Status 'ok' -What 'payload copy' -Detail ($plan.Count.ToString() + ' file(s) copied into ' + $InstallDir)
    }
}

# Stale payload: only files this installer owns can ever be removed, never
# anything a user put next to them. In -DryRun they are reported, not deleted.
# The enumeration is reparse-point safe (Get-ZctTreeFiles): Windows PowerShell
# 5.1 would otherwise follow a junction/symlink below dist/launcher/licenses and
# read - or here delete - the link target.
$keep = @{}
foreach ($relative in $plan) { $keep[$relative.ToLowerInvariant()] = $true }
foreach ($relative in $requiredPayload) { $keep[$relative.ToLowerInvariant()] = $true }
$stale = New-Object System.Collections.ArrayList
$skippedLinks = New-Object System.Collections.ArrayList
foreach ($managedDir in @('dist', 'launcher', 'licenses')) {
    $managedPath = Join-Path $InstallDir $managedDir
    if (-not (Test-Path -LiteralPath $managedPath -PathType Container)) { continue }
    $tree = Get-ZctTreeFiles -Root $managedPath
    foreach ($link in @($tree.Skipped)) { [void]$skippedLinks.Add([string]$link) }
    foreach ($file in @($tree.Files)) {
        if (-not $file.FullName.StartsWith($InstallDir, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
        $relative = $file.FullName.Substring($InstallDir.Length).TrimStart('\')
        if (-not $keep.ContainsKey($relative.ToLowerInvariant())) { [void]$stale.Add($relative) }
    }
}
if ($skippedLinks.Count -gt 0) {
    Add-Row -Status 'warn' -What 'stale payload' -Detail ('skipped ' + $skippedLinks.Count + ' reparse point(s) (junction/symlink), never followed: ' + (@($skippedLinks.ToArray()) -join ', '))
}
foreach ($relative in @($optionalPayload + @('LICENSE', 'THIRD_PARTY_NOTICES.md'))) {
    if ($keep.ContainsKey($relative.ToLowerInvariant())) { continue }
    if (Test-Path -LiteralPath (Join-Path $InstallDir $relative) -PathType Leaf) { [void]$stale.Add($relative) }
}
$removedList = New-Object System.Collections.ArrayList
foreach ($relative in $stale) {
    if ($DryRun) {
        [void]$removedList.Add($relative)
    } else {
        try {
            Remove-Item -LiteralPath (Join-Path $InstallDir $relative) -Force -ErrorAction Stop
            [void]$removedList.Add($relative)
        } catch {
            Add-Row -Status 'warn' -What 'stale payload' -Detail ('cannot remove ' + $relative + ': ' + $_.Exception.Message)
        }
    }
}
$removed = @($removedList.ToArray())
if ($removed.Count -gt 0) {
    $verb = 'removed'
    if ($DryRun) { $verb = 'dry run: would remove' }
    Add-Row -Status 'warn' -What 'stale payload' -Detail ($verb + ' ' + $removed.Count + ' file(s) this source no longer ships: ' + ($removed -join ', '))
}

if (@(Get-RowStrings 'fail').Count -gt 0) { Complete-Install -Code 1 }

# -------------------------------------------------------------- 2. shortcuts ---
if ($DryRun) {
    # No probe: -DryRun writes nothing, not even a scratch file.
    Add-Row -Status 'warn' -What 'launcher kind' -Detail 'dry run: VBScript availability not probed (a real run picks vbs, or powershell when VBScript is unavailable)'
}
$launcherKind = 'vbs'
if (-not $DryRun -and -not (Test-VbscriptAvailable)) { $launcherKind = 'powershell' }

if ($NoShortcuts) {
    Add-Row -Status 'ok' -What 'shortcut' -Detail 'skipped (-NoShortcuts)'
} elseif (-not $shortcutHelperLoaded) {
    Add-Row -Status 'fail' -What 'shortcut' -Detail ('skipped: the shared shortcut helper could not be loaded (' + $shortcutHelperPath + ')')
} else {
    # The shortcut is written by the shared helper so install, repair and
    # uninstall agree on what "ours" means and on when a file called
    # "ZCode Tarkov.lnk" may be replaced: only when its target is our shim, or -
    # as install.ps1 always did - a ZCode.exe entry from the older playtest
    # launcher, or when -Force asks for it.
    $recorded = New-Object System.Collections.ArrayList
    foreach ($dir in @($ShortcutDir)) {
        if ([string]::IsNullOrWhiteSpace($dir)) { continue }
        if (-not (Test-Path -LiteralPath $dir -PathType Container)) {
            Add-Row -Status 'warn' -What 'shortcut' -Detail ($dir + ' does not exist; skipped (nothing is created outside -InstallDir)')
            continue
        }
        $linkPath = Join-Path $dir 'ZCode Tarkov.lnk'
        $written = New-ZctLauncherShortcut -Path $linkPath -Kind $launcherKind -InstallDir $InstallDir -ZcodeExe ([string]$zcode.Path) -Force:$Force -DryRun:$DryRun
        if ($written.Status -eq 'refused') {
            Add-Row -Status 'warn' -What 'shortcut' -Detail ($linkPath + ' exists and is not a zcode-tarkov launcher; kept (re-run with -Force to replace it)')
            continue
        }
        if ($written.Status -eq 'failed') {
            Add-Row -Status 'fail' -What 'shortcut' -Detail ('cannot write ' + $linkPath + ': ' + $written.Message)
            continue
        }
        if ($written.Replaced) {
            Add-Row -Status 'warn' -What 'shortcut' -Detail ($linkPath + ' is not a zcode-tarkov launcher and was replaced (-Force)')
        }
        [void]$recorded.Add($linkPath)
        if ($written.Status -eq 'dry-run') {
            Add-Row -Status 'ok' -What 'shortcut' -Detail ('dry run: would write ' + $linkPath + ' -> ' + $written.Target)
        } elseif ($written.Status -eq 'kept') {
            Add-Row -Status 'ok' -What 'shortcut' -Detail ('kept ' + $linkPath)
        } else {
            Add-Row -Status 'ok' -What 'shortcut' -Detail ($written.Status + ' ' + $linkPath)
        }
    }
    $shortcuts = @($recorded.ToArray())
}

# ----------------------------------------------------------- 3. settings.json --
# Written after the shortcuts so the recorded list is accurate in one write.
$now = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
$installedAt = $now
if ($existingSettings -and -not [string]::IsNullOrWhiteSpace([string]$existingSettings.installedAt)) {
    $installedAt = [string]$existingSettings.installedAt
}
$recordedDataDir = $null
if (-not [string]::IsNullOrWhiteSpace($DataDir)) {
    $recordedDataDir = $DataDir
} elseif ($existingSettings -and -not [string]::IsNullOrWhiteSpace([string]$existingSettings.dataDir)) {
    $recordedDataDir = [string]$existingSettings.dataDir
}

$settingsObject = [ordered]@{
    product         = 'zcode-tarkov'
    version         = $version
    installDir      = $InstallDir
    nodePath        = $nodePath
    cliPath         = $cliPath
    cdpPort         = $CdpPort
    apiPort         = $ApiPort
    dataDir         = $recordedDataDir
    zcodeExe        = [string]$zcode.Path
    zcodeInstallDir = [string]$zcode.InstallDir
    zcodeResolvedBy = [string]$zcode.ResolvedBy
    launcherKind    = $launcherKind
    shortcuts       = @($shortcuts)
    installedAt     = $installedAt
    updatedAt       = $now
}

if ($DryRun) {
    Add-Row -Status 'ok' -What 'settings.json' -Detail ('dry run: would write ' + $settingsPath + ' (product ' + $version + ', cdp ' + $CdpPort + ', api ' + $ApiPort + ')')
} else {
    try {
        Write-SettingsFile -Path $settingsPath -Settings $settingsObject
        Add-Row -Status 'ok' -What 'settings.json' -Detail ($settingsPath + ' (product ' + $version + ', cdp ' + $CdpPort + ', api ' + $ApiPort + ')')
    } catch {
        Add-Row -Status 'fail' -What 'settings.json' -Detail ('cannot write ' + $settingsPath + ': ' + $_.Exception.Message)
    }
}

if (@(Get-RowStrings 'fail').Count -gt 0) { Complete-Install -Code 1 }

# ------------------------------------------------------- 4. user data root ----
# v0.2 keeps every file the user can see or change in %LOCALAPPDATA%\
# zcode-tarkov\data (or ZCODE_TARKOV_DATA_DIR), not in the plugin data
# directory a ZCode update may replace. Creating the five folders is the whole
# job here: they are created only when they are missing, so 4 GB of music, a
# hand-edited prefs.json or a previously downloaded voice pack is never
# overwritten, moved or deleted by an install or a re-install.
if ([string]::IsNullOrWhiteSpace($userDataRoot)) {
    Add-Row -Status 'fail' -What 'user data' -Detail 'the user data root cannot be determined (%LOCALAPPDATA% and %USERPROFILE% are both unset)'
} elseif ($DryRun) {
    $missingUserDirs = New-Object System.Collections.ArrayList
    foreach ($sub in $userDataSubdirs) {
        if (-not (Test-Path -LiteralPath (Join-Path $userDataRoot $sub) -PathType Container)) { [void]$missingUserDirs.Add($sub) }
    }
    Add-Row -Status 'ok' -What 'user data' -Detail ('dry run: would create ' + $missingUserDirs.Count + ' missing media director(y/ies) below ' + $userDataRoot + '; nothing there would be written or deleted')
} else {
    $userDataCreated = New-Object System.Collections.ArrayList
    $userDataFailure = ''
    foreach ($sub in $userDataSubdirs) {
        $path = Join-Path $userDataRoot $sub
        if (Test-Path -LiteralPath $path -PathType Container) { continue }
        # A file where a media folder belongs is user data; it is reported,
        # never removed or replaced to make room.
        if (Test-Path -LiteralPath $path) {
            $userDataFailure = $path + ' exists but is not a directory; it was not replaced'
            break
        }
        try {
            New-Item -ItemType Directory -Path $path -Force -ErrorAction Stop | Out-Null
        } catch {
            $userDataFailure = $path + ': ' + $_.Exception.Message
            break
        }
        # Windows PowerShell 5.1: New-Item -Force silently does nothing when the
        # name is already taken, so the directory is verified afterwards.
        if (-not (Test-Path -LiteralPath $path -PathType Container)) {
            $userDataFailure = $path + ' could not be created; nothing was replaced'
            break
        }
        [void]$userDataCreated.Add($sub)
    }
    if (-not [string]::IsNullOrWhiteSpace($userDataFailure)) {
        Add-Row -Status 'fail' -What 'user data' -Detail ('cannot create ' + $userDataFailure)
    } else {
        Add-Row -Status 'ok' -What 'user data' -Detail ($userDataRoot + ' (' + $userDataCreated.Count + ' media director(y/ies) created; existing files were not touched)')
    }
}

if (@(Get-RowStrings 'fail').Count -gt 0) { Complete-Install -Code 1 }

# ---------------------------------------------------------------- 5. service ---
$autostartEntry = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\zcode-beautify.vbs'
if ($NoService) {
    Add-Row -Status 'ok' -What 'autostart' -Detail 'skipped (-NoService)'
    Add-Row -Status 'ok' -What 'service' -Detail 'skipped (-NoService)'
    $autostart = [ordered]@{ status = 'skipped'; entryPath = $null }
    $service = [ordered]@{ status = 'skipped'; pid = $null }
} elseif ($DryRun) {
    Add-Row -Status 'ok' -What 'autostart' -Detail ('dry run: would run "recovery always" for the installed copy, entry at ' + $autostartEntry)
    $autostart = [ordered]@{ status = 'dry-run'; entryPath = $autostartEntry }
    $health = Get-ServiceHealth -ApiPort $ApiPort
    if ($null -ne $health) {
        Add-Row -Status 'ok' -What 'service' -Detail ('already running (pid ' + [string]$health.pid + '); dry run: not changed')
        $service = [ordered]@{ status = 'already-running'; pid = [int]$health.pid }
    } else {
        Add-Row -Status 'ok' -What 'service' -Detail ('not running; dry run: would start serve on api port ' + $ApiPort)
        $service = [ordered]@{ status = 'dry-run'; pid = $null }
    }
} else {
    # Same child environment as the launcher uses (the installed copy and the
    # recorded data dir): the $env: assignments below are inherited by every
    # child process started afterwards on this code path.
    $env:ZCODE_WINDOWS_APP_INSTALL_DIR = [string]$zcode.InstallDir
    if ($recordedDataDir) { $env:ZCODE_BEAUTIFY_DATA_DIR = $recordedDataDir }

    # 4a. autostart entry, written against the installed copy (not the source).
    $recoveryOutput = ''
    try {
        $recoveryOutput = ([string[]](& $nodePath $cliPath 'recovery' 'always' '--port' $CdpPort '--api-port' $ApiPort 2>&1) -join ' ').Trim()
    } catch {
        $recoveryOutput = $_.Exception.Message
    }
    if (Test-Path -LiteralPath $autostartEntry -PathType Leaf) {
        Add-Row -Status 'ok' -What 'autostart' -Detail ('registered ' + $autostartEntry)
        $autostart = [ordered]@{ status = 'registered'; entryPath = $autostartEntry }
    } else {
        Add-Row -Status 'fail' -What 'autostart' -Detail ('autostart entry not written (' + $autostartEntry + '): ' + $recoveryOutput)
        $autostart = [ordered]@{ status = 'failed'; entryPath = $autostartEntry }
    }

    # 4b. the resident service: never replace a healthy one.
    $health = Get-ServiceHealth -ApiPort $ApiPort
    if ($null -ne $health) {
        Add-Row -Status 'ok' -What 'service' -Detail ('already running (pid ' + [string]$health.pid + '); not changed')
        $service = [ordered]@{ status = 'already-running'; pid = [int]$health.pid }
    } else {
        $serviceArgs = '"' + $cliPath + '" serve --detach --port ' + $CdpPort + ' --api-port ' + $ApiPort
        $serviceStarted = $false
        try {
            Start-Process -FilePath $nodePath -ArgumentList $serviceArgs -WindowStyle Hidden
            $serviceStarted = $true
        } catch {
            Add-Row -Status 'fail' -What 'service' -Detail ('cannot start the theme service: ' + $_.Exception.Message)
            $service = [ordered]@{ status = 'failed'; pid = $null }
        }
        if ($serviceStarted) {
            for ($i = 0; $i -lt 30; $i++) {
                Start-Sleep -Milliseconds 500
                $health = Get-ServiceHealth -ApiPort $ApiPort
                if ($null -ne $health) { break }
            }
            if ($null -ne $health) {
                Add-Row -Status 'ok' -What 'service' -Detail ('started (pid ' + [string]$health.pid + ') on api port ' + $ApiPort)
                $service = [ordered]@{ status = 'started'; pid = [int]$health.pid }
            } else {
                Add-Row -Status 'fail' -What 'service' -Detail ('the theme service did not answer on api port ' + $ApiPort + ' within 15s')
                $service = [ordered]@{ status = 'unreachable'; pid = $null }
            }
        }
    }
}

# ------------------------------------------------------------------ 6. report --
if (@(Get-RowStrings 'fail').Count -gt 0) { Complete-Install -Code 1 }
Complete-Install -Code 0
