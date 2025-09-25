-- Postgres DDL for audit & idempotence (append-only)

CREATE TABLE IF NOT EXISTS trades (
  id BIGSERIAL PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('LONG','SHORT')),
  leverage INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('OPEN','CLOSED','CANCELLED','ERROR')),
  meta JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS trades_symbol_created_idx ON trades (symbol, created_at DESC);

CREATE TABLE IF NOT EXISTS orders (
  id BIGSERIAL PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  leg_id TEXT NOT NULL,
  attempt INT NOT NULL,
  client_order_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  type TEXT NOT NULL,
  side TEXT NOT NULL,
  qty NUMERIC,
  price NUMERIC,
  reduce_only BOOLEAN,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL,
  raw JSONB NOT NULL DEFAULT '{}',
  UNIQUE (client_order_id),
  UNIQUE (workflow_id, leg_id, attempt)
);
CREATE INDEX IF NOT EXISTS orders_symbol_created_idx ON orders (symbol, created_at DESC);

CREATE TABLE IF NOT EXISTS fills (
  id BIGSERIAL PRIMARY KEY,
  client_order_id TEXT NOT NULL,
  trade_id BIGINT,
  symbol TEXT NOT NULL,
  fill_qty NUMERIC,
  fill_price NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS fills_symbol_created_idx ON fills (symbol, created_at DESC);

CREATE TABLE IF NOT EXISTS lifecycle_events (
  id BIGSERIAL PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  event TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS lifecycle_events_wf_created_idx ON lifecycle_events (workflow_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pnl_snapshots (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB NOT NULL
);

