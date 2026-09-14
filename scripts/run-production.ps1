# ---------------------------------------------------------------------------
# run-production.ps1 - build everything, then run the production server on
# one port (UI + API + play websocket).
#
#   npm run prod                        # default port 4000
#   npm run prod -- -Port 5000          # custom port
#
# JWT secret: a random 64-char hex secret is generated on first run and saved
# to server/data/.jwt-secret. It is reused on later runs so friends' login
# tokens survive restarts. Delete that file to force a fresh secret (logs
# everyone out). Ctrl+C stops the server.
# ---------------------------------------------------------------------------

param(
    [int]$Port = 4000
)

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

Write-Host "==> Building server + client..." -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) { throw "Build failed." }

foreach ($artifact in @('server/dist/index.js', 'client/dist/index.html')) {
    if (-not (Test-Path $artifact)) { throw "Expected $artifact after the build - check the build output above." }
}

# --- JWT secret: reuse the persisted one so tokens survive restarts ---
$secretFile = Join-Path (Join-Path 'server' 'data') '.jwt-secret'
if (Test-Path $secretFile) {
    $secret = (Get-Content $secretFile -Raw).Trim()
    if ($secret.Length -lt 32) { throw "JWT secret file $secretFile looks corrupted - delete it to regenerate." }
    Write-Host "==> Reusing existing JWT secret from $secretFile" -ForegroundColor Cyan
} else {
    $secret = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
    New-Item -ItemType Directory -Force -Path (Split-Path $secretFile) | Out-Null
    Set-Content -Path $secretFile -Value $secret -NoNewline
    Write-Host "==> Generated a new JWT secret, saved to $secretFile" -ForegroundColor Cyan
}

$env:PORT = $Port
$env:JWT_SECRET = $secret

Write-Host ""
Write-Host "==> Production server starting on port $Port" -ForegroundColor Green
Write-Host "    Local:  http://localhost:$Port"
Write-Host "    LAN:    http://<your-LAN-IP>:$Port   (find it with 'ipconfig')"
Write-Host "    WAN:    http://<your-WAN-IP>:$Port   (needs router port forwarding or a tunnel)"
Write-Host "    Press Ctrl+C to stop."
Write-Host ""

# Foreground: logs stream here and Ctrl+C stops the server.
& node server/dist/index.js
exit $LASTEXITCODE
