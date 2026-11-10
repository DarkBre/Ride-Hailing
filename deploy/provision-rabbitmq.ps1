param(
  [Parameter(Mandatory)][string] $Project,
  [Parameter(Mandatory)][string] $EnvFile
)
$ErrorActionPreference = 'Stop'
$compose = @('compose', '-p', $Project, '--env-file', $EnvFile, '-f', 'deploy/docker-compose.yml',
    '-f', 'deploy/docker-compose.acl.yml')
function Invoke-Compose {
  & docker @compose @args
  if ($LASTEXITCODE -ne 0) { throw 'RabbitMQ provisioning command failed' }
}
foreach ($service in @('matching', 'trip', 'payment')) {
  $variable = "RABBITMQ_$($service.ToUpperInvariant())_PASSWORD"
  $password = [Environment]::GetEnvironmentVariable($variable)
  if ($password -cnotmatch '^[A-Za-z0-9_-]{24,}$') { throw "Set $variable in the process environment" }
}
Invoke-Compose up -d --wait rabbitmq
for ($attempt = 0; $attempt -lt 20; $attempt++) {
  & docker @compose exec -T rabbitmq rabbitmq-diagnostics -q check_running *> $null
  if ($LASTEXITCODE -eq 0) { break }
  Start-Sleep -Seconds 1
}
if ($LASTEXITCODE -ne 0) { throw 'RabbitMQ application did not become ready' }
foreach ($service in @('matching', 'trip', 'payment')) {
  $password = [Environment]::GetEnvironmentVariable("RABBITMQ_$($service.ToUpperInvariant())_PASSWORD")
  & docker @compose exec -T rabbitmq rabbitmqctl add_user $service $password *> $null
  if ($LASTEXITCODE -ne 0) { throw "Could not create RabbitMQ service user $service" }
}
$definitions = & node deploy/rabbitmq-definitions.cjs
if ($LASTEXITCODE -ne 0) { throw 'Definition generation failed' }
$definitions | & docker @compose exec -T rabbitmq sh -ec 'file=$(mktemp); trap "rm -f $file" EXIT; cat > "$file"; rabbitmqctl import_definitions "$file"'
if ($LASTEXITCODE -ne 0) { throw 'Definition import failed' }
