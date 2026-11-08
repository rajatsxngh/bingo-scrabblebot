# Keeps Bingo running: restarts it 2 s after any exit (crash, kill, bad token).
# Run it from the frozen tournament copy, not the folder you're editing:
#   powershell -ExecutionPolicy Bypass -File scripts\live.ps1
# Stop it with Ctrl-C (twice: once for the bot, once for the loop).
Set-Location (Join-Path $PSScriptRoot "..")
while ($true) {
  Write-Host "[live] starting bot at $(Get-Date -Format HH:mm:ss)"
  node --import tsx src/bot/index.ts
  Write-Host "[live] bot exited with code $LASTEXITCODE at $(Get-Date -Format HH:mm:ss); restarting in 2 s"
  Start-Sleep -Seconds 2
}
