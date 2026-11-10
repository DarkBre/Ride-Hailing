param(
  [Parameter(Mandatory)][ValidatePattern('^ds03-[a-z0-9-]+$')][string] $Project,
  [Parameter(Mandatory)][string] $EnvFile,
  [Parameter(Mandatory)][string] $GatewayUrl,
  [Parameter(Mandatory)][string] $Log,
  [ValidateRange(1,10)][int] $Runs = 3,
  [ValidateRange(5000,60000)][int] $DurationMs = 10000,
  [ValidateRange(0,10000)][int] $WarmupMs = 3000,
  [string] $RabbitVhost = '/'
)
$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $Log) { throw 'Use a new log filename' }
$env:COMPOSE_TEST_PROJECT = $Project
$env:COMPOSE_TEST_ENV_FILE = $EnvFile
$env:GATEWAY_TEST_URL = $GatewayUrl
$env:RUN_LOAD_TEST = '1'
$env:LOAD_DURATION_MS = "$DurationMs"
$env:LOAD_WARMUP_MS = "$WarmupMs"
$env:LOAD_RABBITMQ_VHOST = $RabbitVhost
for ($iteration = 1; $iteration -le $Runs; $iteration++) {
  "Run $iteration of $Runs" | Tee-Object -FilePath $Log -Append
  node --test --test-name-pattern 'Load:' tests/compose.e2e.test.cjs 2>&1 | Tee-Object -FilePath $Log -Append
  if ($LASTEXITCODE -ne 0) { throw "Benchmark run $iteration failed" }
}
