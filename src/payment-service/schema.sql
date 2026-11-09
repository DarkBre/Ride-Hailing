CREATE TABLE IF NOT EXISTS wallets (
    user_id UUID PRIMARY KEY,
    balance BIGINT NOT NULL DEFAULT 0 CHECK (balance BETWEEN 0 AND 9007199254740991),
    held_balance BIGINT NOT NULL DEFAULT 0 CHECK (held_balance BETWEEN 0 AND 9007199254740991)
);
CREATE TABLE IF NOT EXISTS payment_holds (
    trip_id UUID PRIMARY KEY,
    user_id UUID,
    amount BIGINT CHECK (amount > 0),
    state TEXT NOT NULL CHECK (state IN ('HELD', 'FAILED', 'REFUNDED', 'CAPTURED'))
);
CREATE TABLE IF NOT EXISTS payment_inbox (event_id UUID PRIMARY KEY);
CREATE TABLE IF NOT EXISTS payment_outbox (
    event_id UUID PRIMARY KEY,
    envelope JSONB NOT NULL,
    published_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS wallet_topups (
    user_id UUID NOT NULL,
    request_key TEXT NOT NULL,
    amount BIGINT NOT NULL CHECK (amount > 0),
    result JSONB,
    PRIMARY KEY (user_id, request_key)
);
