$ErrorActionPreference = "Stop"

function Read-EnvFile($Path) {
  $envMap = @{}
  if (-not (Test-Path $Path)) { return $envMap }
  Get-Content $Path | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    $idx = $line.IndexOf("=")
    if ($idx -lt 1) { return }
    $envMap[$line.Substring(0, $idx)] = $line.Substring($idx + 1)
  }
  return $envMap
}

$envMap = Read-EnvFile ".env.local"

if (-not $env:CLOUDFLARE_API_TOKEN -and $envMap["CLOUDFLARE_API_TOKEN"]) {
  $env:CLOUDFLARE_API_TOKEN = $envMap["CLOUDFLARE_API_TOKEN"]
}

$projectName = if ($envMap["CLOUDFLARE_PAGES_PROJECT"]) { $envMap["CLOUDFLARE_PAGES_PROJECT"] } else { "backyard-pickle-pickleball" }
$branchName = if ($envMap["CLOUDFLARE_PAGES_BRANCH"]) { $envMap["CLOUDFLARE_PAGES_BRANCH"] } else { "main" }

$publicFiles = @(
  "_headers",
  "_worker.js",
  "admin.html",
  "admin.js",
  "ads.txt",
  "auth.js",
  "booking-balance.js",
  "chart.min.js",
  "host.html",
  "index.html",
  "backyardpicklelogo.jpg",
  "linkimage.jpg",
  "login.html",
  "script.js",
  "signature-view.html",
  "signature-view.png",
  "style.css",
  "supabase-config.js",
  "supabase.min.js"
)

$deployDir = Join-Path ".cf-pages-deploy" ("site-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force $deployDir | Out-Null
foreach ($file in $publicFiles) {
  if (Test-Path $file) {
    Copy-Item -LiteralPath $file -Destination $deployDir -Force
  }
}

npx.cmd wrangler pages deploy $deployDir --project-name $projectName --branch $branchName
if ($LASTEXITCODE -ne 0) {
  throw "Cloudflare Pages deploy failed with exit code $LASTEXITCODE."
}

Write-Host "Cloudflare Pages deployed."
