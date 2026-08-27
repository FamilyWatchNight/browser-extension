$ErrorActionPreference = 'Stop'

$chromeCandidates = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LocalAppData\Google\Chrome\Application\chrome.exe"
)

$chrome = $chromeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) {
  throw 'Could not find chrome.exe in the standard Windows installation locations.'
}

$workspace = Split-Path -Parent $PSScriptRoot
$extension = Join-Path $workspace 'dist'
$profileDir = Join-Path $workspace '.vscode\chrome-profile'
$port = 9222

if (-not (Test-Path (Join-Path $extension 'manifest.json'))) {
  throw "The built extension was not found at $extension. Run npm run build first."
}

try {
  Invoke-WebRequest "http://127.0.0.1:$port/json/version" -UseBasicParsing -TimeoutSec 1 | Out-Null
  Write-Output "Chrome is already listening on port $port. Reusing that browser session."
  exit 0
} catch {
  # No browser is listening yet; start the dedicated debug profile below.
}

$chromeArguments = @(
  "--remote-debugging-port=$port",
  "--user-data-dir=$profileDir",
  "--load-extension=$extension",
  '--no-first-run',
  '--no-default-browser-check',
  'https://www.youtube.com/watch?v=1WhzaO0DVJM'
)

Start-Process -FilePath $chrome -ArgumentList $chromeArguments | Out-Null

for ($attempt = 0; $attempt -lt 30; $attempt++) {
  try {
    Invoke-WebRequest "http://127.0.0.1:$port/json/version" -UseBasicParsing -TimeoutSec 1 | Out-Null
    Write-Output "Chrome debug session is ready on port $port."
    exit 0
  } catch {
    Start-Sleep -Milliseconds 250
  }
}

throw "Chrome started but did not become available on port $port."