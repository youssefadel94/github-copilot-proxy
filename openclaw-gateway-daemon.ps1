# OpenClaw Gateway Daemon
# Runs the gateway infinitely, auto-respawns on crash

$ErrorActionPreference = "Continue"

$port = 18789
$restartDelay = 3  # seconds to wait before respawning

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  OpenClaw Gateway Daemon" -ForegroundColor Cyan
Write-Host "  Port: $port" -ForegroundColor Cyan
Write-Host "  Press Ctrl+C to stop" -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Cyan

$crashCount = 0

while ($true) {
    $startTime = Get-Date
    $crashCount++
    
    Write-Host ""
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Starting gateway (attempt #$crashCount)..." -ForegroundColor Green
    
    try {
        openclaw gateway --port $port --verbose
        $exitCode = $LASTEXITCODE
    }
    catch {
        $exitCode = 1
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Exception: $_" -ForegroundColor Red
    }
    
    $runtime = (Get-Date) - $startTime
    
    Write-Host ""
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Gateway exited with code $exitCode after $($runtime.ToString('hh\:mm\:ss'))" -ForegroundColor Yellow
    
    # Reset crash count if it ran for more than 1 minute (stable)
    if ($runtime.TotalMinutes -gt 1) {
        $crashCount = 0
    }
    
    # Exponential backoff for rapid crashes (max 30 seconds)
    $delay = [Math]::Min($restartDelay * [Math]::Pow(2, [Math]::Min($crashCount - 1, 3)), 30)
    
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Respawning in $delay seconds..." -ForegroundColor Cyan
    Start-Sleep -Seconds $delay
}
