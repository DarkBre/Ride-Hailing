#!/usr/bin/env bash
# ==============================================================================
# DS03: Database-per-service initialization script for PostgreSQL
# Owner: TV3 (Infrastructure & Docker Compose)
# ==============================================================================
set -euo pipefail

psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
  -v identity_password="${IDENTITY_DB_PASSWORD:-identity_secret_password}" \
  -v driver_password="${DRIVER_DB_PASSWORD:-driver_secret_password}" \
  -v match_password="${MATCHING_DB_PASSWORD:-matching_secret_password}" \
  -v trip_password="${TRIP_DB_PASSWORD:-trip_secret_password}" \
  -v payment_password="${PAYMENT_DB_PASSWORD:-payment_secret_password}" <<'SQL'

-- 1. Create independent service roles
CREATE ROLE identity_service WITH LOGIN PASSWORD :'identity_password';
CREATE ROLE driver_service WITH LOGIN PASSWORD :'driver_password';
CREATE ROLE matching_service WITH LOGIN PASSWORD :'match_password';
CREATE ROLE trip_service WITH LOGIN PASSWORD :'trip_password';
CREATE ROLE payment_service WITH LOGIN PASSWORD :'payment_password';

-- 2. Create isolated databases (Database-per-service)
CREATE DATABASE user_db OWNER identity_service;
CREATE DATABASE driver_db OWNER driver_service;
CREATE DATABASE match_db OWNER matching_service;
CREATE DATABASE trip_db OWNER trip_service;
CREATE DATABASE payment_db OWNER payment_service;

-- 3. Restrict cross-database access
REVOKE CONNECT ON DATABASE user_db, driver_db, match_db, trip_db, payment_db FROM PUBLIC;
GRANT CONNECT ON DATABASE user_db TO identity_service;
GRANT CONNECT ON DATABASE driver_db TO driver_service;
GRANT CONNECT ON DATABASE match_db TO matching_service;
GRANT CONNECT ON DATABASE trip_db TO trip_service;
GRANT CONNECT ON DATABASE payment_db TO payment_service;

SQL
