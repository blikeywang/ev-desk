# EV Desk 24/7 Expert Arena Worker

Cloudflare Worker + D1 implementation for a continuously running, publicly auditable expert paper-trading arena.

## What it adds

- Unified closed-candle market adapter: Binance, Binance Data API, OKX and Kraken
- Binance/OKX derivatives context: funding, mark price, OI and 24-hour changes
- Optional FRED macro context and Alpaca US-equity bars
- Scheduled market scans every five minutes
- Deterministic expert signals from closed candles only
- Versioned snapshots for all expert views, including neutral/watch decisions
- Protected ingestion for licensed human views and behavior models such as Paul Wei
- One open/pending plan per expert × symbol × timeframe
- Twelve-bar pending expiry and thirty-bar position timeout
- Pessimistic stop-first settlement when stop and target occur in one candle
- 0.10% round-trip cost converted into R
- Append-only signal/trade hashes linked through a hash chain
- Public read-only leaderboard, expert record, positions, ledger and proof APIs
- Cached opportunity snapshots ranked by plan quality for admin/secondary display
- Optional token-protected manual run endpoint

## Setup

1. Install locked dependencies: `npm ci`
2. Create D1: `npx wrangler d1 create ev-desk-arena`
3. Copy `wrangler.example.toml` to `wrangler.toml` and insert the returned database ID.
4. Create tables: `npm run db:remote`
5. Set the admin/import secret: `npx wrangler secret put ADMIN_TOKEN`
6. Set `FRED_API_KEY` when macro views are required.
7. Set `ALPACA_KEY_ID` and `ALPACA_SECRET_KEY` when US-equity bars are required.
8. Deploy: `npm run deploy`

The production frontend can set:

```js
window.EV_DESK_CONFIG = {
  arenaApi: "https://ev-desk-arena.<account>.workers.dev",
  marketApi: "https://ev-desk-arena.<account>.workers.dev"
};
```

Until that URL is configured, the static app continues to use its browser-local forward arena.

## Public endpoints

- `GET /health`
- `GET /api/v1/market/bundle?symbol=BTCUSDT&timeframes=15m,1h,4h,1d`
- `GET /api/v1/desk/snapshot?symbol=BTCUSDT&timeframe=4h`
- `GET /api/v1/arena/meta`
- `GET /api/v1/arena/leaderboard?symbol=BTCUSDT&timeframe=4h`
- `GET /api/v1/arena/opportunities?symbol=BTCUSDT&timeframe=4h`
- `GET /api/v1/arena/views?symbol=BTCUSDT&timeframe=1h`
- `GET /api/v1/arena/experts/:id?symbol=BTCUSDT&timeframe=1h`
- `GET /api/v1/arena/positions?expert=paul_wei&symbol=BTCUSDT&timeframe=1h`
- `GET /api/v1/arena/ledger?expert=paul_wei&symbol=BTCUSDT&timeframe=1h&limit=100`
- `GET /api/v1/arena/proof/:hash`

Protected endpoints:

- `POST /api/v1/admin/expert-views`
- `POST /api/v1/admin/run`

Both require `Authorization: Bearer <ADMIN_TOKEN>`. The expert-view schema, Paul Wei producer and complete data-source matrix are documented in `../docs/DATA_AND_EXPERT_EVIDENCE.md`.

## Trust boundary

The hash chain makes silent record mutation detectable when snapshots of the chain head are retained externally. It is not a blockchain and does not by itself prove that the operator never replaced the whole database. A mature paid service should periodically publish signed chain-head checkpoints to an independent location.
