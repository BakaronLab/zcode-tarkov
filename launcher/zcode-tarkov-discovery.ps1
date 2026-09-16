#Requires -Version 5.1
#
# zcode-tarkov-discovery.ps1
#
# Read-only ZCode discovery and local service probes, shared by install.ps1,
# repair.ps1 and the launcher. Dot-source it:
#
#   . "C:\path\to\zcode-tarkov-discovery.ps1"
#
# No side effects on load: nothing is written, created, started or stopped, and
# registry access is read-only.
#
# Exported functions
#   Find-ZcodeExe [-Cached <path>]      -> hashtable or $null
#     @{ Path = <exe>; InstallDir = <dir>; ResolvedBy = <id>; Candidates = @(..) }
#     ResolvedBy: settings-cache | param | env | registry-hkcu | registry-hklm |
#                 known-path | scan
#     Candidates lists every location that was probed, in probe order, so a
#     repair script can print where ZCode was looked for.
#
#   Test-PortOpen -Port <int> [-TimeoutMs 400]   -> $true / $false
#   Get-CdpIdentity -Port <int> [-TimeoutMs 700] -> parsed /json/version or $null
#   Get-ServiceHealth -ApiPort <int>             -> health object or $null
#
# Resolution order, first existing file wins:
#   1. -Cached                        (the zcodeExe recorded in settings.json)
#   2. %ZCODE_WINDOWS_APP_INSTALL_DIR%\ZCode.exe
#   3. HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\ZCode.exe
#   4. HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\ZCode.exe
#   5. C:\Program Files\ZCode\ZCode.exe,
#      %LOCALAPPDATA%\Programs\ZCode\ZCode.exe
#   6. bounded scan (depth 3) of C:\Program Files, %LOCALAPPDATA%\Programs and
#      %ProgramFiles(x86)%: immediate ZCode* children, then
#      <child>\ZCode.exe, <child>\current\ZCode.exe and
#      <child>\app-<version>\ZCode.exe. With several hits the highest
#      [version]-parsable directory name wins, otherwise the newest
#      LastWriteTimeUtc. The whole disk is never scanned.

function Find-ZcodeExe {
    [CmdletBinding()]
    param(
        [string]$Cached
    )

    $candidates = New-Object System.Collections.ArrayList

    # Returns the result hashtable when $Path is an existing file, else $null.
    # Runs in the caller's scope so Candidates is complete at the moment we stop.
    $accept = {
        param([string]$Path, [string]$ResolvedBy)
        if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
        $full = $Path
        try { $full = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path } catch { }
        return @{
            Path       = $full
            InstallDir = (Split-Path -Path $full -Parent)
            ResolvedBy = $ResolvedBy
            Candidates = @($candidates.ToArray())
        }
    }

    # 1. cached executable recorded in settings.json
    if (-not [string]::IsNullOrWhiteSpace($Cached)) {
        [void]$candidates.Add($Cached)
        $hit = & $accept $Cached 'settings-cache'
        if ($hit) { return $hit }
    }

    # 2. ZCode's own installer leaves this behind for exactly this purpose
    if (-not [string]::IsNullOrWhiteSpace($env:ZCODE_WINDOWS_APP_INSTALL_DIR)) {
        $probe = Join-Path $env:ZCODE_WINDOWS_APP_INSTALL_DIR 'ZCode.exe'
        [void]$candidates.Add($probe)
        $hit = & $accept $probe 'env'
        if ($hit) { return $hit }
    }

    # 3 + 4. App Paths (the documented per-hive location for "where is app X")
    $hives = @(
        @{ Key = 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\ZCode.exe'; By = 'registry-hkcu' },
        @{ Key = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\ZCode.exe'; By = 'registry-hklm' }
    )
    foreach ($hive in $hives) {
        $raw = $null
        try {
            $item = Get-Item -LiteralPath $hive.Key -ErrorAction Stop
            $raw = [string]$item.GetValue('')
        } catch {
            $raw = $null
        }
        if ([string]::IsNullOrWhiteSpace($raw)) { continue }
        # The value may be quoted and may carry arguments: keep the executable token.
        $token = ''
        if ($raw -match '^\s*"([^"]+)"') { $token = $Matches[1] } else { $token = ($raw.Trim() -split '\s+')[0] }
        if ([string]::IsNullOrWhiteSpace($token)) { continue }
        [void]$candidates.Add($token)
        $hit = & $accept $token $hive.By
        if ($hit) { return $hit }
    }

    # 5. the layouts ZCode is known to use
    $known = New-Object System.Collections.ArrayList
    [void]$known.Add('C:\Program Files\ZCode\ZCode.exe')
    if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        [void]$known.Add((Join-Path $env:LOCALAPPDATA 'Programs\ZCode\ZCode.exe'))
    }
    foreach ($probe in $known) {
        [void]$candidates.Add($probe)
        $hit = & $accept $probe 'known-path'
        if ($hit) { return $hit }
    }

    # 6. bounded scan. Depth per root: root (0) -> ZCode* child (1) ->
    #    app-<version> (2) -> ZCode.exe (3).
    $roots = New-Object System.Collections.ArrayList
    [void]$roots.Add('C:\Program Files')
    if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        [void]$roots.Add((Join-Path $env:LOCALAPPDATA 'Programs'))
    }
    if (-not [string]::IsNullOrWhiteSpace(${env:ProgramFiles(x86)})) {
        [void]$roots.Add(${env:ProgramFiles(x86)})
    }

    # Entries are hashtables: Exe (path), DirName (directly containing dir),
    # Written (LastWriteTimeUtc of that dir).
    $probed = New-Object System.Collections.ArrayList
    foreach ($root in $roots) {
        if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
        $children = @()
        try {
            $children = @(Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -like 'ZCode*' })
        } catch {
            $children = @()
        }
        foreach ($child in $children) {
            [void]$probed.Add(@{ Exe = (Join-Path $child.FullName 'ZCode.exe'); DirName = $child.Name; Written = $child.LastWriteTimeUtc })
            [void]$probed.Add(@{ Exe = (Join-Path $child.FullName 'current\ZCode.exe'); DirName = $child.Name; Written = $child.LastWriteTimeUtc })
            $versioned = @()
            try {
                $versioned = @(Get-ChildItem -LiteralPath $child.FullName -Directory -ErrorAction SilentlyContinue |
                    Where-Object { $_.Name -like 'app-*' })
            } catch {
                $versioned = @()
            }
            foreach ($vd in $versioned) {
                [void]$probed.Add(@{ Exe = (Join-Path $vd.FullName 'ZCode.exe'); DirName = $vd.Name; Written = $vd.LastWriteTimeUtc })
            }
        }
    }

    $hits = New-Object System.Collections.ArrayList
    foreach ($entry in $probed) {
        [void]$candidates.Add($entry.Exe)
        if (Test-Path -LiteralPath $entry.Exe -PathType Leaf) { [void]$hits.Add($entry) }
    }
    if ($hits.Count -eq 0) { return $null }

    # Highest parsable version directory wins; without any, the newest one does.
    $best = $null
    $bestVersion = $null
    foreach ($hit in $hits) {
        $name = [string]$hit.DirName
        if ($name -like 'app-*') { $name = $name.Substring(4) }
        $v = [version]::Empty
        if ([version]::TryParse($name, [ref]$v)) {
            if (($null -eq $bestVersion) -or ($v -gt $bestVersion)) {
                $bestVersion = $v
                $best = $hit
            }
        }
    }
    if ($null -eq $best) {
        $best = $hits[0]
        foreach ($hit in $hits) {
            if ([datetime]$hit.Written -gt [datetime]$best.Written) { $best = $hit }
        }
    }

    $hitPath = [string]$best.Exe
    try { $hitPath = (Resolve-Path -LiteralPath $hitPath -ErrorAction Stop).Path } catch { }
    return @{
        Path       = $hitPath
        InstallDir = (Split-Path -Path $hitPath -Parent)
        ResolvedBy = 'scan'
        Candidates = @($candidates.ToArray())
    }
}

function Test-PortOpen {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][int]$Port,
        [int]$TimeoutMs = 400
    )

    $client = $null
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $async = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) { return $false }
        $client.EndConnect($async)
        return $true
    } catch {
        return $false
    } finally {
        if ($null -ne $client) {
            try { $client.Close() } catch { }
        }
    }
}

function Get-CdpIdentity {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][int]$Port,
        [int]$TimeoutMs = 700
    )

    # GET http://127.0.0.1:<Port>/json/version and return the parsed object only
    # when the listener really is a Chromium/Electron DevTools endpoint:
    #   - the body parses as JSON,
    #   - it carries webSocketDebuggerUrl (the /json/version shape), and
    #   - Browser matches Chrome, Electron or ZCode.
    # Anything else on the port (a plain TCP listener, a different HTTP API, an
    # error page) returns $null: an open port alone proves nothing, and 9222 is
    # also Chromium's standard debug port. Reading /json/version is a plain HTTP
    # GET without a WebSocket; it changes nothing.
    if ($Port -lt 1 -or $Port -gt 65535) { return $null }
    if ($TimeoutMs -lt 100) { $TimeoutMs = 100 }
    $text = ''
    $response = $null
    try {
        $request = [System.Net.WebRequest]::Create(('http://127.0.0.1:{0}/json/version' -f $Port))
        $request.Method = 'GET'
        $request.Timeout = $TimeoutMs
        $request.ReadWriteTimeout = $TimeoutMs
        $response = $request.GetResponse()
        $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
        try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() }
    } catch {
        return $null
    } finally {
        if ($null -ne $response) {
            try { $response.Close() } catch { }
        }
    }
    $parsed = $null
    try { $parsed = $text | ConvertFrom-Json -ErrorAction Stop } catch { return $null }
    if ($null -eq $parsed) { return $null }
    $socket = [string]$parsed.webSocketDebuggerUrl
    $browser = [string]$parsed.Browser
    if ([string]::IsNullOrWhiteSpace($socket)) { return $null }
    if ($browser -notmatch '(?i)(Chrome|Electron|ZCode)') { return $null }
    return $parsed
}

function Get-ServiceHealth {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][int]$ApiPort
    )

    # The resident service answers GET /api/health with
    # {"ok":true,"service":"zcode-beautify","pid":<n>}. Anything else on that
    # port is not ours and must not be treated as a healthy service.
    try {
        $health = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/api/health" -f $ApiPort) -TimeoutSec 2 -ErrorAction Stop
    } catch {
        return $null
    }
    if ($null -eq $health) { return $null }
    if ([string]$health.service -ne 'zcode-beautify') { return $null }
    return $health
}
