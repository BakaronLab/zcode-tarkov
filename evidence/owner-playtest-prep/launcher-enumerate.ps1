$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Enumerate every ZCode launch entry that lives in a CURRENT-USER location, plus
# the machine-wide ones (for reporting only). Read-only.

Write-Host '=== user-level shortcut locations ==='
$userDirs = @(
  @{ label = 'user Desktop';      path = (Join-Path $env:USERPROFILE 'Desktop') },
  @{ label = 'user Start Menu';   path = (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs') },
  @{ label = 'taskbar pins';      path = (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar') },
  @{ label = 'start tiles';       path = (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs') },
  @{ label = 'user links folder';  path = (Join-Path $env:USERPROFILE 'Links') }
)

$wsh = New-Object -ComObject WScript.Shell
foreach ($d in $userDirs) {
  if (-not (Test-Path -LiteralPath $d.path)) { Write-Host ("  [{0}] absent: {1}" -f $d.label, $d.path); continue }
  $lnks = @(Get-ChildItem -LiteralPath $d.path -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -notlike '*\Programs\ZCode.lnk' -or $d.label -eq 'user Start Menu' })
  $hit = $false
  foreach ($l in $lnks) {
    try { $sc = $wsh.CreateShortcut($l.FullName) } catch { continue }
    if ([string]$sc.TargetPath -notlike '*ZCode.exe') { continue }
    $hit = $true
    $args = [string]$sc.Arguments
    Write-Host ("  [{0}] {1}" -f $d.label, $l.FullName)
    Write-Host ("      args: '{0}'   hasFlag: {1}" -f $args, ($args -match 'remote-debugging-port'))
  }
  if (-not $hit) { Write-Host ("  [{0}] no ZCode shortcut" -f $d.label) }
}

Write-Host ''
Write-Host '=== start-menu ZCode.lnk explicit check (the one repair-launchers targets) ==='
$sm = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\ZCode.lnk'
if (Test-Path -LiteralPath $sm) {
  $sc = $wsh.CreateShortcut($sm)
  Write-Host ("  path: {0}" -f $sm)
  Write-Host ("  target: {0}" -f $sc.TargetPath)
  Write-Host ("  args: '{0}'" -f $sc.Arguments)
} else { Write-Host '  ABSENT' }

Write-Host ''
Write-Host '=== machine-wide (reported, NOT to be modified) ==='
foreach ($p in @((Join-Path $env:PUBLIC 'Desktop\ZCode.lnk'), (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\ZCode.lnk'))) {
  if (Test-Path -LiteralPath $p) {
    $sc = $wsh.CreateShortcut($p)
    Write-Host ("  {0}" -f $p)
    Write-Host ("      args: '{0}'   hasFlag: {1}" -f $sc.Arguments, ([string]$sc.Arguments -match 'remote-debugging-port'))
  } else { Write-Host ("  absent: {0}" -f $p) }
}

Write-Host ''
Write-Host '=== HKCU handlers ==='
foreach ($k in @(
  'HKCU:\Software\Classes\zcode\shell\open\command',
  'HKCU:\Software\Classes\Directory\shell\ZCode.OpenInZCode\command',
  'HKCU:\Software\Classes\Drive\shell\ZCode.OpenInZCode\command'
)) {
  if (Test-Path -LiteralPath $k) {
    $v = [string](Get-Item -LiteralPath $k).GetValue('')
    Write-Host ("  {0}" -f $k)
    Write-Host ("      value: '{0}'   hasFlag: {1}" -f $v, ($v -match 'remote-debugging-port'))
  } else { Write-Host ("  absent: {0}" -f $k) }
}
