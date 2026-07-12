$ErrorActionPreference = "Stop"

function Read-EnvFile($Path) {
  $envMap = @{}
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

if (-not $env:SUPABASE_ACCESS_TOKEN -and $envMap["SUPABASE_ACCESS_TOKEN"]) {
  $env:SUPABASE_ACCESS_TOKEN = $envMap["SUPABASE_ACCESS_TOKEN"]
}

if (-not $env:SUPABASE_ACCESS_TOKEN) {
  throw "Set SUPABASE_ACCESS_TOKEN in the environment or .env.local. Create it in Supabase Account Settings > Access Tokens."
}

$env:SERVICE_ROLE_KEY = $envMap["SUPABASE_SERVICE_ROLE_KEY"]
$env:PAYMENT_PROVIDER = if ($env:PAYMENT_PROVIDER) { $env:PAYMENT_PROVIDER } else { "template" }

function Invoke-Supabase {
  $localCli = "C:\Users\casto\npm-cache\_npx\aa8e5c70f9d8d161\node_modules\@supabase\cli-windows-x64\bin\supabase.exe"
  if (Test-Path $localCli) {
    & $localCli @args
  } else {
    npx supabase @args
  }
  if ($LASTEXITCODE -ne 0) {
    throw "Supabase CLI failed with exit code $LASTEXITCODE."
  }
}

Invoke-Supabase link --project-ref $envMap["SUPABASE_PROJECT_REF"]

Invoke-Supabase secrets set `
  SERVICE_ROLE_KEY="$($envMap["SUPABASE_SERVICE_ROLE_KEY"])" `
  PAYMENT_PROVIDER="$env:PAYMENT_PROVIDER" `
  GOOGLE_VISION_API_KEY="$($envMap["GOOGLE_VISION_API_KEY"])"

Invoke-Supabase functions deploy create-payment-session --no-verify-jwt
Invoke-Supabase functions deploy payment-webhook --no-verify-jwt
Invoke-Supabase functions deploy verify-gcash-receipt --no-verify-jwt
Invoke-Supabase functions deploy host-application --no-verify-jwt
Invoke-Supabase functions deploy manage-account --no-verify-jwt
Invoke-Supabase functions deploy send-confirmation-email --no-verify-jwt
Invoke-Supabase functions deploy send-reschedule-email --no-verify-jwt
Invoke-Supabase functions deploy send-telegram-notification --no-verify-jwt
Invoke-Supabase functions deploy integration-status --no-verify-jwt

Write-Host "Edge Functions deployed."
