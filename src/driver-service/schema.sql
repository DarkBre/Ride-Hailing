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
