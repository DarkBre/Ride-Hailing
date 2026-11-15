CREATE TABLE IF NOT EXISTS drivers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    vehicle_plate VARCHAR(50) NOT NULL,
    vehicle_model VARCHAR(100),
    latitude DOUBLE PRECISION DEFAULT 21.028511,
    longitude DOUBLE PRECISION DEFAULT 105.854444,
    status VARCHAR(20) DEFAULT 'OFFLINE' CHECK (status IN ('AVAILABLE', 'BUSY', 'OFFLINE')),
    version INT DEFAULT 1,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE drivers ADD COLUMN IF NOT EXISTS location_updated_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_drivers_status_location ON drivers (status, latitude, longitude);

ALTER TABLE drivers DROP CONSTRAINT IF EXISTS drivers_status_check;
ALTER TABLE drivers ADD CONSTRAINT drivers_status_check
    CHECK (status IN ('AVAILABLE', 'RESERVED', 'BUSY', 'OFFLINE'));

CREATE TABLE IF NOT EXISTS driver_reservations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trip_id UUID UNIQUE NOT NULL,
    driver_id UUID REFERENCES drivers(id),
    state TEXT NOT NULL CHECK (state IN ('HELD', 'CONFIRMED', 'RELEASED', 'EXPIRED')),
    expires_at TIMESTAMPTZ,
    CHECK (state = 'RELEASED' OR (driver_id IS NOT NULL AND expires_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_reservation_per_driver
    ON driver_reservations (driver_id) WHERE state IN ('HELD', 'CONFIRMED');
CREATE INDEX IF NOT EXISTS driver_reservation_expiry
    ON driver_reservations (expires_at) WHERE state = 'HELD';
