# OpenClaw Gateway Daemon
# Runs the gateway infinitely, auto-respawns on crash
# Smart error detection for WhatsApp, DNS, connection issues

$ErrorActionPreference = "Continue"

$port = 18789
$restartDelay = 3  # seconds to wait before respawning
$logFile = "openclaw-gateway-daemon.log"

# Error patterns that trigger immediate restart
$criticalErrors = @(
    "Web connection closed.*status 408",
    "getaddrinfo ENOTFOUND",
    "ENOTFOUND web\.whatsapp\.com",
    "channel exited",
    "connection lost",
    "connection timeout",
    "Request Time-out",
    "WebSocket Error",
    "Fatal error",
    "cannot connect",
    "ECONNREFUSED",
    "ETIMEDOUT"
)

# Error patterns that trigger WhatsApp login
$whatsappLoginErrors = @(
    "WhatsApp.*auth",
    "WhatsApp.*login",
    "WhatsApp.*session",
    "WhatsApp.*QR",
    "device.*not.*registered",
    "session.*expired",
    "authentication.*failed"
)

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  OpenClaw Gateway Daemon (Smart)" -ForegroundColor Cyan
Write-Host "  Port: $port" -ForegroundColor Cyan
Write-Host "  Log: $logFile" -ForegroundColor Cyan
Write-Host "  Press Ctrl+C to stop" -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Cyan

function Log {
    param([string]$Message, [string]$Color = "White")
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $logMessage = "[$timestamp] $Message"
    Write-Host $logMessage -ForegroundColor $Color
    Add-Content -Path $logFile -Value $logMessage
}

function CheckForWhatsAppLogin {
    param([string]$Output, [string]$ErrorOutput)
    
    $allOutput = "$Output`n$ErrorOutput"
    
    foreach ($pattern in $whatsappLoginErrors) {
        if ($allOutput -match $pattern) {
            return $true, $pattern
        }
    }
    
    return $false, ""
}

function RunWhatsAppLogin {
    Log "WhatsApp login required - running login script..." "Yellow"
    
    $scriptPath = Join-Path $PSScriptRoot "openclaw-whatsapp-login.ps1"
    if (Test-Path $scriptPath) {
        try {
            Log "Executing: $scriptPath" "Cyan"
            & $scriptPath
            Log "WhatsApp login script completed successfully" "Green"
            return $true
        } catch {
            Log "WhatsApp login script failed: $_" "Red"
            return $false
        }
    } else {
        Log "WhatsApp login script not found at: $scriptPath" "Red"
        return $false
    }
}

function CheckForCriticalError {
    param([string]$Output, [string]$ErrorOutput)
    
    $allOutput = "$Output`n$ErrorOutput"
    
    foreach ($pattern in $criticalErrors) {
        if ($allOutput -match $pattern) {
            return $true, $pattern
        }
    }
    
    return $false, ""
}

$crashCount = 0
$stableRuntime = 60  # seconds - if runs longer than this, reset crash count

while ($true) {
    $startTime = Get-Date
    $crashCount++
    
    Log "" "Gray"
    Log "Starting gateway (attempt #$crashCount)..." "Green"
    
    $processOutput = @()
    $processError = @()
    $isCriticalError = $false
    
    try {
        # Start process and capture output in real-time
        $process = Start-Process -FilePath "openclaw" -ArgumentList "gateway --port $port --verbose" `
            -RedirectStandardOutput $env:TEMP\gateway_stdout.tmp `
            -RedirectStandardError $env:TEMP\gateway_stderr.tmp `
            -PassThru -NoNewWindow
        
        $processId = $process.Id
        Log "Gateway process started (PID: $processId)" "Green"
        
        # Monitor process and check for critical errors every 500ms
        $monitorInterval = 500  # milliseconds
        $lastCheckTime = Get-Date
        
        while (!$process.HasExited) {
            # Check for critical errors in output files
            if (Test-Path $env:TEMP\gateway_stdout.tmp) {
                $stdout = Get-Content $env:TEMP\gateway_stdout.tmp -Raw -ErrorAction SilentlyContinue
                $processOutput += $stdout.Split("`n")
            }
            
            if (Test-Path $env:TEMP\gateway_stderr.tmp) {
                $stderr = Get-Content $env:TEMP\gateway_stderr.tmp -Raw -ErrorAction SilentlyContinue
                $processError += $stderr.Split("`n")
            }
            
            # Check for WhatsApp login errors first
            $hasWhatsAppError, $whatsappPattern = CheckForWhatsAppLogin ($processOutput -join "`n") ($processError -join "`n")
            
            if ($hasWhatsAppError) {
                Log "WhatsApp error detected: $whatsappPattern" "Yellow"
                Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
                Start-Sleep -Milliseconds 500
                
                # Run WhatsApp login script
                $loginSuccess = RunWhatsAppLogin
                
                if ($loginSuccess) {
                    Log "Restarting gateway after WhatsApp login..." "Green"
                    $isCriticalError = $false  # Don't count this as critical for backoff
                } else {
                    Log "WhatsApp login failed, will retry..." "Red"
                    $isCriticalError = $true
                }
                
                break
            }
            
            # Check for critical error patterns
            $hasCriticalError, $matchedPattern = CheckForCriticalError ($processOutput -join "`n") ($processError -join "`n")
            
            if ($hasCriticalError) {
                Log "Critical error detected: $matchedPattern" "Red"
                Log "Terminating gateway process..." "Yellow"
                $isCriticalError = $true
                Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
                Start-Sleep -Milliseconds 500
                break
            }
            
            Start-Sleep -Milliseconds $monitorInterval
        }
        
        $exitCode = $process.ExitCode
    }
    catch {
        $exitCode = 1
        Log "Exception: $_" "Red"
        $isCriticalError = $true
    }
    
    # Read final output
    if (Test-Path $env:TEMP\gateway_stdout.tmp) {
        $finalStdout = Get-Content $env:TEMP\gateway_stdout.tmp -Raw -ErrorAction SilentlyContinue
        Remove-Item $env:TEMP\gateway_stdout.tmp -Force -ErrorAction SilentlyContinue
    }
    
    if (Test-Path $env:TEMP\gateway_stderr.tmp) {
        $finalStderr = Get-Content $env:TEMP\gateway_stderr.tmp -Raw -ErrorAction SilentlyContinue
        Remove-Item $env:TEMP\gateway_stderr.tmp -Force -ErrorAction SilentlyContinue
    }
    
    $runtime = (Get-Date) - $startTime
    
    Log "Gateway exited with code $exitCode after $($runtime.TotalSeconds)s" $(if ($isCriticalError) { "Red" } else { "Yellow" })
    
    # Reset crash count if stable run
    if ($runtime.TotalSeconds -gt $stableRuntime) {
        Log "Stable run detected, resetting crash counter" "Green"
        $crashCount = 0
    }
    
    # Exponential backoff for rapid crashes (max 30 seconds)
    # But reduce delay if critical error (start immediately)
    if ($isCriticalError -and $crashCount -gt 1) {
        $delay = 1  # Quick restart on critical errors after first crash
        Log "Critical error mode: quick restart" "Cyan"
    } else {
        $delay = [Math]::Min($restartDelay * [Math]::Pow(2, [Math]::Min($crashCount - 1, 3)), 30)
    }
    
    if ($delay -gt 0) {
        Log "Respawning in $delay seconds..." "Cyan"
        Start-Sleep -Seconds $delay
    }
}

