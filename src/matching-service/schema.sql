CREATE TABLE IF NOT EXISTS inbox_events (
    event_id UUID PRIMARY KEY,
    received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS matching_requests (
    trip_id UUID PRIMARY KEY,
    envelope JSONB NOT NULL,
    state TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (state IN ('PENDING', 'MATCHED', 'NO_DRIVER', 'TIMEOUT', 'CANCELLED')),
    deadline TIMESTAMPTZ NOT NULL,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    attempts INTEGER NOT NULL DEFAULT 0,
    lease_token UUID,
    result JSONB
);
CREATE INDEX IF NOT EXISTS matching_ready ON matching_requests (next_attempt_at) WHERE state = 'PENDING';
CREATE TABLE IF NOT EXISTS outbox_events (
    event_id UUID PRIMARY KEY,
    envelope JSONB NOT NULL,
    published_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS matching_outbox_ready ON outbox_events (created_at) WHERE published_at IS NULL;
