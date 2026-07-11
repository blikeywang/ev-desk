PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS experts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  school TEXT NOT NULL,
  version TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY,
  expert_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('long','short')),
  confidence REAL NOT NULL,
  regime TEXT NOT NULL,
  bar_ts INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  signal_price REAL NOT NULL,
  entry REAL NOT NULL,
  stop REAL NOT NULL,
  target REAL NOT NULL,
  rr REAL NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','active','closed','expired')),
  entry_bar_ts INTEGER,
  closed_bar_ts INTEGER,
  expires_bars INTEGER NOT NULL DEFAULT 12,
  max_hold_bars INTEGER NOT NULL DEFAULT 30,
  age_bars INTEGER NOT NULL DEFAULT 0,
  held_bars INTEGER NOT NULL DEFAULT 0,
  trigger_text TEXT,
  invalid_text TEXT,
  previous_hash TEXT,
  record_hash TEXT NOT NULL,
  FOREIGN KEY(expert_id) REFERENCES experts(id)
);

CREATE INDEX IF NOT EXISTS idx_signals_scope_status
  ON signals(symbol,timeframe,status);
CREATE INDEX IF NOT EXISTS idx_signals_expert
  ON signals(expert_id,bar_ts);

CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  signal_id TEXT NOT NULL UNIQUE,
  expert_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  direction TEXT NOT NULL,
  regime TEXT NOT NULL,
  opened_bar_ts INTEGER NOT NULL,
  closed_bar_ts INTEGER NOT NULL,
  entry REAL NOT NULL,
  exit REAL NOT NULL,
  stop REAL NOT NULL,
  target REAL NOT NULL,
  gross_r REAL NOT NULL,
  cost_r REAL NOT NULL,
  net_r REAL NOT NULL,
  close_reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  previous_hash TEXT,
  record_hash TEXT NOT NULL,
  FOREIGN KEY(signal_id) REFERENCES signals(id),
  FOREIGN KEY(expert_id) REFERENCES experts(id)
);

CREATE INDEX IF NOT EXISTS idx_trades_expert
  ON trades(expert_id,closed_bar_ts);
CREATE INDEX IF NOT EXISTS idx_trades_scope
  ON trades(symbol,timeframe,closed_bar_ts);

CREATE TABLE IF NOT EXISTS arena_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS arena_runs (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL,
  symbols INTEGER NOT NULL DEFAULT 0,
  signals_created INTEGER NOT NULL DEFAULT 0,
  trades_closed INTEGER NOT NULL DEFAULT 0,
  error_text TEXT
);

CREATE TABLE IF NOT EXISTS opportunity_snapshots (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  bar_ts INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  direction TEXT NOT NULL,
  score REAL NOT NULL,
  stage TEXT NOT NULL,
  rr REAL NOT NULL,
  consensus REAL NOT NULL,
  location_score REAL NOT NULL,
  trust_score REAL NOT NULL,
  regime_fit REAL NOT NULL,
  conflict REAL NOT NULL,
  entry REAL,
  stop REAL,
  target REAL,
  trigger_text TEXT,
  invalid_text TEXT,
  top_experts TEXT,
  opposing_experts TEXT,
  summary TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  UNIQUE(symbol,timeframe,bar_ts)
);

CREATE INDEX IF NOT EXISTS idx_opportunities_latest
  ON opportunity_snapshots(symbol,timeframe,bar_ts DESC);
CREATE INDEX IF NOT EXISTS idx_opportunities_rank
  ON opportunity_snapshots(bar_ts DESC,score DESC);
