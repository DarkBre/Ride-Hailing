-- ==============================================================================
-- PAYMENT SERVICE DATABASE SCHEMA (payment_db)
-- Single Source of Truth: Database-per-service for Payment Microservice
-- ==============================================================================

CREATE TABLE IF NOT EXISTS wallets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID UNIQUE NOT NULL,
    balance NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
    held_balance NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (held_balance >= 0),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payment_holds (
    trip_id UUID PRIMARY KEY,
    user_id UUID,
    amount NUMERIC(12, 2),
    state VARCHAR(20) NOT NULL CHECK (state IN ('HELD', 'CAPTURED', 'REFUNDED', 'FAILED')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wallet_topups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    request_key VARCHAR(128) NOT NULL,
    amount NUMERIC(12, 2) NOT NULL,
    result JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, request_key)
);

CREATE TABLE IF NOT EXISTS transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id UUID NOT NULL,
    trip_id UUID,
    amount NUMERIC(12, 2) NOT NULL,
    type VARCHAR(20) NOT NULL CHECK (type IN ('TOPUP', 'HOLD', 'CAPTURE', 'REFUND')),
    status VARCHAR(20) NOT NULL CHECK (status IN ('SUCCESS', 'FAILED')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Transactional Outbox Pattern Table (Supports PENDING, PUBLISHING, PUBLISHED, FAILED)
CREATE TABLE IF NOT EXISTS outbox_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_type VARCHAR(50) NOT NULL,
    aggregate_id UUID NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    correlation_id VARCHAR(100) NOT NULL,
    status VARCHAR(20) DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PUBLISHING', 'PUBLISHED', 'FAILED')),
    retry_count INT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    published_at TIMESTAMP WITH TIME ZONE NULL
);

-- Idempotency and Event Deduplication Table
CREATE TABLE IF NOT EXISTS processed_events (
    event_id UUID PRIMARY KEY,
    event_type VARCHAR(100) NOT NULL,
    processed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wallets_user_id ON wallets(user_id);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_events(status, created_at) WHERE status IN ('PENDING', 'PUBLISHING');
