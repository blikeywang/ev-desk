import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { aggregatePrior, chooseConsensusCandidate, scopePrior } from "../scripts/build-coach-training.mjs";


test("scope prior is neutral for small samples", () => {
  assert.equal(scopePrior({ n: 19, ev: 0.8, ev_ci95: [0.2, 1.4] }), 1);
});


test("scope prior is conservative and bounded", () => {
  assert.ok(scopePrior({ n: 400, ev: 0.6, ev_ci95: [0.4, 0.8] }) <= 1.08);
  assert.ok(scopePrior({ n: 400, ev: -0.6, ev_ci95: [-0.8, -0.4] }) >= 0.92);
});


test("aggregate prior balances scopes instead of letting one scope dominate", () => {
  const result = aggregatePrior([
    { n: 400, ev: 0.20 },
    { n: 40, ev: -0.10 },
    { n: 10_000, ev: 0.05 },
  ]);
  assert.equal(result.scopes, 3);
  assert.ok(result.prior_multiplier >= 0.9 && result.prior_multiplier <= 1.1);
  assert.ok(result.scope_weighted_ev < 0.2);
});


test("consensus candidate selection never uses final holdout performance", () => {
  const selected = chooseConsensusCandidate([
    {
      id: "validation-winner",
      development: { n: 100, ev: 0.20, mdd: -5 },
      validation: { n: 80, ev: 0.10, mdd: -4 },
      holdout: { n: 80, ev: -9.0, mdd: -900 },
    },
    {
      id: "holdout-winner",
      development: { n: 100, ev: 0.05, mdd: -5 },
      validation: { n: 80, ev: 0.04, mdd: -4 },
      holdout: { n: 80, ev: 9.0, mdd: -1 },
    },
  ]);
  assert.equal(selected.id, "validation-winner");
});


test("published plan gate remains a narrow veto-only guardrail", async () => {
  const payload = JSON.parse(await readFile(new URL("../../data/plan-gate-model.json", import.meta.url), "utf8"));
  assert.equal(payload.status, "accepted_limited");
  assert.equal(payload.selection.used_holdout, false);
  assert.equal(payload.deployment.mode, "veto_only");
  assert.deepEqual(payload.deployment.scopes, ["BTCUSDT|1h", "ETHUSDT|4h"]);
  assert.ok(payload.model.trees.length > 0);
});


test("published coach evidence includes exact recent holdout settlements", async () => {
  const payload = JSON.parse(await readFile(new URL("../../data/coach-training.json", import.meta.url), "utf8"));
  const completed = Object.values(payload.experts).filter((expert) => expert.aggregate_holdout.n > 0);
  assert.ok(completed.length >= 14);
  for (const expert of completed) {
    const populated = Object.values(expert.scopes).map((scope) => scope.holdout).filter((scope) => scope.n > 0);
    assert.ok(populated.length > 0);
    for (const scope of populated) {
      assert.ok(Array.isArray(scope.recent_trades));
      assert.ok(scope.recent_trades.length > 0 && scope.recent_trades.length <= 20);
      assert.ok(scope.recent_trades.every((trade) => Number.isFinite(trade.closed_bar_ts) && Number.isFinite(trade.net_r)));
    }
  }
});
