[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$envFile = Join-Path $repoRoot ".env.local"

function Read-EnvFile($Path) {
  $envMap = @{}
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $envMap }

  Get-Content -LiteralPath $Path | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    $idx = $line.IndexOf("=")
    if ($idx -lt 1) { return }
    $name = $line.Substring(0, $idx).Trim()
    $value = $line.Substring($idx + 1).Trim()
    if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    $envMap[$name] = $value
  }
  return $envMap
}

function Resolve-ConfigValue($Name, $EnvMap, [switch]$Required) {
  $value = [Environment]::GetEnvironmentVariable($Name)
  if (-not $value -and $EnvMap.ContainsKey($Name)) { $value = $EnvMap[$Name] }
  $value = [string]$value
  if ($Required -and [string]::IsNullOrWhiteSpace($value)) {
    throw "Set $Name in the environment or $envFile."
  }
  return $value.Trim()
}

$envMap = Read-EnvFile $envFile
$accessToken = Resolve-ConfigValue "SUPABASE_ACCESS_TOKEN" $envMap -Required
$projectRef = Resolve-ConfigValue "SUPABASE_PROJECT_REF" $envMap -Required
$serviceRoleKey = Resolve-ConfigValue "SUPABASE_SERVICE_ROLE_KEY" $envMap -Required
$databasePassword = Resolve-ConfigValue "SUPABASE_DB_PASSWORD" $envMap
$googleVisionKey = Resolve-ConfigValue "GOOGLE_VISION_API_KEY" $envMap
$paymentProvider = Resolve-ConfigValue "PAYMENT_PROVIDER" $envMap
if (-not $paymentProvider) { $paymentProvider = "template" }
$paymentWebhookSecret = Resolve-ConfigValue "PAYMENT_WEBHOOK_SECRET" $envMap

if ($paymentProvider -eq "paymongo" -and -not $paymentWebhookSecret) {
  throw "PAYMENT_WEBHOOK_SECRET is required when PAYMENT_PROVIDER=paymongo."
}

if ($projectRef -notmatch '^[a-z0-9]{20}$') {
  throw "SUPABASE_PROJECT_REF must be the 20-character project reference, not a URL."
}

# The CLI reads this variable directly. Never print token or secret values.
$env:SUPABASE_ACCESS_TOKEN = $accessToken
if ($databasePassword) { $env:SUPABASE_DB_PASSWORD = $databasePassword }

$script:SupabaseCli = Get-Command "supabase" -ErrorAction SilentlyContinue
$script:NpxCli = Get-Command "npx" -ErrorAction SilentlyContinue
if (-not $script:SupabaseCli -and -not $script:NpxCli) {
  throw "Supabase CLI is unavailable. Install supabase or Node.js/npx first."
}

function Invoke-Supabase {
  if ($script:SupabaseCli) {
    & $script:SupabaseCli.Source @args
  } else {
    & $script:NpxCli.Source supabase @args
  }
  if ($LASTEXITCODE -ne 0) {
    throw "Supabase CLI failed with exit code $LASTEXITCODE."
  }
}

Push-Location $repoRoot
try {
  $supabaseConfig = Join-Path $repoRoot "supabase\config.toml"
  if (-not (Test-Path -LiteralPath $supabaseConfig -PathType Leaf)) {
    Write-Host "Initializing local Supabase CLI configuration..."
    Invoke-Supabase init
  }

  Write-Host "Target Supabase project: $projectRef"
  Invoke-Supabase link --project-ref $projectRef

  $secretArgs = @(
    "secrets", "set",
    "SERVICE_ROLE_KEY=$serviceRoleKey",
    "PAYMENT_PROVIDER=$paymentProvider"
  )
  if ($googleVisionKey) { $secretArgs += "GOOGLE_VISION_API_KEY=$googleVisionKey" }
  if ($paymentWebhookSecret) { $secretArgs += "PAYMENT_WEBHOOK_SECRET=$paymentWebhookSecret" }
  Invoke-Supabase @secretArgs

  # Expand and verify the database contract before deploying handlers that use
  # the new receipt-attestation and host-review columns/RPCs. Public pages are
  # still deployed separately after both server layers are ready.
  Write-Host "Validating and applying database migrations..."
  Invoke-Supabase db push --dry-run
  Invoke-Supabase db push

  $allFunctions = @(
    "verify-gcash-receipt",
    "manage-payment-review-notification",
    "process-payment-review-notifications",
    "review-payment-receipt",
    "create-payment-session",
    "payment-webhook",
    "host-application",
    "manage-account",
    "send-confirmation-email",
    "process-host-balance-deadlines",
    "send-reschedule-email",
    "send-telegram-notification",
    "integration-status"
  )

  foreach ($functionName in $allFunctions) {
    Invoke-Supabase functions deploy $functionName --no-verify-jwt
  }

  Write-Host "Database migrations and Edge Functions deployed successfully."
} finally {
  Pop-Location
}
