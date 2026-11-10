#!/usr/bin/env bash
set -euo pipefail

# Run as postgres inside a fresh, network-isolated PostgreSQL container.
test "$(id -un)" = postgres
test "$(psql -X -Atc 'SHOW archive_mode')" = on
test -d /tmp/ds03-wal
test ! -e /tmp/ds03-base

psql -X -v ON_ERROR_STOP=1 -c 'CREATE TABLE pitr_probe (id int PRIMARY KEY); INSERT INTO pitr_probe VALUES (1);'
pg_basebackup -D /tmp/ds03-base -X stream -c fast
psql -X -v ON_ERROR_STOP=1 -c 'INSERT INTO pitr_probe VALUES (2);'
target=$(psql -X -Atc 'SELECT clock_timestamp()')
psql -X -v ON_ERROR_STOP=1 -c 'DELETE FROM pitr_probe;'
wal=$(psql -X -Atc 'SELECT pg_walfile_name(pg_current_wal_insert_lsn())')
psql -X -Atc 'SELECT pg_switch_wal()' >/dev/null
for _ in {1..45}; do
  test -f "/tmp/ds03-wal/$wal" && break
  sleep 1
done
test -f "/tmp/ds03-wal/$wal"
test "$(psql -X -Atc 'SELECT count(*) FROM pitr_probe')" = 0

cat >> /tmp/ds03-base/postgresql.auto.conf <<EOF
restore_command = 'cp /tmp/ds03-wal/%f %p'
recovery_target_time = '$target'
recovery_target_action = 'promote'
EOF
touch /tmp/ds03-base/recovery.signal
started=$(date +%s)
pg_ctl -D /tmp/ds03-base -l /tmp/ds03-pitr.log -o "-p 55432 -c archive_mode=off -c listen_addresses=''" -w -t 45 start
trap 'pg_ctl -D /tmp/ds03-base -m fast stop >/dev/null' EXIT
for _ in {1..40}; do
  test "$(psql -p 55432 -X -Atc 'SELECT pg_is_in_recovery()' 2>/dev/null || true)" = f && break
  sleep 1
done
test "$(psql -p 55432 -X -Atc 'SELECT pg_is_in_recovery()')" = f
restored=$(psql -p 55432 -X -Atc "SELECT string_agg(id::text, ',' ORDER BY id) FROM pitr_probe")
test "$restored" = 1,2
printf 'target=%s source_after_delete=0 restored_ids=%s recovery_seconds=%s\n' "$target" "$restored" "$(( $(date +%s) - started ))"
