# Reverts the USER-LEVEL launcher repair performed for the zcode-tarkov playtest.
#
# User-level only. It does not touch, and never did touch, the machine-wide
# Public Desktop or ProgramData Start Menu shortcuts.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File launcher-revert.ps1

$wsh = New-Object -ComObject WScript.Shell
$userStartMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\ZCode.lnk'
$userDesktop   = Join-Path $env:USERPROFILE 'Desktop\ZCode Tarkov.lnk'

if (Test-Path -LiteralPath $userStartMenu) {
  $sc = $wsh.CreateShortcut($userStartMenu)
  $sc.Arguments = ([string]$sc.Arguments -replace '\s*--remote-debugging-port=9222', '').Trim()
  $sc.Save()
  Write-Host "reverted user Start Menu shortcut -> '$([string]$wsh.CreateShortcut($userStartMenu).Arguments)'"
}

if (Test-Path -LiteralPath $userDesktop) {
  Remove-Item -LiteralPath $userDesktop -Force
  Write-Host 'removed user Desktop shortcut "ZCode Tarkov.lnk"'
}

foreach ($k in @(
  'HKCU:\Software\Classes\zcode\shell\open\command',
  'HKCU:\Software\Classes\Directory\shell\ZCode.OpenInZCode\command',
  'HKCU:\Software\Classes\Drive\shell\ZCode.OpenInZCode\command'
)) {
  if (-not (Test-Path -LiteralPath $k)) { continue }
  $v = [string](Get-Item -LiteralPath $k).GetValue('')
  if ($v -match 'remote-debugging-port') {
    $new = $v -replace '\s*--remote-debugging-port=9222', ''
    $sub = $k -replace '^HKCU:\\', ''
    $w = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($sub, $true)
    if ($w) {
      $w.SetValue('', $new, [Microsoft.Win32.RegistryValueKind]::String)
      $w.Close()
      Write-Host "reverted $k"
    }
  }
}

Write-Host ''
Write-Host 'The machine-wide shortcuts were never modified and need no reverting.'
