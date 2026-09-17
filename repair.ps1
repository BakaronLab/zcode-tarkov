#Requires -Version 5.1
#
# zcode-tarkov repair (user-level, idempotent)
#
# Purpose
#   Fixes an existing installation after the thing it depends on moved: it
#   re-detects ZCode.exe (a ZCode update can change the install path or the
#   version directory), re-resolves node.exe, verifies - or with -SourceDir
#   restores - the installed payload, recreates the v0.2 user data root's five
#   media folders when they are missing (without ever touching the files in
#   them), recreates the launcher shortcuts, checks the resident theme service,
#   and reports the three interfaces a ZCode software update can break: the
#   launcher, the DOM selectors and the CSS tokens.
#
# Usage
#   powershell -NoProfile -ExecutionPolicy Bypass -File repair.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File repair.ps1 -DryRun
#   powershell -NoProfile -ExecutionPolicy Bypass -File repair.ps1 -RestartService
#   powershell -NoProfile -ExecutionPolicy Bypass -File repair.ps1 -InstallDir <dir> -SourceDir <repo> -ZcodeExe <exe>
#
#   -InstallDir     default %LOCALAPPDATA%\Programs\zcode-tarkov
#   -SourceDir      optional source tree to re-copy the payload from (upgrade
#                   in place); without it the payload is only verified
#   -CdpPort/-ApiPort  0 = read settings.json, then 9222 / 9223. These ports are
#                   used for probing and for starting the service; they are
#                   never written back to settings.json
#   -ZcodeExe       explicit ZCode.exe; skips discovery
#   -ShortcutDir    merged into the recorded shortcut directories (the recorded
#                   list is always kept; the merge is reported)
#   -NoShortcuts    do not touch shortcuts
#   -NoService      do not probe, start or stop the service
#   -RestartService stop the running service (identity-checked) and start it
#                   again, so a freshly copied bundle reaches the running app
#   -DryRun         resolve, validate and report; writes and starts nothing
#   -Force          replace a "ZCode Tarkov.lnk" that is not ours
#   -Json           print only a machine-readable result object
#
# Exit codes
#   0  everything is healthy or was repaired
#   2  repaired, but something is still degraded (see the warnings)
#   1  blocked: the installation could not be repaired
#
# Safety
#   User-level only. This script never elevates (-Verb RunAs is never used),
#   never writes to machine-wide locations (C:\Program Files, %ProgramData%,
#   %PUBLIC%), never writes HKLM, PATH or any persistent environment variable,
#   and never modifies ZCode's installation files (it only reads them). The only
#   process it may stop is the zcode-tarkov service of this installation, and
#   only after its name, command line and "serve" token have been verified.
#
#   It never reads from stdin, never pauses and never prompts.
#
[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\zcode-tarkov'),
    [string]$SourceDir,
    [int]$CdpPort = 0,
    [int]$ApiPort = 0,
    [string]$ZcodeExe,
    [string[]]$ShortcutDir = @(),
    [switch]$NoShortcuts,
    [switch]$NoService,
    [switch]$RestartService,
    [switch]$DryRun,
    [switch]$Json,
    [switch]$Force
)

$ErrorActionPreference = 'Continue'

# --------------------------------------------------------------- normalizing --
try { $InstallDir = [System.IO.Path]::GetFullPath($InstallDir) } catch { }
if ($InstallDir.EndsWith('\') -and $InstallDir.Length -gt 3) { $InstallDir = $InstallDir.TrimEnd('\') }
if (-not [string]::IsNullOrWhiteSpace($SourceDir)) {
    try { $SourceDir = [System.IO.Path]::GetFullPath($SourceDir) } catch { }
    if ($SourceDir.EndsWith('\') -and $SourceDir.Length -gt 3) { $SourceDir = $SourceDir.TrimEnd('\') }
}

# The v0.2 user data root: music, sounds, voice, pet art, status texts and
# prefs.json, in a directory this product owns rather than in ZCode's plugin
# data directory (which a ZCode update may replace). Same rule as dataRoot() in
# src/core/dataRoot.ts, including the ZCODE_TARKOV_DATA_DIR override the
# lifecycle harness and the CDP tools point at a scratch tree; the default below
# is what every real install gets.
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
# src/prefs/types.ts), recreated empty when they are missing.
$userDataSubdirs = @('music', 'sounds', 'voice', 'pet', 'status')

$settingsPath = Join-Path $InstallDir 'settings.json'
$cliPath = Join-Path $InstallDir 'dist\cli.js'
$autostartEntry = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\zcode-beautify.vbs'

$rows = New-Object System.Collections.ArrayList
$degraded = $false
$autostart = [ordered]@{ status = 'not-checked'; entryPath = $autostartEntry }
$service = [ordered]@{ status = 'not-checked'; pid = $null; detail = '' }
$interfaces = New-Object System.Collections.ArrayList
$shortcutPaths = @()
$shortcutDirText = '(none recorded)'
$version = ''
$zcode = $null
$zcodeExeText = $null
$zcodeResolvedByText = $null
$zcodeCandidates = @()
$nodePath = ''
$recordedDataDir = $null
$launcherKind = 'vbs'
$settingsLoaded = $false

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

function Add-Degraded {
    $script:degraded = $true
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

function Get-ResultObject {
    $failureList = @(Get-RowStrings 'fail')
    $warningList = @(Get-RowStrings 'warn')
    return [ordered]@{
        ok              = (($failureList.Count -eq 0) -and (-not $script:degraded))
        version         = $version
        installDir      = $InstallDir
        userDataDir     = $userDataRoot
        zcodeExe        = $zcodeExeText
        zcodeResolvedBy = $zcodeResolvedByText
        zcodeCandidates = @($zcodeCandidates)
        nodePath        = $nodePath
        shortcuts       = @($shortcutPaths)
        autostart       = $autostart
        service         = $service
        interfaces      = @($interfaces.ToArray())
        warnings        = $warningList
        failures        = $failureList
        dryRun          = [bool]$DryRun
    }
}

function Write-NextSteps {
    Write-Host ''
    Write-Host 'Next steps:'
    Write-Host '  1. Start ZCode from the "ZCode Tarkov" shortcut (Desktop / Start Menu).'
    # install.ps1 lives in the source checkout, never in the installed tree: do
    # not point at a path that does not exist.
    Write-Host '  2. To rebuild the installation, run install.ps1 from the zcode-tarkov source checkout (the installed tree deliberately carries no installer); see the Install section of README.md.'
    $uninstallPath = Join-Path $InstallDir 'uninstall.ps1'
    if (Test-Path -LiteralPath $uninstallPath -PathType Leaf) {
        Write-Host ('  3. To remove it again: powershell -NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $uninstallPath)
    } else {
        Write-Host '  3. To remove it again, run uninstall.ps1 from the zcode-tarkov source checkout (this install has no uninstall.ps1).'
    }
}

function Complete-Repair {
    $failureList = @(Get-RowStrings 'fail')
    $warningList = @(Get-RowStrings 'warn')
    $code = 0
    if ($failureList.Count -gt 0) { $code = 1 }
    elseif ($script:degraded) { $code = 2 }
    if ($Json) {
        (Get-ResultObject) | ConvertTo-Json -Depth 6
    } else {
        Write-Report
        Write-Host ''
        if ($code -eq 1) {
            Write-Host ('Result: BLOCKED - ' + $failureList.Count + ' item(s) above must be fixed first.')
        } elseif ($code -eq 2) {
            Write-Host ('Result: repaired, but degraded - see the ' + $warningList.Count + ' warning(s) above.')
        } else {
            Write-Host ('Result: healthy (zcode-tarkov ' + $version + ' in ' + $InstallDir + ', warnings: ' + $warningList.Count + ').')
        }
        Write-NextSteps
    }
    exit $code
}

# ------------------------------------------------------------- json writer ----
# Byte-compatible copy of install.ps1's writer: same schema, same order, BOM-free
# UTF-8, CRLF, 2-space indent. repair.ps1 only ever rewrites values it re-resolved
# (zcodeExe / zcodeInstallDir / zcodeResolvedBy / nodePath / shortcuts / updatedAt).
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

# Starts the resident service exactly the way install.ps1 and the launcher do,
# with the same child environment, and waits up to 15s for /api/health. Returns
# $null on success and a message on failure.
function Start-ZctService {
    param([string]$NodePath, [string]$Cli, [int]$Cdp, [int]$Api, [string]$ZcodeDir, [string]$DataDirToUse)
    if ([string]::IsNullOrWhiteSpace($NodePath) -or -not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
        return ('node.exe was not found at ' + $NodePath + '; run install.ps1')
    }
    if (-not (Test-Path -LiteralPath $Cli -PathType Leaf)) {
        return ('the CLI bundle is missing: ' + $Cli + '; run install.ps1 or repair.ps1 -SourceDir')
    }
    # $env: assignments are inherited by every child process started afterwards.
    $env:ZCODE_WINDOWS_APP_INSTALL_DIR = $ZcodeDir
    if (-not [string]::IsNullOrWhiteSpace($DataDirToUse)) { $env:ZCODE_BEAUTIFY_DATA_DIR = $DataDirToUse }
    $serviceArgs = '"' + $Cli + '" serve --detach --port ' + $Cdp + ' --api-port ' + $Api
    try {
        Start-Process -FilePath $NodePath -ArgumentList $serviceArgs -WindowStyle Hidden
    } catch {
        return ('cannot start the theme service: ' + $_.Exception.Message)
    }
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 500
        $probe = Get-ServiceHealth -ApiPort $Api
        if ($null -ne $probe) { return $null }
    }
    return ('the theme service did not answer on api port ' + $Api + ' within 15s; see serve.log in the data directory')
}

# ---------------------------------------------------------------- helpers -----
$shortcutHelperAvailable = $false
$discoveryAvailable = $false
$helperPath = Join-Path $PSScriptRoot 'launcher\zcode-tarkov-shortcuts.ps1'
$discoveryPath = Join-Path $PSScriptRoot 'launcher\zcode-tarkov-discovery.ps1'
if (Test-Path -LiteralPath $helperPath -PathType Leaf) {
    try { . $helperPath; $shortcutHelperAvailable = $true } catch { Add-Row -Status 'fail' -What 'helper' -Detail ('cannot load ' + $helperPath + ': ' + $_.Exception.Message) }
} else {
    Add-Row -Status 'fail' -What 'helper' -Detail ('the shared shortcut helper is missing: ' + $helperPath)
}
if (Test-Path -LiteralPath $discoveryPath -PathType Leaf) {
    try { . $discoveryPath; $discoveryAvailable = $true } catch { Add-Row -Status 'fail' -What 'helper' -Detail ('cannot load ' + $discoveryPath + ': ' + $_.Exception.Message) }
} else {
    Add-Row -Status 'fail' -What 'helper' -Detail ('the discovery helper is missing: ' + $discoveryPath)
}

# ------------------------------------------------------------- 1. settings ----
$settings = $null
if (-not (Test-Path -LiteralPath $settingsPath -PathType Leaf)) {
    Add-Row -Status 'fail' -What 'install' -Detail ('zcode-tarkov is not installed in ' + $InstallDir + ' (' + $settingsPath + ' is missing); run install.ps1 first')
    Complete-Repair
}
if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
    try {
        $settings = ([System.IO.File]::ReadAllText($settingsPath)) | ConvertFrom-Json -ErrorAction Stop
    } catch {
        Add-Row -Status 'fail' -What 'install' -Detail ('zcode-tarkov is not installed correctly in ' + $InstallDir + ' (' + $settingsPath + ' cannot be read: ' + $_.Exception.Message + '); run install.ps1')
        Complete-Repair
    }
}
if ($null -eq $settings -or [string]$settings.product -ne 'zcode-tarkov') {
    Add-Row -Status 'fail' -What 'install' -Detail ('zcode-tarkov is not installed in ' + $InstallDir + ' (' + $settingsPath + ' does not carry "product": "zcode-tarkov"); run install.ps1')
    Complete-Repair
}
$settingsLoaded = $true
$version = [string]$settings.version
Add-Row -Status 'ok' -What 'install' -Detail ($settingsPath + ' (product zcode-tarkov ' + $version + ')')

# Values that were not given come from settings.json, then the documented
# defaults (0 means "not given"). The recorded ports are what gets written back.
$resolvedCdpPort = $CdpPort
$resolvedApiPort = $ApiPort
$recordedCdpPort = 9222
$recordedApiPort = 9223
try { if ([int]$settings.cdpPort -gt 0) { $recordedCdpPort = [int]$settings.cdpPort } } catch { }
try { if ([int]$settings.apiPort -gt 0) { $recordedApiPort = [int]$settings.apiPort } } catch { }
if ($resolvedCdpPort -le 0) { $resolvedCdpPort = $recordedCdpPort }
if ($resolvedApiPort -le 0) { $resolvedApiPort = $recordedApiPort }
$recordedDataDir = [string]$settings.dataDir
if ([string]::IsNullOrWhiteSpace($recordedDataDir)) { $recordedDataDir = $null }
$launcherKind = [string]$settings.launcherKind
if ($launcherKind -ne 'vbs' -and $launcherKind -ne 'powershell') {
    Add-Row -Status 'warn' -What 'launcher kind' -Detail ('settings.json records "' + $launcherKind + '"; falling back to vbs')
    $launcherKind = 'vbs'
}
Add-Row -Status 'info' -What 'ports' -Detail ('cdp ' + $resolvedCdpPort + ', api ' + $resolvedApiPort + ' (api health is probed on ' + $resolvedApiPort + ')')

$settingsDirty = $false
$settingsCdpPort = $recordedCdpPort
$settingsApiPort = $recordedApiPort
$settingsZcodeExe = [string]$settings.zcodeExe
$settingsZcodeInstallDir = [string]$settings.zcodeInstallDir
$settingsZcodeResolvedBy = [string]$settings.zcodeResolvedBy
$settingsShortcuts = @()
if ($null -ne $settings.shortcuts) {
    $settingsShortcuts = @($settings.shortcuts | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
}
$installedAt = [string]$settings.installedAt

# ------------------------------------------------------------- 2. ZCode -------
if (-not $discoveryAvailable) {
    Add-Row -Status 'fail' -What 'zcode' -Detail ('the discovery helper is missing (' + $discoveryPath + ')')
} elseif (-not [string]::IsNullOrWhiteSpace($ZcodeExe)) {
    if (Test-Path -LiteralPath $ZcodeExe -PathType Leaf) {
        $full = $ZcodeExe
        try { $full = (Resolve-Path -LiteralPath $ZcodeExe -ErrorAction Stop).Path } catch { }
        $zcode = @{ Path = $full; InstallDir = (Split-Path -Path $full -Parent); ResolvedBy = 'param'; Candidates = @($ZcodeExe) }
    } else {
        Add-Row -Status 'fail' -What 'zcode' -Detail ('-ZcodeExe does not exist: ' + $ZcodeExe)
    }
} else {
    $zcode = Find-ZcodeExe -Cached ([string]$settings.zcodeExe)
    if ($null -eq $zcode) {
        Add-Row -Status 'fail' -What 'zcode' -Detail 'ZCode.exe was not found (settings cache, ZCODE_WINDOWS_APP_INSTALL_DIR, App Paths, known paths, bounded scan); run install.ps1 with -ZcodeExe, or install ZCode again'
    }
}
if ($null -ne $zcode) {
    $zcodeExeText = [string]$zcode.Path
    $zcodeResolvedByText = [string]$zcode.ResolvedBy
    $zcodeCandidates = @($zcode.Candidates)
    Add-Row -Status 'ok' -What 'zcode' -Detail ([string]$zcode.Path + ' (resolved by ' + [string]$zcode.ResolvedBy + ')')
    if ($zcodeCandidates.Count -gt 0) {
        Add-Row -Status 'info' -What 'zcode probes' -Detail ($zcodeCandidates.Count.ToString() + ' location(s) probed: ' + ($zcodeCandidates -join '; '))
    }
    if ([string]$zcode.Path -ne $settingsZcodeExe) {
        Add-Row -Status 'ok' -What 'settings.json' -Detail ('the recorded ZCode path changed: ' + $settingsZcodeExe + ' -> ' + [string]$zcode.Path + ' (a ZCode update usually causes this)')
        $settingsZcodeExe = [string]$zcode.Path
        $settingsZcodeInstallDir = [string]$zcode.InstallDir
        $settingsZcodeResolvedBy = [string]$zcode.ResolvedBy
        $settingsDirty = $true
    } else {
        Add-Row -Status 'info' -What 'settings.json' -Detail ('the recorded ZCode path is still valid (resolved by ' + [string]$zcode.ResolvedBy + ')')
    }
}

# -------------------------------------------------------------- 3. node -------
$nodePath = [string]$settings.nodePath
if (-not [string]::IsNullOrWhiteSpace($nodePath) -and (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
    Add-Row -Status 'ok' -What 'node' -Detail ($nodePath + ' (recorded in settings.json)')
} else {
    $foundNode = $null
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($null -ne $nodeCommand) {
        $candidate = [string]$nodeCommand.Source
        if ([string]::IsNullOrWhiteSpace($candidate)) { $candidate = [string]$nodeCommand.Definition }
        if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { $foundNode = $candidate }
    }
    if ($null -eq $foundNode) {
        foreach ($candidate in @('C:\Program Files\nodejs\node.exe')) {
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { $foundNode = $candidate; break }
        }
    }
    if ($null -eq $foundNode -and -not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        $candidate = Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $foundNode = $candidate }
    }
    if ($null -eq $foundNode) {
        Add-Row -Status 'fail' -What 'node' -Detail ('node.exe was not found at ' + $nodePath + ' and is not on PATH, in C:\Program Files\nodejs or in %LOCALAPPDATA%\Programs\nodejs; install node.js 20 or newer')
    } else {
        Add-Row -Status 'ok' -What 'node' -Detail ('re-resolved, the recorded path was stale: ' + $nodePath + ' -> ' + $foundNode)
        $nodePath = $foundNode
        $settingsDirty = $true
    }
}

# ------------------------------------------------------------ 4. payload ------
$requiredPayload = @(
    'dist\cli.js',
    'dist\mcp\server.js',
    # Repair restores the injected client too: a repair that puts back the CLI
    # but not the client would leave the v0.2 features missing while reporting
    # the install as healthy.
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
    if (-not (Test-Path -LiteralPath (Join-Path $InstallDir $relative) -PathType Leaf)) { $missingRequired += $relative }
}
if (-not (Test-Path -LiteralPath (Join-Path $InstallDir 'licenses') -PathType Container)) {
    Add-Row -Status 'warn' -What 'payload' -Detail 'the installed tree has no licenses\ directory'
}

if ([string]::IsNullOrWhiteSpace($SourceDir)) {
    if ($missingRequired.Count -gt 0) {
        Add-Row -Status 'fail' -What 'payload' -Detail ('the installed tree is incomplete: ' + ($missingRequired -join ', ') + ' - re-run install.ps1, or repair.ps1 with -SourceDir <tree>')
    } else {
        Add-Row -Status 'ok' -What 'payload' -Detail ($requiredPayload.Count.ToString() + ' required file(s) present in ' + $InstallDir)
    }
} else {
    $plan = New-Object System.Collections.ArrayList
    $sourceMissing = @()
    foreach ($relative in $requiredPayload) { [void]$plan.Add($relative) }
    foreach ($relative in $optionalPayload) {
        if (Test-Path -LiteralPath (Join-Path $SourceDir $relative) -PathType Leaf) { [void]$plan.Add($relative) }
    }
    $licenseSource = Join-Path $SourceDir 'licenses'
    $licenseSourcePresent = Test-Path -LiteralPath $licenseSource -PathType Container
    if ($licenseSourcePresent) {
        foreach ($file in @(Get-ChildItem -LiteralPath $licenseSource -File -ErrorAction SilentlyContinue)) {
            [void]$plan.Add('licenses\' + $file.Name)
        }
    } else {
        Add-Row -Status 'warn' -What 'payload source' -Detail ('the source tree has no licenses\ directory; the installed copies are kept')
    }
    foreach ($relative in $plan) {
        if (-not (Test-Path -LiteralPath (Join-Path $SourceDir $relative) -PathType Leaf)) { $sourceMissing += $relative }
    }
    if ($sourceMissing.Count -gt 0) {
        Add-Row -Status 'fail' -What 'payload source' -Detail ('missing below ' + $SourceDir + ': ' + ($sourceMissing -join ', '))
    } else {
        $added = New-Object System.Collections.ArrayList
        $updated = New-Object System.Collections.ArrayList
        $unchanged = 0
        foreach ($relative in $plan) {
            $source = Join-Path $SourceDir $relative
            $destination = Join-Path $InstallDir $relative
            $state = 'added'
            if (Test-Path -LiteralPath $destination -PathType Leaf) {
                $state = 'updated'
                try {
                    $sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256 -ErrorAction Stop).Hash
                    $destinationHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256 -ErrorAction Stop).Hash
                    if ($sourceHash -eq $destinationHash) { $state = 'unchanged' }
                } catch {
                    $state = 'updated'
                }
            }
            if ($state -eq 'added') { [void]$added.Add($relative) }
            elseif ($state -eq 'updated') { [void]$updated.Add($relative) }
            else { $unchanged = $unchanged + 1 }
            if ($state -eq 'unchanged') { continue }
            if ($DryRun) { continue }
            try {
                $destinationDir = Split-Path -Path $destination -Parent
                if (-not (Test-Path -LiteralPath $destinationDir -PathType Container)) {
                    New-Item -ItemType Directory -Path $destinationDir -Force -ErrorAction Stop | Out-Null
                }
                Copy-Item -LiteralPath $source -Destination $destination -Force -ErrorAction Stop
            } catch {
                Add-Row -Status 'fail' -What 'payload copy' -Detail ('cannot copy ' + $relative + ': ' + $_.Exception.Message)
            }
        }
        $prefix = ''
        if ($DryRun) { $prefix = 'dry run: would copy ' }
        Add-Row -Status 'ok' -What 'payload copy' -Detail ($prefix + $plan.Count.ToString() + ' file(s) from ' + $SourceDir + ' (' + $added.Count + ' added, ' + $updated.Count + ' updated, ' + $unchanged + ' unchanged)')

        # Stale payload: only files in the directories this installer owns, and
        # never a file that is not part of the plan. The enumeration is
        # reparse-point safe (Get-ZctTreeFiles): Windows PowerShell 5.1 would
        # otherwise follow a junction/symlink below dist/launcher/licenses and
        # read - or here delete - the link target.
        $keep = @{}
        foreach ($relative in $plan) { $keep[$relative.ToLowerInvariant()] = $true }
        foreach ($relative in $requiredPayload) { $keep[$relative.ToLowerInvariant()] = $true }
        if (-not $licenseSourcePresent) {
            $installedLicenses = Join-Path $InstallDir 'licenses'
            if (Test-Path -LiteralPath $installedLicenses -PathType Container) {
                foreach ($file in @(Get-ChildItem -LiteralPath $installedLicenses -File -ErrorAction SilentlyContinue)) {
                    $keep[('licenses\' + $file.Name).ToLowerInvariant()] = $true
                }
            }
        }
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
        $staleRemoved = New-Object System.Collections.ArrayList
        foreach ($relative in $stale) {
            if ($DryRun) { [void]$staleRemoved.Add($relative); continue }
            try {
                Remove-Item -LiteralPath (Join-Path $InstallDir $relative) -Force -ErrorAction Stop
                [void]$staleRemoved.Add($relative)
            } catch {
                Add-Row -Status 'warn' -What 'stale payload' -Detail ('cannot remove ' + $relative + ': ' + $_.Exception.Message)
            }
        }
        if ($staleRemoved.Count -gt 0) {
            $verb = 'removed'
            if ($DryRun) { $verb = 'dry run: would remove' }
            Add-Row -Status 'warn' -What 'stale payload' -Detail ($verb + ' ' + $staleRemoved.Count + ' file(s) this source no longer ships: ' + (@($staleRemoved.ToArray()) -join ', '))
        }
    }
}

# -------------------------------------------------------- 5. user data root ---
# The v0.2 state - music, sounds, voice, pet art, status texts and prefs.json -
# lives below %LOCALAPPDATA%\zcode-tarkov\data, or the ZCODE_TARKOV_DATA_DIR
# override. A ZCode update cannot replace that root, but a user or a cleaner can
# delete it. Repair recreates only what is missing and never writes into,
# overwrites or deletes a file that is already there: a media library can be
# several GB and is not this script's to change.
if ([string]::IsNullOrWhiteSpace($userDataRoot)) {
    Add-Row -Status 'fail' -What 'user data' -Detail 'the user data root cannot be determined (%LOCALAPPDATA% and %USERPROFILE% are both unset)'
} else {
    $missingUserDirs = New-Object System.Collections.ArrayList
    foreach ($sub in $userDataSubdirs) {
        if (-not (Test-Path -LiteralPath (Join-Path $userDataRoot $sub) -PathType Container)) { [void]$missingUserDirs.Add($sub) }
    }
    if ($missingUserDirs.Count -eq 0) {
        Add-Row -Status 'ok' -What 'user data' -Detail ($userDataRoot + ' (all ' + $userDataSubdirs.Count + ' media directories present; nothing in it was touched)')
    } elseif ($DryRun) {
        Add-Row -Status 'ok' -What 'user data' -Detail ('dry run: would recreate ' + $missingUserDirs.Count + ' missing media director(y/ies) below ' + $userDataRoot + ': ' + (@($missingUserDirs.ToArray()) -join ', '))
    } else {
        $userDirsCreated = New-Object System.Collections.ArrayList
        $userDataFailure = ''
        foreach ($sub in $missingUserDirs) {
            $path = Join-Path $userDataRoot $sub
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
            # Windows PowerShell 5.1: New-Item -Force silently does nothing when
            # the name is already taken, so the directory is verified afterwards.
            if (-not (Test-Path -LiteralPath $path -PathType Container)) {
                $userDataFailure = $path + ' could not be created; nothing was replaced'
                break
            }
            [void]$userDirsCreated.Add($sub)
        }
        if (-not [string]::IsNullOrWhiteSpace($userDataFailure)) {
            Add-Row -Status 'fail' -What 'user data' -Detail ('cannot recreate ' + $userDataFailure)
        } else {
            Add-Row -Status 'ok' -What 'user data' -Detail ('recreated ' + $userDirsCreated.Count + ' missing media director(y/ies) below ' + $userDataRoot + ': ' + (@($userDirsCreated.ToArray()) -join ', '))
        }
    }
}

# ---------------------------------------------------------- 6. shortcuts ------
if ($NoShortcuts) {
    Add-Row -Status 'ok' -What 'shortcut' -Detail 'skipped (-NoShortcuts)'
} elseif (-not $shortcutHelperAvailable) {
    Add-Row -Status 'warn' -What 'shortcut' -Detail 'skipped: the shared shortcut helper could not be loaded'
} else {
    # The recorded directories always stay in the list; -ShortcutDir is merged
    # into them (H7). A directory that is given but does not exist must not be
    # able to erase what settings.json already recorded.
    $dirs = New-Object System.Collections.ArrayList
    $seenDirs = @{}
    $addDir = {
        param([string]$Dir)
        if ([string]::IsNullOrWhiteSpace($Dir)) { return $false }
        $value = $Dir
        try { $value = [System.IO.Path]::GetFullPath($value) } catch { }
        if ($value.EndsWith('\') -and $value.Length -gt 3) { $value = $value.TrimEnd('\') }
        $key = $value.ToLowerInvariant()
        if ($seenDirs.ContainsKey($key)) { return $false }
        $seenDirs[$key] = $true
        [void]$script:dirs.Add($value)
        return $true
    }
    foreach ($recorded in @($settingsShortcuts)) {
        if ([string]::IsNullOrWhiteSpace([string]$recorded)) { continue }
        $value = [string]$recorded
        $parent = $value
        if (-not (Test-Path -LiteralPath $value -PathType Container)) { $parent = Split-Path -Path $value -Parent }
        [void](& $addDir $parent)
    }
    if (@($ShortcutDir).Count -gt 0) {
        $givenAdded = 0
        foreach ($given in @($ShortcutDir)) { if (& $addDir $given) { $givenAdded = $givenAdded + 1 } }
        Add-Row -Status 'ok' -What 'shortcut' -Detail ('merged ' + $givenAdded + ' given -ShortcutDir entr(y/ies) into ' + $dirs.Count + ' director(y/ies); the recorded ones are kept')
    }

    if ($dirs.Count -eq 0) {
        Add-Row -Status 'warn' -What 'shortcut' -Detail 'no shortcut directory is recorded in settings.json; nothing to recreate'
    } else {
        $mergedPaths = New-Object System.Collections.ArrayList
        foreach ($recorded in @($settingsShortcuts)) {
            if (-not [string]::IsNullOrWhiteSpace([string]$recorded)) { [void]$mergedPaths.Add([string]$recorded) }
        }
        $recordedPaths = New-Object System.Collections.ArrayList
        foreach ($dir in $dirs) {
            if (-not (Test-Path -LiteralPath $dir -PathType Container)) {
                Add-Row -Status 'warn' -What 'shortcut' -Detail ($dir + ' does not exist; skipped, its recorded entry stays in settings.json (nothing is created outside the recorded directories)')
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
            [void]$recordedPaths.Add($linkPath)
            $knownLink = $false
            foreach ($existing in $mergedPaths) {
                if ([string]$existing -ieq $linkPath) { $knownLink = $true; break }
            }
            if (-not $knownLink) { [void]$mergedPaths.Add($linkPath) }
            if ($written.Status -eq 'dry-run') {
                Add-Row -Status 'ok' -What 'shortcut' -Detail ('dry run: would write ' + $linkPath + ' -> ' + $written.Target)
            } else {
                Add-Row -Status 'ok' -What 'shortcut' -Detail ($written.Status + ' ' + $linkPath)
            }
        }
        $shortcutPaths = @($recordedPaths.ToArray())
        $shortcutDirText = @($dirs.ToArray()) -join '; '
        $recordedList = @($settingsShortcuts)
        $newList = @($mergedPaths.ToArray())
        $sameList = ($recordedList.Count -eq $newList.Count)
        if ($sameList) {
            for ($i = 0; $i -lt $recordedList.Count; $i++) {
                if ([string]$recordedList[$i] -ne [string]$newList[$i]) { $sameList = $false; break }
            }
        }
        if (-not $sameList) {
            Add-Row -Status 'info' -What 'shortcut' -Detail ('settings.json shortcut list updated: ' + ($newList -join '; '))
            $settingsShortcuts = @($newList)
            $settingsDirty = $true
        }
    }
}

# ------------------------------------------------------------- 7. service -----
if ($NoService) {
    Add-Row -Status 'ok' -What 'service' -Detail 'skipped (-NoService)'
    $service = [ordered]@{ status = 'skipped'; pid = $null; detail = 'skipped (-NoService)' }
} elseif (-not ($discoveryAvailable -and $shortcutHelperAvailable)) {
    Add-Row -Status 'fail' -What 'service' -Detail 'the shared helpers could not be loaded, so the service cannot be identified or started'
} else {
    # Starts the service the same way install.ps1 and the launcher do, with the
    # same child environment (Start-ZctService, defined above).
    $health = Get-ServiceHealth -ApiPort $resolvedApiPort
    $portOpen = Test-PortOpen -Port $resolvedApiPort
    $servicePid = 0
    $identity = $null
    if ($null -ne $health) {
        try { $servicePid = [int]$health.pid } catch { $servicePid = 0 }
        $identity = Test-ZctProcessIsOurs -ProcessId $servicePid -InstallDir $InstallDir -CliPath $cliPath -RequireServe
    }

    if ($null -ne $health -and -not $identity.Ok) {
        Add-Row -Status 'warn' -What 'service' -Detail ('api port ' + $resolvedApiPort + ' is owned by pid ' + $servicePid + ' which does not look like this install (' + $identity.Reason + '); another service owns the port')
        $service = [ordered]@{ status = 'foreign'; pid = $servicePid; detail = [string]$identity.Reason }
        Add-Degraded
    } elseif ($null -ne $health -and $identity.Ok -and -not $RestartService) {
        Add-Row -Status 'ok' -What 'service' -Detail ('healthy (pid ' + $servicePid + ') on api port ' + $resolvedApiPort)
        $service = [ordered]@{ status = 'healthy'; pid = $servicePid; detail = [string]$identity.CommandLine }
    } elseif ($null -ne $health -and $identity.Ok -and $RestartService) {
        if ($DryRun) {
            Add-Row -Status 'ok' -What 'service' -Detail ('dry run: would stop pid ' + $servicePid + ' and start it again on api port ' + $resolvedApiPort)
            $service = [ordered]@{ status = 'dry-run'; pid = $servicePid; detail = 'restart' }
        } else {
            try {
                Stop-Process -Id $servicePid -Force -ErrorAction Stop
                Add-Row -Status 'ok' -What 'service' -Detail ('stopped pid ' + $servicePid + ' for the restart (' + [string]$identity.CommandLine + ')')
                for ($i = 0; $i -lt 20; $i++) {
                    Start-Sleep -Milliseconds 500
                    if (-not (Test-PortOpen -Port $resolvedApiPort -TimeoutMs 250)) { break }
                }
                $startError = Start-ZctService -NodePath $nodePath -Cli $cliPath -Cdp $resolvedCdpPort -Api $resolvedApiPort -ZcodeDir ([string]$zcode.InstallDir) -DataDirToUse $recordedDataDir
                if ($null -eq $startError) {
                    $restarted = Get-ServiceHealth -ApiPort $resolvedApiPort
                    $newPid = 0
                    if ($null -ne $restarted) { try { $newPid = [int]$restarted.pid } catch { $newPid = 0 } }
                    Add-Row -Status 'ok' -What 'service' -Detail ('restarted, pid ' + $newPid + ' (was ' + $servicePid + ') on api port ' + $resolvedApiPort)
                    $service = [ordered]@{ status = 'restarted'; pid = $newPid; detail = 'was ' + $servicePid }
                } else {
                    Add-Row -Status 'fail' -What 'service' -Detail $startError
                    $service = [ordered]@{ status = 'unreachable'; pid = $null; detail = $startError }
                }
            } catch {
                Add-Row -Status 'fail' -What 'service' -Detail ('cannot stop pid ' + $servicePid + ' for the restart: ' + $_.Exception.Message)
                $service = [ordered]@{ status = 'stop-failed'; pid = $servicePid; detail = $_.Exception.Message }
            }
        }
    } elseif ($null -eq $health) {
        if ($portOpen) {
            Add-Row -Status 'warn' -What 'service' -Detail ('api port ' + $resolvedApiPort + ' is open but does not answer /api/health as zcode-tarkov; not starting a second service on that port')
            $service = [ordered]@{ status = 'foreign-port'; pid = $null; detail = 'the port answers, but not as zcode-tarkov' }
            Add-Degraded
        } elseif ($DryRun) {
            Add-Row -Status 'ok' -What 'service' -Detail ('not running; dry run: would start serve on api port ' + $resolvedApiPort)
            $service = [ordered]@{ status = 'dry-run'; pid = $null; detail = 'would start' }
        } else {
            $startError = Start-ZctService -NodePath $nodePath -Cli $cliPath -Cdp $resolvedCdpPort -Api $resolvedApiPort -ZcodeDir ([string]$zcode.InstallDir) -DataDirToUse $recordedDataDir
            if ($null -eq $startError) {
                $started = Get-ServiceHealth -ApiPort $resolvedApiPort
                $newPid = 0
                if ($null -ne $started) { try { $newPid = [int]$started.pid } catch { $newPid = 0 } }
                Add-Row -Status 'ok' -What 'service' -Detail ('started (pid ' + $newPid + ') on api port ' + $resolvedApiPort)
                $service = [ordered]@{ status = 'started'; pid = $newPid; detail = 'serve --detach' }
            } else {
                Add-Row -Status 'fail' -What 'service' -Detail $startError
                $service = [ordered]@{ status = 'unreachable'; pid = $null; detail = $startError }
            }
        }
    }
}

# ---------------------------------------------------------- 8. interfaces -----
# The three interfaces a ZCode software update can break. Only the first one can
# be verified (and repaired) offline.
$cdpOpen = $false
$buildInfo = ''
if ($discoveryAvailable) { $cdpOpen = Test-PortOpen -Port $resolvedCdpPort }
if ($cdpOpen) {
    try {
        $build = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $resolvedCdpPort + '/json/version') -TimeoutSec 2 -ErrorAction Stop
        $browser = [string]$build.Browser
        $agent = [string]$build.'User-Agent'
        if (-not [string]::IsNullOrWhiteSpace($browser) -or -not [string]::IsNullOrWhiteSpace($agent)) {
            $buildInfo = 'the ZCode build in view: Browser ' + $browser + ' / User-Agent ' + $agent
        } else {
            $buildInfo = 'the ZCode build in view could not be read from /json/version'
        }
    } catch {
        $buildInfo = 'the CDP port ' + $resolvedCdpPort + ' is open but /json/version did not answer: ' + $_.Exception.Message
    }
}

$launcherDetail = 'ZCode ' + $(if ($null -ne $zcode) { [string]$zcode.Path + ' (resolved by ' + [string]$zcode.ResolvedBy + ')' } else { 'was not resolved' })
$launcherDetail = $launcherDetail + '; shortcuts: ' + @($shortcutPaths).Count + ' ours in ' + $shortcutDirText + '; cdp port ' + $resolvedCdpPort + ' ' + $(if ($cdpOpen) { 'is open' } else { 'is closed' })
$launcherDetail = $launcherDetail + '; api port ' + $resolvedApiPort + ' ' + $(if ($service.status -eq 'healthy' -or $service.status -eq 'restarted' -or $service.status -eq 'started') { 'is healthy (pid ' + $service.pid + ')' } elseif ($service.status -eq 'skipped') { 'was not checked (-NoService)' } else { 'is ' + $service.status })
$launcherDetail = $launcherDetail + '; repairable here with -SourceDir / -RestartService'
$launcherStatus = 'ok'
if (@(Get-RowStrings 'fail').Count -gt 0) { $launcherStatus = 'fail' }
elseif ($script:degraded) { $launcherStatus = 'warn' }
Add-Row -Status $launcherStatus -What 'launcher' -Detail $launcherDetail
[void]$interfaces.Add(@{ name = 'launcher'; status = $launcherStatus; detail = $launcherDetail })

$domStatus = 'info'
$domDetail = ''
if (-not $cdpOpen) {
    $domDetail = 'not verifiable offline: the CDP port ' + $resolvedCdpPort + ' is closed (ZCode does not run with it), so no renderer can be sampled here. Selector drift after a ZCode update needs a newer zcode-tarkov.'
} elseif ([string]::IsNullOrWhiteSpace($buildInfo) -or $buildInfo -like 'the CDP port*') {
    $domStatus = 'warn'
    $domDetail = 'not verifiable offline: ' + $buildInfo + '. Selector drift after a ZCode update needs a newer zcode-tarkov.'
} else {
    $domDetail = 'not verifiable offline: ' + $buildInfo + '. Selector drift after a ZCode update needs a newer zcode-tarkov.'
}
Add-Row -Status $domStatus -What 'dom-selectors' -Detail $domDetail
[void]$interfaces.Add(@{ name = 'dom-selectors'; status = $domStatus; detail = $domDetail })

$cssDetail = 'not verifiable offline: the palette and CSS variable names are fixed in zcode-tarkov ' + $version + '. If a ZCode update renames its CSS tokens, a newer zcode-tarkov is required.'
if (-not [string]::IsNullOrWhiteSpace($buildInfo) -and -not ($buildInfo -like 'the CDP port*')) { $cssDetail = $cssDetail + ' ' + $buildInfo + '.' }
Add-Row -Status 'info' -What 'css-tokens' -Detail $cssDetail
[void]$interfaces.Add(@{ name = 'css-tokens'; status = 'info'; detail = $cssDetail })

# ------------------------------------------------------------ 9. settings -----
# Written once, after the shortcuts, so the recorded list is accurate. Only the
# values repair.ps1 re-resolved are replaced; everything else is kept.
if ($settingsDirty) {
    $now = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    $settingsObject = [ordered]@{
        product         = 'zcode-tarkov'
        version         = $version
        installDir      = $InstallDir
        nodePath        = $nodePath
        cliPath         = $cliPath
        cdpPort         = $settingsCdpPort
        apiPort         = $settingsApiPort
        dataDir         = $recordedDataDir
        zcodeExe        = $settingsZcodeExe
        zcodeInstallDir = $settingsZcodeInstallDir
        zcodeResolvedBy = $settingsZcodeResolvedBy
        launcherKind    = $launcherKind
        shortcuts       = @($settingsShortcuts)
        installedAt     = $installedAt
        updatedAt       = $now
    }
    if ($DryRun) {
        Add-Row -Status 'ok' -What 'settings.json' -Detail ('dry run: would update ' + $settingsPath + ' (zcodeExe, nodePath, shortcuts)')
    } else {
        try {
            Write-SettingsFile -Path $settingsPath -Settings $settingsObject
            Add-Row -Status 'ok' -What 'settings.json' -Detail ($settingsPath + ' updated')
        } catch {
            Add-Row -Status 'fail' -What 'settings.json' -Detail ('cannot write ' + $settingsPath + ': ' + $_.Exception.Message)
        }
    }
} else {
    Add-Row -Status 'info' -What 'settings.json' -Detail 'nothing to rewrite; the recorded values are still valid'
}

# --------------------------------------------------- 10. autostart diagnosis --
# Reported, not written: install.ps1 owns the autostart entry. A missing entry
# only degrades the install when the service is being managed.
if ($NoService) {
    $autostart = [ordered]@{ status = 'skipped'; entryPath = $autostartEntry }
} elseif (Test-Path -LiteralPath $autostartEntry -PathType Leaf) {
    $content = $null
    try { $content = [System.IO.File]::ReadAllText($autostartEntry) } catch { $content = $null }
    if ($null -eq $content) {
        Add-Row -Status 'warn' -What 'autostart' -Detail ($autostartEntry + ' exists but could not be read')
        $autostart = [ordered]@{ status = 'unreadable'; entryPath = $autostartEntry }
        Add-Degraded
    } elseif (($content -match '(?i)ZCode Beautify') -or ($content -match '(?i)zcode-(tarkov|beautify)')) {
        Add-Row -Status 'ok' -What 'autostart' -Detail ($autostartEntry + ' is present')
        $autostart = [ordered]@{ status = 'present'; entryPath = $autostartEntry }
    } else {
        Add-Row -Status 'warn' -What 'autostart' -Detail ($autostartEntry + ' exists but does not look like the zcode-tarkov entry; not touched')
        $autostart = [ordered]@{ status = 'not-ours'; entryPath = $autostartEntry }
        Add-Degraded
    }
} else {
    Add-Row -Status 'warn' -What 'autostart' -Detail ($autostartEntry + ' is missing; the service does not come back after sign-in. repair.ps1 does not write it: re-run install.ps1')
    $autostart = [ordered]@{ status = 'absent'; entryPath = $autostartEntry }
    Add-Degraded
}

# ----------------------------------------------------------- 11. report -------
Complete-Repair
