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

if (-not $env:SUPABASE_ACCESS_TOKEN) {
  throw "Set SUPABASE_ACCESS_TOKEN first. Create it in Supabase Account Settings > Access Tokens."
}

$env:SERVICE_ROLE_KEY = $envMap["SUPABASE_SERVICE_ROLE_KEY"]
$env:PAYMENT_PROVIDER = if ($env:PAYMENT_PROVIDER) { $env:PAYMENT_PROVIDER } else { "template" }

npx supabase link --project-ref $envMap["SUPABASE_PROJECT_REF"]

npx supabase secrets set `
  SERVICE_ROLE_KEY="$($envMap["SUPABASE_SERVICE_ROLE_KEY"])" `
  PAYMENT_PROVIDER="$env:PAYMENT_PROVIDER"

npx supabase functions deploy create-payment-session
npx supabase functions deploy payment-webhook
npx supabase functions deploy verify-gcash-receipt
npx supabase functions deploy send-confirmation-email
npx supabase functions deploy send-reschedule-email
npx supabase functions deploy send-telegram-notification
npx supabase functions deploy integration-status

Write-Host "Edge Functions deployed."
