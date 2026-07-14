import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { aggregatePrior, assessSpecialization, chooseConsensusCandidate, chooseCounterExperiment, chooseExecutionRemedy, chooseSpecialization, scopePrior } from "../scripts/build-coach-training.mjs";


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


test("counter experiment selection uses development and validation only", () => {
  const sourceDevelopment = { scopes: 8, n: 1200, scope_weighted_ev: -0.20, positive_scope_pct: 10 };
  const sourceValidation = { scopes: 8, n: 600, scope_weighted_ev: -0.12, positive_scope_pct: 20 };
  const counterDevelopment = { scopes: 8, n: 1000, scope_weighted_ev: 0.08, positive_scope_pct: 75 };
  const counterValidation = { scopes: 8, n: 500, scope_weighted_ev: 0.05, positive_scope_pct: 62.5 };
  const selected = chooseCounterExperiment(sourceDevelopment, sourceValidation, counterDevelopment, counterValidation);
  assert.equal(selected.selected_without_holdout, true);
  assert.equal(chooseCounterExperiment.length, 4);
  const rejected = chooseCounterExperiment(sourceDevelopment, sourceValidation, counterDevelopment, { ...counterValidation, positive_scope_pct: 50 });
  assert.equal(rejected.selected_without_holdout, false);
});


test("cost-aware execution remedy selection ignores final holdout", () => {
  const base = { scopes: 8, n: 500, positive_scope_pct: 62.5 };
  const selected = chooseExecutionRemedy([
    {
      id: "stable-before-holdout",
      development: { ...base, scope_weighted_ev: 0.12 },
      validation: { ...base, scope_weighted_ev: 0.08 },
      holdout: { ...base, scope_weighted_ev: -9 },
    },
    {
      id: "holdout-winner",
      development: { ...base, scope_weighted_ev: 0.04 },
      validation: { ...base, scope_weighted_ev: 0.03 },
      holdout: { ...base, scope_weighted_ev: 9 },
    },
  ]);
  assert.equal(selected.id, "stable-before-holdout");
});


test("specialist role is selected on development before validation or holdout are read", () => {
  const selected = chooseSpecialization([
    {
      id: "development-winner",
      development: { n: 200, ev: 0.20, ev_ci95: [0.05, 0.35] },
      validation: { n: 80, ev: -9, total_r: -720 },
      holdout: { n: 80, ev: -9, total_r: -720 },
    },
    {
      id: "future-winner",
      development: { n: 200, ev: 0.05, ev_ci95: [-0.05, 0.15] },
      validation: { n: 80, ev: 9, total_r: 720 },
      holdout: { n: 80, ev: 9, total_r: 720 },
    },
  ]);
  assert.equal(selected.id, "development-winner");
  assert.equal(assessSpecialization(selected).status, "validation_failed");
});


test("published plan gate remains a narrow veto-only guardrail", async () => {
  const payload = JSON.parse(await readFile(new URL("../../data/plan-gate-model.json", import.meta.url), "utf8"));
  assert.equal(payload.status, "accepted_limited");
  assert.equal(payload.selection.used_holdout, false);
  assert.equal(payload.deployment.mode, "veto_only");
  assert.deepEqual(payload.deployment.scopes, ["BTCUSDT|1h", "ETHUSDT|4h"]);
  assert.equal(payload.coach_vote_policy.used_holdout, false);
  assert.ok(payload.coach_vote_policy.active_coach_ids.length > 0);
  assert.deepEqual(payload.model.active_vote_features, payload.coach_vote_policy.active_vote_features);
  assert.ok(payload.model.trees.length > 0);
});


test("published coach evidence includes exact recent holdout settlements", async () => {
  const payload = JSON.parse(await readFile(new URL("../../data/coach-training.json", import.meta.url), "utf8"));
  assert.equal(payload.schema, "ev_desk_coach_training_v2");
  const completed = Object.values(payload.experts).filter((expert) => expert.aggregate_holdout.n > 0);
  assert.ok(completed.length >= 14);
  for (const expert of completed) {
    assert.ok(Number.isFinite(expert.aggregate_holdout.scope_weighted_gross_ev));
    assert.ok(Number.isFinite(expert.aggregate_holdout.scope_weighted_cost_r));
    assert.equal(typeof expert.counter_research.selection.selected_without_holdout, "boolean");
    assert.ok(expert.counter_research.development.n > 0);
    assert.ok(expert.counter_research.validation.n > 0);
    assert.ok(expert.counter_research.holdout.n > 0);
    assert.equal(expert.execution_research.candidate_count, 36);
    assert.equal(typeof expert.execution_research.selection.selected_without_holdout, "boolean");
    assert.ok(expert.execution_research.best_candidate_without_holdout);
    assert.ok(expert.execution_research.development.n > 0);
    assert.ok(expert.execution_research.validation.n > 0);
    assert.ok(expert.execution_research.holdout.n > 0);
    assert.ok(expert.execution_research.top_candidates_without_holdout.every((candidate) => !("holdout" in candidate)));
    assert.equal(expert.specialization_research.selection.used_validation, false);
    assert.equal(expert.specialization_research.selection.used_holdout, false);
    assert.ok(expert.specialization_research.top_development_candidates.every((candidate) => !("validation" in candidate) && !("holdout" in candidate)));
    if (!expert.counter_research.selection.selected_without_holdout) assert.equal(expert.counter_research.status, "not_selected");
    if (!expert.execution_research.selection.selected_without_holdout) assert.equal(expert.execution_research.status, "not_selected");
    const populated = Object.values(expert.scopes).map((scope) => scope.holdout).filter((scope) => scope.n > 0);
    assert.ok(populated.length > 0);
    for (const scope of populated) {
      assert.ok(Array.isArray(scope.recent_trades));
      assert.ok(scope.recent_trades.length > 0 && scope.recent_trades.length <= 20);
      assert.ok(scope.recent_trades.every((trade) => Number.isFinite(trade.closed_bar_ts) && Number.isFinite(trade.net_r)));
    }
  }
});


test("published NQ intraday coaches are selected without peeking at holdout", async () => {
  const payload = JSON.parse(await readFile(new URL("../../data/intraday-coaches.json", import.meta.url), "utf8"));
  assert.equal(payload.schema, "ev_desk_intraday_coaches_v1");
  assert.equal(payload.meta.source, "user-supplied NQ continuous 1-minute OHLCV");
  assert.equal(payload.meta.selection, "all parameters selected on development only; validation and holdout cannot change the selected variant");
  assert.equal(payload.meta.raw_rows_published, false);
  assert.deepEqual(payload.active_coach_ids, ["opening_range"]);

  const openingRange = payload.coaches.opening_range;
  assert.equal(openingRange.status, "historically_supported");
  assert.equal(openingRange.selected_on, "development_only");
  assert.equal(openingRange.assessment.deployment, "plan_seat");
  assert.ok(openingRange.validation.n >= 50 && openingRange.validation.ev >= 0.02);
  assert.ok(openingRange.holdout.n >= 50 && openingRange.holdout.ev >= 0.02);
  assert.ok(openingRange.holdout.recent_trades.length > 0 && openingRange.holdout.recent_trades.length <= 20);
  assert.ok(openingRange.holdout.recent_trades.every((trade) => Number.isFinite(trade.closed_bar_ts) && Number.isFinite(trade.net_r)));

  assert.equal(payload.coaches.vwap_pullback.assessment.deployment, "research_seat");
  assert.equal(payload.coaches.vwap_pullback.assessment.holdout_pass, false);
  assert.equal(payload.coaches.opening_failure.assessment.deployment, "research_seat");
  assert.equal(payload.coaches.opening_failure.assessment.validation_pass, false);
});
