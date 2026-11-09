#!/usr/bin/env bash
set -euo pipefail
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
  -v driver_password="$DRIVER_DB_PASSWORD" -v match_password="$MATCHING_DB_PASSWORD" \
  -v payment_password="$PAYMENT_DB_PASSWORD" <<'SQL'
CREATE ROLE driver_service LOGIN PASSWORD :'driver_password';
CREATE ROLE matching_service LOGIN PASSWORD :'match_password';
CREATE ROLE payment_service LOGIN PASSWORD :'payment_password';
CREATE DATABASE driver_db OWNER driver_service;
CREATE DATABASE match_db OWNER matching_service;
CREATE DATABASE payment_db OWNER payment_service;
REVOKE CONNECT ON DATABASE driver_db, match_db, payment_db FROM PUBLIC;
SQL
