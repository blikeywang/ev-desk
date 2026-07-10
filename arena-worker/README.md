# EV Desk 24/7 Expert Arena Worker

Cloudflare Worker + D1 implementation for a continuously running, publicly auditable expert paper-trading arena.

## What it adds

- Scheduled market scans every five minutes
- Deterministic expert signals from closed candles only
- One open/pending plan per expert × symbol × timeframe
- Twelve-bar pending expiry and thirty-bar position timeout
- Pessimistic stop-first settlement when stop and target occur in one candle
- 0.10% round-trip cost converted into R
- Append-only signal/trade hashes linked through a hash chain
- Public read-only leaderboard, expert record, positions, ledger and proof APIs
- Cached opportunity snapshots ranked by plan quality for admin/secondary display
- Optional token-protected manual run endpoint

## Setup

1. Install dependencies: `npm install`
2. Create D1: `npx wrangler d1 create ev-desk-arena`
3. Copy `wrangler.example.toml` to `wrangler.toml` and insert the returned database ID.
4. Create tables: `npm run db:remote`
5. Optionally set a manual-run secret: `npx wrangler secret put ADMIN_TOKEN`
6. Deploy: `npm run deploy`

The production frontend can set:

```js
window.EV_DESK_CONFIG = {
  arenaApi: "https://ev-desk-arena.<account>.workers.dev"
};
```

Until that URL is configured, the static app continues to use its browser-local forward arena.

## Public endpoints

- `GET /health`
- `GET /api/v1/arena/meta`
- `GET /api/v1/arena/leaderboard?symbol=BTCUSDT&timeframe=4h`
- `GET /api/v1/arena/opportunities?symbol=BTCUSDT&timeframe=4h`
- `GET /api/v1/arena/experts/:id`
- `GET /api/v1/arena/positions`
- `GET /api/v1/arena/ledger?limit=100`
- `GET /api/v1/arena/proof/:hash`

The optional `POST /api/v1/admin/run` requires `Authorization: Bearer <ADMIN_TOKEN>`.

## Trust boundary

The hash chain makes silent record mutation detectable when snapshots of the chain head are retained externally. It is not a blockchain and does not by itself prove that the operator never replaced the whole database. A mature paid service should periodically publish signed chain-head checkpoints to an independent location.
