<#
.SYNOPSIS
    Development server with live-reload. Watches for file changes in src/,
    rebuilds TypeScript, copies public assets, and restarts the server.

.DESCRIPTION
    Uses Node --watch to monitor source files. On any change the process
    is automatically restarted. The script first does a full build so that
    dist/ is up-to-date, then launches with --watch.

.EXAMPLE
    .\dev.ps1
    .\dev.ps1 -Verbose
#>
param(
    [switch]$Verbose
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "`n=== github-copilot-proxy  |  dev mode ===" -ForegroundColor Cyan
Write-Host "Watching src/ for changes - auto-rebuild and restart`n" -ForegroundColor DarkGray

# ── 1. Initial build ────────────────────────────────────────────────
Write-Host "[1/2] Building project..." -ForegroundColor Yellow
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "Build failed. Fix errors above and re-run." -ForegroundColor Red
    exit 1
}
Write-Host "[1/2] Build OK`n" -ForegroundColor Green

# ── 2. Start with --watch ───────────────────────────────────────────
#   Node >= 22 has stable --watch support.  We watch the src/ directory
#   so that any .ts / .html change triggers a restart.  The before-restart
#   hook re-runs the build so dist/ stays current.
Write-Host "[2/2] Starting server in watch mode...`n" -ForegroundColor Yellow

$env:NODE_ENV   = "development"
if ($Verbose) { $env:LOG_LEVEL = "debug" }

# We use a small wrapper: on each restart we rebuild then launch.
# Node's --watch-path lets us scope what triggers restarts.
$watchPaths = @(
    "--watch-path=src"
)

# Build the command
# --watch restarts the *entry* process on file change.
# We chain: build first, then start from dist/.
$nodeBin = "node"
$args = @(
    "--watch"
    "--watch-path=src"
    "--watch-preserve-output"
    "-e"
    # Inline JS: run build, then import the app
    "const{execSync}=require('child_process');try{execSync('npm run build',{stdio:'inherit'})}catch{process.exit(1)};import('./dist/index.js')"
)

# node --watch does not work well with inline -e + dynamic import in all
# versions, so instead we use a tiny loader script.
$loaderContent = @"
import { execSync } from 'child_process';

// Rebuild on every (re)start so dist/ is up-to-date
try {
  execSync('npx tsc && node -e "require(''fs'').cpSync(''src/public'',''dist/public'',{recursive:true})"', {
    stdio: 'inherit',
    cwd: import.meta.dirname ?? '.',
  });
} catch {
  console.error('\x1b[31mBuild failed — waiting for next change...\x1b[0m');
  // Keep process alive so --watch can restart on next save
  await new Promise(() => {});
}

// Start the actual server
await import('./dist/index.js');
"@

$loaderPath = Join-Path $PSScriptRoot ".dev-entry.mjs"
Set-Content -Path $loaderPath -Value $loaderContent -Encoding UTF8

try {
    & $nodeBin --watch --watch-path=src --watch-preserve-output $loaderPath
}
finally {
    # Clean up the temp loader
    if (Test-Path $loaderPath) { Remove-Item $loaderPath -Force }
}
