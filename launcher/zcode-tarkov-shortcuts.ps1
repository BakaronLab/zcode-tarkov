#Requires -Version 5.1
#
# zcode-tarkov-shortcuts.ps1
#
# Shared shortcut, official-launcher and process-identity helpers for the
# zcode-tarkov lifecycle scripts. Dot-source it:
#
#   . "C:\path\to\zcode-tarkov-shortcuts.ps1"
#
# install.ps1, repair.ps1 and uninstall.ps1 all load this file, so the three of
# them cannot drift on what our shortcut is, on what may be replaced, and on
# what may be removed.
#
# Loading has no side effects: nothing is written, created, started or stopped,
# and every registry access is a read until a caller explicitly asks to write.
#
# Exported functions
#   Get-ZctShortcutSpec -Kind vbs|powershell -InstallDir <dir> [-ZcodeExe <exe>]
#     -> @{ Kind; Target; Arguments; WorkingDirectory; IconLocation; Description }
#   Get-ZctLauncherShortcut -Path <lnk>
#     -> @{ Path; TargetPath; Arguments; WorkingDirectory; IconLocation;
#           Description } or $null when the file does not exist / cannot be read
#   Test-ZctShortcutIsOurs -Shortcut <obj> -InstallDir <dir>
#     -> $true only when the target is wscript.exe with arguments naming
#        <InstallDir>\launcher\zcode-tarkov-launch.vbs, or powershell.exe with
#        arguments naming <InstallDir>\launcher\zcode-tarkov-launch.ps1.
#        A shortcut that merely carries our name is NOT ours.
#   Test-ZctShortcutAdoptable -Shortcut <obj> -InstallDir <dir>
#     -> $true when Test-ZctShortcutIsOurs is true, or when the target is a
#        ZCode.exe entry (the ad-hoc playtest launcher that used the same name).
#        This is the rule install.ps1 uses to decide whether a file called
#        "ZCode Tarkov.lnk" may be replaced; uninstall.ps1 never uses it to
#        delete something.
#   New-ZctLauncherShortcut -Path <lnk> -Kind vbs|powershell -InstallDir <dir>
#                           [-ZcodeExe <exe>] [-Force] [-DryRun]
#     -> @{ Status; Path; Kind; Target; Arguments; Before; After; Replaced; Message }
#        Status: created | updated | kept | refused | dry-run | failed
#        Refused means: the file exists, is not ours, and -Force was not given.
#   Remove-ZctOfficialFlag -Path <lnk> [-Ports <int[]>] [-DryRun]
#     -> @{ Status; Path; Before; After; Message }
#        Status: stripped | unchanged | skipped | absent | dry-run | failed
#        Strips one --remote-debugging-port token for one of the given ports and
#        nothing else. Only touches a shortcut whose target is ZCode.exe; never
#        deletes a file.
#   Get-ZctOfficialHandlerKeys
#     -> the three HKCU handler keys whose default value may carry the flag
#   Remove-ZctOfficialHandlerFlag -Key <HKCU path> [-Ports <int[]>] [-DryRun]
#     -> the same strip for a handler default value, additionally gated on the
#        value naming ZCode.exe; never deletes a key or a value
#   Remove-ZctDebugPortToken -Arguments <string> [-Ports <int[]>]
#     -> the argument string without the --remote-debugging-port token when it
#        names one of the given ports; a token for any other port, and a bare
#        flag without a value, are left alone
#   Test-ZctProcessIsOurs -ProcessId <n> -InstallDir <dir> [-CliPath <path>]
#                         [-RequireServe]
#     -> @{ ProcessId; Name; CommandLine; Ok; Reason } (read-only)
#   Get-ZctInstallProcesses -InstallDir <dir> [-CliPath <path>]
#                           [-ExcludeProcessId <n>]
#     -> @{ Ok; Reason; Processes } where Processes is @( @{ ProcessId; Name;
#        CommandLine } ) for node.exe processes that run this CLI with a serve
#        or watch token (read-only). Ok = $false means the process list could
#        not be read at all, so the caller reports "could not inspect", never
#        "none found".
#   Test-ZctIsReparsePoint -Path <p>   -> $true for a junction/symlink
#   Get-ZctTreeFiles -Root <dir>       -> @{ Files; Skipped } without descending
#                                         into a reparse point
#   Remove-ZctTreeSafe -Root <dir>     -> paths left behind (reparse points are
#                                         never followed, so their targets are
#                                         never touched)
#
# ASCII only (comments included), no BOM, Windows PowerShell 5.1 compatible.
#
# Safety rules encoded here
#   - read before write: every writer reports Before and After
#   - a shortcut is only replaced when it is provably ours, or with -Force
#   - the official-launcher helpers never delete anything: they remove one
#     argument token, and only when the entry is provably a ZCode entry and the
#     token names a port this project could have injected (an explicit -Ports
#     set; a token naming any other port is left alone)
#   - the process helpers only look: stopping a process stays in the caller and
#     always requires an identity match first
#   - the tree helpers never descend into a directory reparse point: Windows
#     PowerShell 5.1 follows those in Get-ChildItem -Recurse and Remove-Item
#     -Recurse, which would read or delete the link target

# ------------------------------------------------------------------ specs ----

# What the "ZCode Tarkov" shortcut must point at for a given launcher kind.
# The two kinds differ only in the trampoline: vbs runs the .vbs through
# wscript.exe (no console window), powershell runs the .ps1 with a hidden window
# (used when VBScript is unavailable or disabled on the machine).
function Get-ZctShortcutSpec {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][ValidateSet('vbs', 'powershell')][string]$Kind,
        [Parameter(Mandatory = $true)][string]$InstallDir,
        [string]$ZcodeExe
    )

    $install = $InstallDir
    if (-not [string]::IsNullOrWhiteSpace($install)) {
        try { $install = [System.IO.Path]::GetFullPath($install) } catch { }
        if ($install.EndsWith('\') -and $install.Length -gt 3) { $install = $install.TrimEnd('\') }
    }

    if ($Kind -eq 'powershell') {
        $target = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $install 'launcher\zcode-tarkov-launch.ps1') + '"'
    } else {
        $target = Join-Path $env:SystemRoot 'System32\wscript.exe'
        $arguments = '"' + (Join-Path $install 'launcher\zcode-tarkov-launch.vbs') + '"'
    }

    $icon = ''
    if (-not [string]::IsNullOrWhiteSpace($ZcodeExe)) { $icon = $ZcodeExe + ',0' }

    return [pscustomobject]@{
        Kind             = $Kind
        Target           = $target
        Arguments        = $arguments
        WorkingDirectory = $install
        IconLocation     = $icon
        Description      = 'ZCode with the Tarkov theme (zcode-tarkov launcher)'
    }
}

# ----------------------------------------------------------------- readers ----

# The shortcut as it is on disk, or $null. A missing file is not an error: the
# callers use that to distinguish "create" from "update".
function Get-ZctLauncherShortcut {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path
    )

    if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }

    $shell = $null
    try { $shell = New-Object -ComObject WScript.Shell } catch { return $null }
    if ($null -eq $shell) { return $null }

    $link = $null
    try { $link = $shell.CreateShortcut($Path) } catch { return $null }
    if ($null -eq $link) { return $null }

    return [pscustomobject]@{
        Path             = $Path
        TargetPath       = [string]$link.TargetPath
        Arguments        = [string]$link.Arguments
        WorkingDirectory = [string]$link.WorkingDirectory
        IconLocation     = [string]$link.IconLocation
        Description      = [string]$link.Description
    }
}

# ------------------------------------------------------------- ownership -----

function Test-ZctShortcutIsOurs {
    [CmdletBinding()]
    param(
        $Shortcut,
        [string]$InstallDir
    )

    if ($null -eq $Shortcut) { return $false }
    if ([string]::IsNullOrWhiteSpace($InstallDir)) { return $false }

    $target = [string]$Shortcut.TargetPath
    $arguments = [string]$Shortcut.Arguments
    if ([string]::IsNullOrWhiteSpace($target)) { return $false }
    if ([string]::IsNullOrWhiteSpace($arguments)) { return $false }

    $install = $InstallDir
    if ($install.EndsWith('\') -and $install.Length -gt 3) { $install = $install.TrimEnd('\') }

    $leaf = $target
    try { $leaf = [System.IO.Path]::GetFileName($target) } catch { }

    if ($leaf -ieq 'wscript.exe') {
        $expected = Join-Path $install 'launcher\zcode-tarkov-launch.vbs'
        return ($arguments.IndexOf($expected, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
    }
    if ($leaf -ieq 'powershell.exe') {
        $expected = Join-Path $install 'launcher\zcode-tarkov-launch.ps1'
        return ($arguments.IndexOf($expected, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
    }
    return $false
}

# Slightly wider than Test-ZctShortcutIsOurs: a shortcut named "ZCode Tarkov.lnk"
# that points straight at ZCode.exe was created by the project's playtest
# tooling under the same name, so install.ps1 may replace it without -Force.
# uninstall.ps1 reports that case separately and never deletes on this rule
# alone without saying so.
function Test-ZctShortcutAdoptable {
    [CmdletBinding()]
    param(
        $Shortcut,
        [string]$InstallDir
    )

    if (Test-ZctShortcutIsOurs -Shortcut $Shortcut -InstallDir $InstallDir) { return $true }
    if ($null -eq $Shortcut) { return $false }
    $target = [string]$Shortcut.TargetPath
    if ([string]::IsNullOrWhiteSpace($target)) { return $false }
    $leaf = $target
    try { $leaf = [System.IO.Path]::GetFileName($target) } catch { }
    return ($leaf -ieq 'ZCode.exe')
}

# ---------------------------------------------------------------- writers ----

function New-ZctLauncherShortcut {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][ValidateSet('vbs', 'powershell')][string]$Kind,
        [Parameter(Mandatory = $true)][string]$InstallDir,
        [string]$ZcodeExe,
        [switch]$Force,
        [switch]$DryRun
    )

    $spec = Get-ZctShortcutSpec -Kind $Kind -InstallDir $InstallDir -ZcodeExe $ZcodeExe

    $before = @{
        Exists           = $false
        Target           = $null
        Arguments        = $null
        WorkingDirectory = $null
        IconLocation     = $null
        Description      = $null
    }
    $after = @{
        Target           = $spec.Target
        Arguments        = $spec.Arguments
        WorkingDirectory = $spec.WorkingDirectory
        IconLocation     = $spec.IconLocation
        Description      = $spec.Description
    }

    $result = [ordered]@{
        Status    = 'failed'
        Path      = $Path
        Kind      = $Kind
        Target    = $spec.Target
        Arguments = $spec.Arguments
        Before    = $before
        After     = $after
        Replaced  = $false
        Message   = ''
    }

    if ([string]::IsNullOrWhiteSpace($Path)) {
        $result.Message = 'no shortcut path was given'
        return $result
    }
    $dir = Split-Path -Path $Path -Parent
    if ([string]::IsNullOrWhiteSpace($dir) -or -not (Test-Path -LiteralPath $dir -PathType Container)) {
        $result.Status = 'refused'
        $result.Message = ('the directory does not exist: ' + $dir)
        return $result
    }

    $existing = Get-ZctLauncherShortcut -Path $Path
    if ($null -eq $existing -and (Test-Path -LiteralPath $Path)) {
        $result.Message = 'the existing shortcut exists but could not be read'
        return $result
    }
    if ($null -ne $existing) {
        $before.Exists = $true
        $before.Target = $existing.TargetPath
        $before.Arguments = $existing.Arguments
        $before.WorkingDirectory = $existing.WorkingDirectory
        $before.IconLocation = $existing.IconLocation
        $before.Description = $existing.Description
    }

    $state = 'created'
    if ($null -ne $existing) {
        if (-not (Test-ZctShortcutAdoptable -Shortcut $existing -InstallDir $InstallDir)) {
            if (-not $Force) {
                $result.Status = 'refused'
                $result.Message = ('the existing shortcut is not a zcode-tarkov launcher (target: ' + [string]$existing.TargetPath + ')')
                return $result
            }
            $result.Replaced = $true
            $state = 'updated'
        } else {
            $state = 'updated'
            $same = ($existing.TargetPath -eq $spec.Target) -and
                ($existing.Arguments -eq $spec.Arguments) -and
                ($existing.WorkingDirectory -eq $spec.WorkingDirectory) -and
                ($existing.IconLocation -eq $spec.IconLocation) -and
                ($existing.Description -eq $spec.Description)
            if ($same) { $state = 'kept' }
        }
    }

    if ($DryRun) {
        $result.Status = 'dry-run'
        $result.Message = ('dry run: the shortcut state would become ' + $state)
        return $result
    }
    if ($state -eq 'kept') {
        $result.Status = 'kept'
        return $result
    }

    try {
        $shell = New-Object -ComObject WScript.Shell
        $link = $shell.CreateShortcut($Path)
        $link.TargetPath = $spec.Target
        $link.Arguments = $spec.Arguments
        $link.WorkingDirectory = $spec.WorkingDirectory
        $link.Description = $spec.Description
        if (-not [string]::IsNullOrWhiteSpace($spec.IconLocation)) { $link.IconLocation = $spec.IconLocation }
        $link.Save()
        $result.Status = $state
    } catch {
        $result.Status = 'failed'
        $result.Message = $_.Exception.Message
    }
    return $result
}

# ------------------------------------------------- official launcher repair ---

# The one argument token the project may have injected into an official ZCode
# launcher entry, and only for the ports it could have used: the configured cdp
# port and the historical default. Handled forms:
#   --remote-debugging-port=9222
#   --remote-debugging-port 9222
# A token that names any other port, or a bare flag without a value, is left
# alone: it did not come from this project.
function Remove-ZctDebugPortToken {
    [CmdletBinding()]
    param(
        [string]$Arguments,
        [int[]]$Ports = @(9222)
    )

    if ([string]::IsNullOrWhiteSpace($Arguments)) { return '' }
    $allowed = New-Object System.Collections.ArrayList
    foreach ($candidate in @($Ports)) {
        if ($candidate -ge 1 -and $candidate -le 65535) {
            $value = [string]$candidate
            if (-not $allowed.Contains($value)) { [void]$allowed.Add($value) }
        }
    }
    $cleaned = $Arguments
    foreach ($value in $allowed) {
        $escaped = [regex]::Escape($value)
        # The lookahead keeps a longer number (92222) or a longer option intact.
        $cleaned = $cleaned -replace ('(?i)\s*--remote-debugging-port=' + $escaped + '(?=\s|$)'), ''
        $cleaned = $cleaned -replace ('(?i)\s*--remote-debugging-port\s+' + $escaped + '(?=\s|$)'), ''
    }
    return $cleaned.Trim()
}

function Remove-ZctOfficialFlag {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [int[]]$Ports = @(9222),
        [switch]$DryRun
    )

    $result = [ordered]@{
        Status  = 'absent'
        Path    = $Path
        Before  = $null
        After   = $null
        Message = 'the shortcut does not exist'
    }

    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $result }

    $link = Get-ZctLauncherShortcut -Path $Path
    if ($null -eq $link) {
        $result.Status = 'failed'
        $result.Message = 'the shortcut could not be read'
        return $result
    }

    $leaf = [string]$link.TargetPath
    try { $leaf = [System.IO.Path]::GetFileName([string]$link.TargetPath) } catch { }
    if ($leaf -ine 'ZCode.exe') {
        $result.Status = 'skipped'
        $result.Before = $link.Arguments
        $result.After = $link.Arguments
        $result.Message = ('the target is not ZCode.exe (' + [string]$link.TargetPath + '); not touched')
        return $result
    }

    $before = [string]$link.Arguments
    $after = Remove-ZctDebugPortToken -Arguments $before -Ports $Ports
    $result.Before = $before
    $result.After = $after

    if ($after -eq $before) {
        $result.Status = 'unchanged'
        $result.Message = 'no removable --remote-debugging-port token is present (only ' + (@($Ports) -join ', ') + ' are stripped)'
        return $result
    }
    if ($DryRun) {
        $result.Status = 'dry-run'
        $result.Message = 'dry run: the token would be removed'
        return $result
    }

    try {
        $shell = New-Object -ComObject WScript.Shell
        $write = $shell.CreateShortcut($Path)
        $write.Arguments = $after
        $write.Save()
        $result.Status = 'stripped'
        $result.Message = 'the --remote-debugging-port token was removed'
    } catch {
        $result.Status = 'failed'
        $result.Message = $_.Exception.Message
    }
    return $result
}

# The three HKCU handler keys the playtest tooling injected the flag into. They
# belong to ZCode (its own file-association handlers); we only ever remove the
# flag we may have added, never the key.
function Get-ZctOfficialHandlerKeys {
    [CmdletBinding()]
    param()

    return @(
        'HKCU:\Software\Classes\zcode\shell\open\command',
        'HKCU:\Software\Classes\Directory\shell\ZCode.OpenInZCode\command',
        'HKCU:\Software\Classes\Drive\shell\ZCode.OpenInZCode\command'
    )
}

function Remove-ZctOfficialHandlerFlag {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Key,
        [int[]]$Ports = @(9222),
        [switch]$DryRun
    )

    $result = [ordered]@{
        Status  = 'skipped'
        Key     = $Key
        Before  = $null
        After   = $null
        Message = ''
    }

    $known = @(Get-ZctOfficialHandlerKeys)
    if (-not ($known -contains $Key)) {
        $result.Message = 'not one of the zcode handler keys; refused'
        return $result
    }
    if (-not (Test-Path -LiteralPath $Key)) {
        $result.Status = 'absent'
        $result.Message = 'the key does not exist'
        return $result
    }

    $value = $null
    try {
        $item = Get-Item -LiteralPath $Key -ErrorAction Stop
        $value = [string]$item.GetValue('')
    } catch {
        $result.Status = 'failed'
        $result.Message = ('the default value could not be read: ' + $_.Exception.Message)
        return $result
    }

    $result.Before = $value
    $result.After = $value
    if ([string]::IsNullOrWhiteSpace($value)) {
        $result.Status = 'empty'
        $result.Message = 'the default value is empty'
        return $result
    }
    if ($value -notmatch '(?i)ZCode\.exe') {
        $result.Status = 'skipped'
        $result.Message = 'the value does not name ZCode.exe; not touched'
        return $result
    }
    if ($value -notmatch '(?i)--remote-debugging-port') {
        $result.Status = 'unchanged'
        $result.Message = 'no removable --remote-debugging-port token is present (only ' + (@($Ports) -join ', ') + ' are stripped)'
        return $result
    }

    $after = Remove-ZctDebugPortToken -Arguments $value -Ports $Ports
    $result.After = $after
    if ($after -eq $value) {
        $result.Status = 'unchanged'
        $result.Message = 'no removable --remote-debugging-port token is present (only ' + (@($Ports) -join ', ') + ' are stripped)'
        return $result
    }
    if ($DryRun) {
        $result.Status = 'dry-run'
        $result.Message = 'dry run: the token would be removed'
        return $result
    }

    try {
        $sub = $Key -replace '^HKCU:\\', ''
        $write = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($sub, $true)
        if ($null -eq $write) { throw 'the key could not be opened for writing' }
        try {
            $write.SetValue('', $after, [Microsoft.Win32.RegistryValueKind]::String)
        } finally {
            $write.Close()
        }
        $result.Status = 'stripped'
        $result.Message = 'the --remote-debugging-port token was removed'
    } catch {
        $result.Status = 'failed'
        $result.Message = $_.Exception.Message
    }
    return $result
}

# --------------------------------------------------------- process identity ---

# The one process that may be stopped as "our service": a node.exe whose command
# line runs our CLI bundle (the recorded cliPath; living under the install
# directory alone is not enough), and - for the resident service - carries the
# "serve" token. Read-only: stopping stays in the caller, after this returned
# Ok = $true.
function Test-ZctProcessIsOurs {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [Parameter(Mandatory = $true)][string]$InstallDir,
        [string]$CliPath,
        [switch]$RequireServe
    )

    $info = [ordered]@{
        ProcessId   = $ProcessId
        Name        = $null
        CommandLine = $null
        Ok          = $false
        Reason      = ''
    }

    if ($ProcessId -le 0) {
        $info.Reason = 'no valid process id'
        return $info
    }
    if ([string]::IsNullOrWhiteSpace($InstallDir) -and [string]::IsNullOrWhiteSpace($CliPath)) {
        $info.Reason = 'neither the install directory nor the CLI path is known'
        return $info
    }

    $process = $null
    try {
        $process = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId=' + $ProcessId) -ErrorAction Stop | Select-Object -First 1
    } catch {
        $info.Reason = ('the process could not be inspected: ' + $_.Exception.Message)
        return $info
    }
    if ($null -eq $process) {
        $info.Reason = 'no such process'
        return $info
    }

    $info.Name = [string]$process.Name
    $info.CommandLine = [string]$process.CommandLine

    if ($info.Name -ine 'node.exe') {
        $info.Reason = ('the process name is "' + $info.Name + '", not node.exe')
        return $info
    }
    if ([string]::IsNullOrWhiteSpace($info.CommandLine)) {
        $info.Reason = 'the command line could not be read'
        return $info
    }

    # H5: the CLI bundle is the identity. Only a caller that does not know it
    # may fall back to the install directory string.
    $matchesInstall = $false
    if (-not [string]::IsNullOrWhiteSpace($CliPath)) {
        $matchesInstall = $info.CommandLine.IndexOf($CliPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    } elseif (-not [string]::IsNullOrWhiteSpace($InstallDir)) {
        $matchesInstall = $info.CommandLine.IndexOf($InstallDir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    }
    if (-not $matchesInstall) {
        $info.Reason = 'the command line does not reference this install''s CLI bundle'
        return $info
    }

    if ($RequireServe) {
        if ($info.CommandLine -notmatch '(?i)(^|[\s"])serve([\s"]|$)') {
            $info.Reason = 'the command line does not run the "serve" command'
            return $info
        }
    }

    $info.Ok = $true
    return $info
}

# Every node.exe that runs this install's CLI with a long-lived command token
# (serve or watch). Read-only; the caller decides what to do with each one and
# reports the command line first. Returns a status object:
#   @{ Ok = <bool>; Reason = <string>; Processes = @( @{ ProcessId; Name; CommandLine } ) }
# Ok = $false means the process list could not be read (WMI/CIM unavailable):
# the caller must then report "could not inspect", never "none found".
function Get-ZctInstallProcesses {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$InstallDir,
        [string]$CliPath,
        [int]$ExcludeProcessId = 0
    )

    $status = [ordered]@{
        Ok        = $false
        Reason    = ''
        Processes = @()
    }
    if ([string]::IsNullOrWhiteSpace($InstallDir) -and [string]::IsNullOrWhiteSpace($CliPath)) {
        $status.Reason = 'neither the install directory nor the CLI path is known'
        return $status
    }

    $processes = @()
    try {
        $processes = @(Get-CimInstance -ClassName Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop)
    } catch {
        $status.Reason = 'could not enumerate processes (WMI/CIM unavailable): ' + $_.Exception.Message
        return $status
    }

    $out = New-Object System.Collections.ArrayList
    foreach ($process in $processes) {
        if ($process.ProcessId -eq $ExcludeProcessId) { continue }
        $commandLine = [string]$process.CommandLine
        if ([string]::IsNullOrWhiteSpace($commandLine)) { continue }
        $hit = $false
        if (-not [string]::IsNullOrWhiteSpace($CliPath)) {
            $hit = $commandLine.IndexOf($CliPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
        } elseif (-not [string]::IsNullOrWhiteSpace($InstallDir)) {
            $hit = $commandLine.IndexOf($InstallDir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
        }
        if (-not $hit) { continue }
        # H5: a leftover is only ours when it runs our CLI *and* carries one of
        # the long-lived command tokens.
        $runsServe = ($commandLine -match '(?i)(^|[\s"])serve([\s"]|$)')
        $runsWatch = ($commandLine -match '(?i)(^|[\s"])watch([\s"]|$)')
        if (-not ($runsServe -or $runsWatch)) { continue }
        [void]$out.Add(@{
            ProcessId   = [int]$process.ProcessId
            Name        = [string]$process.Name
            CommandLine = $commandLine
        })
    }
    $status.Ok = $true
    $status.Processes = @($out.ToArray())
    return $status
}

# ------------------------------------------------------ reparse-point safety --
# Windows PowerShell 5.1 follows directory reparse points (junctions and
# symlinks) in Get-ChildItem -Recurse and Remove-Item -Recurse, so a recursive
# enumeration can read - and a recursive delete can destroy - the link target
# instead of the link. The helpers below never descend into one.

# $true when the path exists and is a reparse point (junction/symlink).
function Test-ZctIsReparsePoint {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    $item = $null
    try { $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop } catch { return $false }
    if ($null -eq $item) { return $false }
    return (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
}

# Files below $Root, depth first, without descending into a reparse point.
# -> @{ Files = @(<FileInfo>); Skipped = @(<path>) }
# Skipped names every reparse point that was found and not followed, so the
# caller can report it instead of silently ignoring it.
function Get-ZctTreeFiles {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Root)

    $files = New-Object System.Collections.ArrayList
    $skipped = New-Object System.Collections.ArrayList
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
        return @{ Files = @(); Skipped = @() }
    }
    $stack = New-Object System.Collections.Stack
    $stack.Push($Root)
    while ($stack.Count -gt 0) {
        $dir = [string]$stack.Pop()
        $children = @()
        try { $children = @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue) } catch { $children = @() }
        foreach ($child in $children) {
            if (($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                [void]$skipped.Add([string]$child.FullName)
                continue
            }
            if ($child.PSIsContainer) {
                $stack.Push([string]$child.FullName)
                continue
            }
            [void]$files.Add($child)
        }
    }
    return @{ Files = @($files.ToArray()); Skipped = @($skipped.ToArray()) }
}

# Removes a tree without ever following a reparse point: files first, then the
# directories bottom-up, while a reparse point stays in place (its target is
# never touched). Returns the paths that were left behind: the reparse points,
# and any directory that could not be removed because one of them is inside.
function Remove-ZctTreeSafe {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Root)

    $left = New-Object System.Collections.ArrayList
    $dirs = New-Object System.Collections.ArrayList
    $files = New-Object System.Collections.ArrayList
    $stack = New-Object System.Collections.Stack
    $stack.Push($Root)
    while ($stack.Count -gt 0) {
        $dir = [string]$stack.Pop()
        [void]$dirs.Add($dir)
        $children = @()
        try { $children = @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue) } catch { $children = @() }
        foreach ($child in $children) {
            if (($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                [void]$left.Add([string]$child.FullName)
                continue
            }
            if ($child.PSIsContainer) { $stack.Push([string]$child.FullName) } else { [void]$files.Add([string]$child.FullName) }
        }
    }
    foreach ($file in $files) {
        try { Remove-Item -LiteralPath $file -Force -ErrorAction Stop } catch { [void]$left.Add($file) }
    }
    # $dirs holds every directory before its children (depth first), so the
    # reversed list removes the deepest directory first.
    $ordered = @($dirs.ToArray())
    [array]::Reverse($ordered)
    foreach ($dir in $ordered) {
        try { Remove-Item -LiteralPath $dir -Force -ErrorAction Stop } catch { [void]$left.Add($dir) }
    }
    return @($left.ToArray())
}
