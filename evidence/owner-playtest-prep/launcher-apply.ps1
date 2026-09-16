$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# USER-LEVEL-ONLY launcher repair.
#
# Deliberately does NOT call `repair-launchers`: that command also targets the
# machine-wide Public Desktop and ProgramData Start Menu shortcuts, which need
# elevation and are out of scope. This script touches only paths owned by the
# current user, and never elevates.
#
# Everything it writes is reversible; launcher-revert.ps1 is emitted alongside.

$ev  = 'F:\WSL\workspace\zcode-tarkov\evidence\owner-playtest-prep'
$exe = 'C:\Program Files\ZCode\ZCode.exe'
$flag = ' --remote-debugging-port=9222'
$wsh = New-Object -ComObject WScript.Shell
$out = @()

$userSm   = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\ZCode.lnk'
$userDesk = Join-Path $env:USERPROFILE 'Desktop\ZCode.lnk'
$pubDesk  = Join-Path $env:PUBLIC 'Desktop\ZCode.lnk'
$pubSm    = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\ZCode.lnk'

$out += '=== USER-LEVEL LAUNCHER REPAIR ==='
$out += "flag: $($flag.Trim())"

# --- 1) user Start Menu shortcut ------------------------------------------------
if (Test-Path -LiteralPath $userSm) {
  $sc = $wsh.CreateShortcut($userSm)
  $before = [string]$sc.Arguments
  if ($before -notmatch 'remote-debugging-port') {
    $sc.Arguments = ($before.Trim() + $flag).Trim()
    $sc.Save()
    $out += "[1] user Start Menu  UPDATED"
  } else {
    $out += "[1] user Start Menu  already had the flag"
  }
  $out += "    before: '$before'"
  $out += "    after : '$([string]$wsh.CreateShortcut($userSm).Arguments)'"
} else {
  $out += '[1] user Start Menu  ABSENT (skipped)'
}

# --- 2) user Desktop shortcut ---------------------------------------------------
# The desktop icon the user sees comes from the machine-wide Public Desktop file,
# which cannot be modified without elevation. A same-named shortcut in the user's
# own Desktop folder shadows it in the merged desktop view, so the visible icon
# carries the flag without touching any machine-wide file.
$iconLoc = ''
if (Test-Path -LiteralPath $pubDesk) {
  $pub = $wsh.CreateShortcut($pubDesk)
  $iconLoc = [string]$pub.IconLocation
  if (-not $iconLoc) { $iconLoc = $exe + ',0' }
  $out += "[2] source icon location from machine-wide shortcut: '$iconLoc'"
}
$sc2 = $wsh.CreateShortcut($userDesk)
$deskBefore = if (Test-Path -LiteralPath $userDesk) { [string]$sc2.Arguments } else { '(absent)' }
$sc2.TargetPath = $exe
$sc2.WorkingDirectory = 'C:\Program Files\ZCode'
$sc2.Description = 'ZCode (Tarkov theme playtest)'
if ($iconLoc) { $sc2.IconLocation = $iconLoc }
$sc2.Arguments = $flag.Trim()
$sc2.Save()
$out += "[2] user Desktop      CREATED"
$out += "    before: $deskBefore"
$out += "    after : '$([string]$wsh.CreateShortcut($userDesk).Arguments)'"

# --- 3) HKCU handlers ----------------------------------------------------------
$keys = @(
  'HKCU:\Software\Classes\zcode\shell\open\command',
  'HKCU:\Software\Classes\Directory\shell\ZCode.OpenInZCode\command',
  'HKCU:\Software\Classes\Drive\shell\ZCode.OpenInZCode\command'
)
foreach ($k in $keys) {
  if (-not (Test-Path -LiteralPath $k)) { $out += "[3] $k  ABSENT (skipped)"; continue }
  $before = [string](Get-Item -LiteralPath $k).GetValue('')
  if ($before -notmatch 'remote-debugging-port') {
    # Insert straight after the executable token, preserving quoting and %1.
    $after = $before -replace '^(\s*("[^"]+"|\S+))', ('$1' + $flag)
    try {
      $sub = $k -replace '^HKCU:\\', ''
      $w = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($sub, $true)
      if (-not $w) { throw 'cannot open key for writing' }
      $w.SetValue('', $after, [Microsoft.Win32.RegistryValueKind]::String)
      $w.Close()
      $out += "[3] $k  UPDATED"
    } catch {
      $after = $before
      $out += "[3] $k  FAILED: $($_.Exception.Message)"
    }
  } else {
    $after = $before
    $out += "[3] $k  already had the flag"
  }
  $out += "    before: '$before'"
  $out += "    after : '$after'"
}

# --- 4) confirm the machine-wide files were NOT touched ------------------------
$out += ''
$out += '=== MACHINE-WIDE (must be unchanged) ==='
foreach ($p in @($pubDesk, $pubSm)) {
  if (Test-Path -LiteralPath $p) {
    $sc = $wsh.CreateShortcut($p)
    $out += ("{0}`n    args: '{1}'   (unmodified: {2})" -f $p, $sc.Arguments, (-not ([string]$sc.Arguments -match 'remote-debugging-port')))
  }
}

# --- 5) what does the user actually see on the desktop now? -------------------
$out += ''
$out += '=== MERGED DESKTOP VIEW (after) ==='
try {
  $desktop = (New-Object -ComObject Shell.Application).NameSpace(0)
  $icons = @($desktop.Items() | Where-Object { $_.Name -like '*ZCode*' })
  $out += ("ZCode-named desktop icons visible: {0}" -f $icons.Count)
  foreach ($i in $icons) { $out += ("    {0}  ->  {1}" -f $i.Name, $i.Path) }
  if ($icons.Count -eq 1 -and $icons[0].Path -eq $userDesk) {
    $out += 'RESULT: the single visible icon is the USER shortcut (flag present).'
  } elseif ($icons.Count -eq 1) {
    $out += 'RESULT: single icon is NOT the user shortcut -> shadowing did not apply.'
  } else {
    $out += 'RESULT: more than one icon -> duplicate icon risk.'
  }
} catch {
  $out += ("could not enumerate: {0}" -f $_.Exception.Message)
}

$text = ($out -join "`r`n") + "`r`n"
Set-Content -Path (Join-Path $ev 'launcher-after.txt') -Value $text -Encoding UTF8
Write-Host $text

# --- 6) emit a revert script ---------------------------------------------------
$revert = @"
# Reverts the user-level launcher repair performed by launcher-apply.ps1.
# User-level only; does not touch machine-wide files.
`$wsh = New-Object -ComObject WScript.Shell
`$userSm   = Join-Path `$env:APPDATA 'Microsoft\Windows\Start Menu\Programs\ZCode.lnk'
`$userDesk = Join-Path `$env:USERPROFILE 'Desktop\ZCode.lnk'

if (Test-Path -LiteralPath `$userSm) {
  `$sc = `$wsh.CreateShortcut(`$userSm)
  `$sc.Arguments = ([string]`$sc.Arguments -replace '\s*--remote-debugging-port=9222', '').Trim()
  `$sc.Save()
  Write-Host "reverted user Start Menu shortcut"
}
if (Test-Path -LiteralPath `$userDesk) {
  Remove-Item -LiteralPath `$userDesk -Force
  Write-Host "removed user Desktop shortcut"
}
foreach (`$k in @(
  'HKCU:\Software\Classes\zcode\shell\open\command',
  'HKCU:\Software\Classes\Directory\shell\ZCode.OpenInZCode\command',
  'HKCU:\Software\Classes\Drive\shell\ZCode.OpenInZCode\command'
)) {
  if (-not (Test-Path -LiteralPath `$k)) { continue }
  `$v = [string](Get-Item -LiteralPath `$k).GetValue('')
  if (`$v -match 'remote-debugging-port') {
    `$new = `$v -replace '\s*--remote-debugging-port=9222', ''
    `$sub = `$k -replace '^HKCU:\\', ''
    `$w = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(`$sub, `$true)
    `$w.SetValue('', `$new, [Microsoft.Win32.RegistryValueKind]::String)
    `$w.Close()
    Write-Host "reverted `$k"
  }
}
"@
Set-Content -Path (Join-Path $ev 'launcher-revert.ps1') -Value $revert -Encoding UTF8
Write-Host ''
Write-Host "revert script written: $ev\launcher-revert.ps1"
