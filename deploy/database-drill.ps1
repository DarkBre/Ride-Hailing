param(
  [Parameter(Mandatory)][ValidateSet('Backup','Restore')][string] $Mode,
  [Parameter(Mandatory)][ValidatePattern('^ds03-drill-[a-z0-9-]+$')][string] $Project,
  [Parameter(Mandatory)][string] $EnvFile,
  [Parameter(Mandatory)][string] $Archive
)
$ErrorActionPreference = 'Stop'
$compose = @('compose', '-p', $Project, '--env-file', $EnvFile, '-f', 'deploy/docker-compose.yml')
function Invoke-Compose {
  & docker @compose @args
  if ($LASTEXITCODE -ne 0) { throw 'Compose command failed' }
}
if ($Mode -eq 'Backup') {
  $queues = @(Invoke-Compose exec -T rabbitmq rabbitmqctl -q list_queues name messages)
  if (@($queues | Where-Object { $_ -match '\s+[1-9][0-9]*\s*$' }).Count) {
    throw 'RabbitMQ queues must be drained before this database-only snapshot'
  }
  if (Test-Path -LiteralPath $Archive) { throw 'Use a new archive directory' }
  New-Item -ItemType Directory -Path $Archive | Out-Null
}
$directory = (Resolve-Path -LiteralPath $Archive).Path
$mount = "${directory}:/archive"
$databases = @('driver_db', 'match_db', 'payment_db')
$running = @(Invoke-Compose ps --status running --services)
if (@($running | Where-Object { $_ -in @('gateway','identity','trip','matching','driver','payment') }).Count) {
  throw 'Stop application services in this isolated project before backup or restore'
}
if ($Mode -eq 'Backup') {
  foreach ($db in $databases) {
    Invoke-Compose exec -T postgres pg_dump -U postgres -Fc -f "/tmp/$db.dump" $db
    Invoke-Compose exec -T postgres pg_restore --list "/tmp/$db.dump" | Out-Null
    Invoke-Compose cp "postgres:/tmp/$db.dump" (Join-Path $directory "$db.dump")
    Invoke-Compose exec -T postgres rm "/tmp/$db.dump"
  }
  Invoke-Compose exec -T postgres pg_dumpall -U postgres --globals-only --no-role-passwords -f /tmp/ds03-roles.sql
  Invoke-Compose cp postgres:/tmp/ds03-roles.sql (Join-Path $directory 'roles.sql')
  Invoke-Compose exec -T postgres rm /tmp/ds03-roles.sql
  foreach ($service in @('identity','trip')) {
    Invoke-Compose run --no-deps --rm -T -v $mount $service node -e 'const {DatabaseSync,backup}=require("node:sqlite"); const s=process.argv[1]; const file=require("./config").DB_PATH; if(!require("node:fs").existsSync(file)) throw new Error("Missing source DB"); const db=new DatabaseSync(file,{readOnly:true}); backup(db,"/archive/"+s+".sqlite").finally(()=>db.close());' $service
  }
  $files = @($databases | ForEach-Object { "$_.dump" }) + @('roles.sql','identity.sqlite','trip.sqlite')
  $manifest = [ordered]@{ createdAt = [DateTime]::UtcNow.ToString('o'); source = $Project; files = [ordered]@{} }
  foreach ($file in $files) {
    $manifest.files[$file] = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $directory $file)).Hash
  }
  $manifest | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $directory 'manifest.json')
} else {
  $manifest = Get-Content -Raw -LiteralPath (Join-Path $directory 'manifest.json') | ConvertFrom-Json
  if ($manifest.source -eq $Project) { throw 'Restore project must differ from backup source' }
  foreach ($entry in $manifest.files.PSObject.Properties) {
    if ($entry.Name -notmatch '^(driver_db\.dump|match_db\.dump|payment_db\.dump|roles\.sql|identity\.sqlite|trip\.sqlite)$') {
      throw 'Unexpected archive filename'
    }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $directory $entry.Name)).Hash -ne $entry.Value) {
      throw 'Backup checksum mismatch'
    }
  }
  if (@($manifest.files.PSObject.Properties).Count -ne 6) { throw 'Incomplete archive manifest' }
  foreach ($db in $databases) {
    $tables = Invoke-Compose exec -T postgres psql -U postgres -d $db -Atc "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'"
    if ($tables -ne '0') { throw "Restore target $db is not empty" }
  }
  foreach ($service in @('identity','trip')) {
    Invoke-Compose run --no-deps --rm -T -v "${mount}:ro" $service node -e 'const fs=require("node:fs"); if(fs.existsSync(require("./config").DB_PATH)) process.exit(1);' $service
  }
  foreach ($db in $databases) {
    Invoke-Compose cp (Join-Path $directory "$db.dump") "postgres:/tmp/$db.dump"
    Invoke-Compose exec -T postgres pg_restore -U postgres -d $db --single-transaction --exit-on-error "/tmp/$db.dump"
    Invoke-Compose exec -T postgres rm "/tmp/$db.dump"
  }
  foreach ($service in @('identity','trip')) {
    Invoke-Compose run --no-deps --rm -T -v "${mount}:ro" $service node -e 'const fs=require("node:fs"); const s=process.argv[1]; fs.copyFileSync("/archive/"+s+".sqlite",require("./config").DB_PATH,fs.constants.COPYFILE_EXCL);' $service
  }
}
