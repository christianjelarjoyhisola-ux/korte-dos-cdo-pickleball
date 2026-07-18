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

if (-not $env:CLOUDFLARE_API_TOKEN) {
  throw "Set CLOUDFLARE_API_TOKEN in the environment or .env.local."
}

$projectName = if ($envMap["CLOUDFLARE_PAGES_PROJECT"]) { $envMap["CLOUDFLARE_PAGES_PROJECT"] } else { "korte-dos-cdo-pickleball" }
$branchName = if ($envMap["CLOUDFLARE_PAGES_BRANCH"]) { $envMap["CLOUDFLARE_PAGES_BRANCH"] } else { "main" }

$publicFiles = @(
  "_headers",
  "_worker.js",
  "admin.html",
  "admin.js",
  "ads.txt",
  "auth.js",
  "booking-balance.js",
  "c737b56c-ac91-406b-af7d-7d06f2ac775c.jpg",
  "CHANGELOG.md",
  "chart.min.js",
  "court-splash.jpg",
  "f6b5eb3c-a6b6-49ce-981e-d9b127b67ba3.jpg",
  "host.html",
  "index.html",
  "korte-dos-logo.png",
  "korte-dos-logo.svg",
  "login.html",
  "script.js",
  "setup-db.js",
  "SETUP_NEW_SUPABASE.sql",
  "signature-view.html",
  "signature-view.png",
  "style.css",
  "supabase-config.js",
  "supabase.min.js"
)

New-Item -ItemType Directory -Force ".cf-pages-deploy" | Out-Null
foreach ($file in $publicFiles) {
  if (Test-Path $file) {
    Copy-Item -LiteralPath $file -Destination ".cf-pages-deploy" -Force
  }
}

npx wrangler pages deploy ".cf-pages-deploy" --project-name $projectName --branch $branchName
if ($LASTEXITCODE -ne 0) {
  throw "Cloudflare Pages deploy failed with exit code $LASTEXITCODE."
}

Write-Host "Cloudflare Pages deployed."
