import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { aggregateBars, auditSameBarCollisions, parseTradingViewCsv } from "../scripts/build-index-competition.mjs";


test("TradingView futures parser rejects malformed OHLC and preserves scheduled gaps", () => {
  const raw = [
    "timestamp,open,high,low,close,volume",
    "1000,10,12,9,11,100",
    "1300,11,13,10,12,120",
    "1900,12,14,11,13,140",
  ].join("\n");
  const parsed = parseTradingViewCsv(raw, "NQ");
  assert.equal(parsed.rows.length, 3);
  assert.equal(parsed.quality.scheduled_or_market_gaps, 1);
  assert.equal(parsed.quality.gaps_filled, false);
  assert.throws(() => parseTradingViewCsv(raw.replace("12,14,11,13", "12,11,14,13"), "NQ"), /quality failure/);
});


test("5-minute bars aggregate without inventing missing rows", () => {
  const rows = [
    [900, 10, 12, 9, 11, 100],
    [1200, 11, 13, 10, 12, 120],
    [1800, 20, 22, 19, 21, 140],
  ];
  assert.deepEqual(aggregateBars(rows, 900), [
    [900, 10, 13, 9, 12, 220],
    [1800, 20, 22, 19, 21, 140],
  ]);
});


test("one-minute QA can identify a target-first path without changing conservative scores", () => {
  const trade = {
    symbol: "NQ",
    timeframe: "15m",
    direction: "long",
    entry: 100,
    stop: 99,
    target: 102,
    opened_bar_ts: 900,
    closed_bar_ts: 1800,
    close_reason: "same_bar_stop_first",
  };
  const minutes = [
    [1800, 100.5, 102.2, 100.2, 102, 1],
    [1860, 102, 102.1, 98.8, 99, 1],
  ];
  assert.deepEqual(auditSameBarCollisions([trade], minutes), {
    collisions: 1,
    covered: 1,
    stop_first: 0,
    target_first: 1,
    intraminute_ambiguous: 0,
    unresolved_or_missing: 0,
  });
});


test("published NQ ES competition keeps the full roster and auditable holdout ranking", async () => {
  const payload = JSON.parse(await readFile(new URL("../../data/index-coach-competition.json", import.meta.url), "utf8"));
  assert.equal(payload.schema, "ev_desk_index_coach_competition_v1");
  assert.equal(payload.summary.roster, 17);
  assert.equal(payload.leaderboard.length, 17);
  assert.deepEqual(payload.meta.timeframes, ["15m", "1h", "4h"]);
  assert.equal(payload.meta.quality.aligned_timestamp_rows, true);
  assert.equal(payload.meta.quality.gaps_preserved, true);
  assert.equal(payload.meta.quality.nq_one_minute_path_audit.available, true);
  assert.ok(payload.meta.quality.nq_one_minute_path_audit.collisions > 0);
  assert.equal(payload.meta.execution.contracts.NQ.round_trip_points, .75);
  assert.equal(payload.meta.execution.contracts.ES.round_trip_points, .6);
  const ranked = payload.leaderboard.filter((coach) => coach.rank != null);
  assert.ok(ranked.length >= 10);
  assert.deepEqual(ranked.map((coach) => coach.rank), ranked.map((_, index) => index + 1));
  assert.ok(ranked.every((coach) => coach.holdout.n > 0 && Number.isFinite(coach.holdout.scope_weighted_ev)));
  assert.ok(ranked.every((coach) => coach.holdout.recent_trades.length > 0 && coach.holdout.recent_trades.length <= 20));
  assert.ok(ranked.every((coach) => coach.holdout.recent_trades.every((trade) => ["NQ", "ES"].includes(trade.symbol) && ["15m", "1h", "4h"].includes(trade.timeframe))));
  for (const id of ["grid", "sentiment", "macro"]) {
    const coach = payload.leaderboard.find((row) => row.id === id);
    assert.equal(coach.rank, null);
    assert.equal(coach.permission, "none");
    assert.ok(coach.reason);
  }
});
