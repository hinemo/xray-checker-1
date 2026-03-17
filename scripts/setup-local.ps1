param()

$ErrorActionPreference = "Stop"

function Require-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing required command: $Name"
  }
}

Write-Host "[1/3] Checking local prerequisites..."
Require-Command "go"
Require-Command "node"
Require-Command "npm"

Write-Host "[2/3] Downloading Go modules..."
go mod download

Write-Host "[3/3] Installing frontend dependencies..."
Push-Location "frontend"
try {
  npm install
}
finally {
  Pop-Location
}

Write-Host "Local environment is ready."