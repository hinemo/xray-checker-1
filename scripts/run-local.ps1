param(
  [Parameter(Mandatory = $true)]
  [string]$SubscriptionUrl,

  [switch]$FrontendDev,

  [string]$Host = "127.0.0.1",

  [string]$Port = "2112"
)

$ErrorActionPreference = "Stop"

if ($FrontendDev) {
  Write-Host "Starting frontend dev server on port 5173..."
  Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$PSScriptRoot\..\frontend'; `$env:VITE_API_BASE='http://$Host`:$Port'; npm run dev"

  Write-Host "Starting backend with default web template..."
  go run . --subscription-url "$SubscriptionUrl" --metrics-host "$Host" --metrics-port "$Port"
  exit 0
}

Write-Host "Building frontend for backend static integration..."
Push-Location "$PSScriptRoot\..\frontend"
try {
  npm run build
}
finally {
  Pop-Location
}

Write-Host "Starting backend with custom frontend assets from frontend/dist..."
go run . --subscription-url "$SubscriptionUrl" --metrics-host "$Host" --metrics-port "$Port" --web-custom-assets-path "$PSScriptRoot\..\frontend\dist"
