$ErrorActionPreference = 'SilentlyContinue'
$f = 'E:\AI\vibe-coding\shuffleMate\release\win-unpacked\resources\app.asar'
$t = 'E:\AI\vibe-coding\shuffleMate\release\win-unpacked\resources\app.asar.probe'
for ($i = 1; $i -le 20; $i++) {
  $ok = $true
  try { Move-Item -LiteralPath $f -Destination $t -ErrorAction Stop; Move-Item -LiteralPath $t -Destination $f -ErrorAction Stop } catch { $ok = $false }
  if (-not $ok) {
    "iter $i : LOCKED -> running RestartManager"
    & powershell -NoProfile -ExecutionPolicy Bypass -File 'E:\AI\vibe-coding\shuffleMate\_lock.ps1'
  } else {
    "iter $i : free"
  }
  Start-Sleep -Seconds 2
}
