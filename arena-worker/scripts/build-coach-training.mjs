import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { analyzeExperts, buildPlan, ENGINE_VERSION, EXPERTS } from "../src/engine.js";
import { simulateScopeVariants, summarizeTrades } from "./build-evidence.mjs";


const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");


function argsOf(argv) {
  const out = {
    manifest: "/tmp/ev-desk-coach-training/manifest.json",
    output: join(ROOT, "data/coach-training.json"),
    jsOutput: join(ROOT, "data/coach-training.js"),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--manifest") out.manifest = argv[++i];
    else if (key === "--output") out.output = argv[++i];
    else if (key === "--js-output") out.jsOutput = argv[++i];
    else throw new Error(`Unknown argument: ${key}`);
  }
  return out;
}


const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const round = (value, digits = 3) => Number.isFinite(value) ? +value.toFixed(digits) : null;


export function scopePrior(summary) {
  if (!summary || summary.n < 20 || !Number.isFinite(summary.ev)) return 1;
  const reliability = summary.n / (summary.n + 100);
  const ci = summary.ev_ci95 || [];
  const sameSign = ci.length === 2 && ((ci[0] > 0 && ci[1] > 0) || (ci[0] < 0 && ci[1] < 0));
  const evidence = sameSign ? 1 : 0.35;
  return round(clamp(1 + clamp(summary.ev, -0.5, 0.5) * 0.20 * reliability * evidence, 0.92, 1.08), 3);
}


export function aggregatePrior(scopeSummaries) {
  const eligible = scopeSummaries.filter((item) => item && item.n >= 20 && Number.isFinite(item.ev));
  if (!eligible.length) {
    return { status: "pending", scopes: 0, n: 0, scope_weighted_ev: null, scope_weighted_gross_ev: null, scope_weighted_cost_r: null, positive_scope_pct: null, prior_multiplier: 1 };
  }
  const weighted = eligible.map((item) => ({ item, weight: Math.sqrt(Math.min(item.n, 400)) }));
  const weight = weighted.reduce((sum, row) => sum + row.weight, 0);
  const ev = weighted.reduce((sum, row) => sum + row.item.ev * row.weight, 0) / weight;
  const weightedMetric = (key) => {
    const rows = weighted.filter((row) => Number.isFinite(row.item[key]));
    const total = rows.reduce((sum, row) => sum + row.weight, 0);
    return total ? rows.reduce((sum, row) => sum + row.item[key] * row.weight, 0) / total : null;
  };
  const grossEv = weightedMetric("gross_ev");
  const costR = weightedMetric("avg_cost_r");
  const n = eligible.reduce((sum, item) => sum + item.n, 0);
  const positive = eligible.filter((item) => item.ev > 0).length / eligible.length;
  const reliability = (n / (n + 300)) * Math.min(1, eligible.length / 6);
  const multiplier = clamp(1 + clamp(ev, -0.5, 0.5) * 0.20 * reliability + (positive - 0.5) * 0.02, 0.90, 1.10);
  const status = ev > 0.05 && positive >= 0.60 ? "supported" : ev < -0.05 && positive <= 0.40 ? "downweight" : "mixed";
  return {
    status,
    scopes: eligible.length,
    n,
    scope_weighted_ev: round(ev, 3),
    scope_weighted_gross_ev: round(grossEv, 3),
    scope_weighted_cost_r: round(costR, 3),
    positive_scope_pct: round(positive * 100, 1),
    prior_multiplier: round(multiplier, 3),
  };
}


export const COUNTER_SELECTION_CRITERIA = Object.freeze({
  min_scopes: 4,
  min_trades_per_split: 200,
  max_source_ev: -0.05,
  min_counter_ev: 0.03,
  min_positive_scope_pct: 55,
});


export const EXECUTION_REMEDY_CONFIGS = [];
for (const maxCostR of [0.12, 0.18, 0.25, 0.35]) {
  for (const minRr of [1.20, 1.50, 2.00]) {
    for (const regimePolicy of ["all", "not_countertrend", "aligned"]) {
      EXECUTION_REMEDY_CONFIGS.push({
        id: `cost${String(maxCostR).replace(".", "")}-rr${String(minRr).replace(".", "")}-${regimePolicy}`,
        max_cost_r: maxCostR,
        min_rr: minRr,
        regime_policy: regimePolicy,
      });
    }
  }
}


function compactTradeSummary(rows) {
  const summary = summarizeTrades(rows);
  return Object.fromEntries(["n", "win", "ev", "gross_ev", "avg_cost_r", "ev_ci95", "pf", "mdd", "total_r"]
    .map((key) => [key, summary[key]]));
}


function executionRemedyPass(row, config) {
  if (!(Number.isFinite(row.cost_r) && row.cost_r <= config.max_cost_r)) return false;
  if (!(Number.isFinite(row.rr) && row.rr >= config.min_rr)) return false;
  return config.regime_policy === "all" || regimePass(config.regime_policy, row.direction, row.regime);
}


function executionRemedyScore(report) {
  const development = report.development;
  const validation = report.validation;
  const criteria = COUNTER_SELECTION_CRITERIA;
  if (!development || !validation || development.scopes < criteria.min_scopes || validation.scopes < criteria.min_scopes
    || development.n < criteria.min_trades_per_split || validation.n < criteria.min_trades_per_split) return -Infinity;
  const stability = Math.min(development.scope_weighted_ev, validation.scope_weighted_ev);
  const average = (development.scope_weighted_ev + validation.scope_weighted_ev) / 2;
  const breadth = Math.min(development.positive_scope_pct, validation.positive_scope_pct);
  return stability + average * 0.20 + (breadth - 50) * 0.001;
}


export function chooseExecutionRemedy(reports) {
  return [...reports].sort((left, right) => executionRemedyScore(right) - executionRemedyScore(left))[0] || null;
}


export const SPECIALIZATION_CRITERIA = Object.freeze({
  min_development_trades: 100,
  min_validation_trades: 40,
  min_holdout_trades: 40,
  min_validation_ev: 0.03,
  min_holdout_ev: 0.03,
});


function specializationDevelopmentScore(report) {
  const development = report && report.development;
  if (!development || development.n < SPECIALIZATION_CRITERIA.min_development_trades || !Number.isFinite(development.ev)) return -Infinity;
  const ci = development.ev_ci95 || [];
  const standardError = ci.length === 2 && ci.every(Number.isFinite) ? (ci[1] - ci[0]) / 3.92 : 1 / Math.sqrt(development.n);
  return development.ev - standardError;
}


export function chooseSpecialization(reports) {
  return [...reports].sort((left, right) => specializationDevelopmentScore(right) - specializationDevelopmentScore(left))[0] || null;
}


export function assessSpecialization(report) {
  if (!report || !Number.isFinite(specializationDevelopmentScore(report))) {
    return { status: "no_candidate", validation_pass: false, holdout_pass: false, reasons: ["开发集没有足够样本"] };
  }
  const criteria = SPECIALIZATION_CRITERIA;
  const validation = report.validation || {};
  const holdout = report.holdout || {};
  const validationReasons = [];
  if (!(validation.n >= criteria.min_validation_trades)) validationReasons.push("验证集样本不足");
  if (!(validation.ev >= criteria.min_validation_ev)) validationReasons.push("验证集期望未达门槛");
  if (!(validation.total_r > 0)) validationReasons.push("验证集累计R未转正");
  const validationPass = validationReasons.length === 0;
  const holdoutReasons = [];
  if (!(holdout.n >= criteria.min_holdout_trades)) holdoutReasons.push("最终留出样本不足");
  if (!(holdout.ev >= criteria.min_holdout_ev)) holdoutReasons.push("最终留出期望未达门槛");
  if (!(holdout.total_r > 0)) holdoutReasons.push("最终留出累计R未转正");
  const holdoutPass = holdoutReasons.length === 0;
  return {
    status: !validationPass ? "validation_failed" : !holdoutPass ? "holdout_failed" : "historically_supported",
    validation_pass: validationPass,
    holdout_pass: holdoutPass,
    reasons: [...validationReasons, ...(validationPass ? holdoutReasons : [])],
  };
}


function executionRemedySelection(report) {
  if (!report) return { selected_without_holdout: false, reasons: ["没有候选策略"] };
  const criteria = COUNTER_SELECTION_CRITERIA;
  const reasons = [];
  for (const [label, summary] of [["开发集", report.development], ["验证集", report.validation]]) {
    if (!summary || summary.scopes < criteria.min_scopes || summary.n < criteria.min_trades_per_split) reasons.push(`${label}样本不足`);
    else {
      if (!(summary.scope_weighted_ev >= criteria.min_counter_ev)) reasons.push(`${label}期望未达门槛`);
      if (!(summary.positive_scope_pct >= criteria.min_positive_scope_pct)) reasons.push(`${label}正向范围不足`);
    }
  }
  return {
    selected_without_holdout: reasons.length === 0,
    selection_score: round(executionRemedyScore(report), 4),
    reasons,
  };
}


export function chooseCounterExperiment(sourceDevelopment, sourceValidation, counterDevelopment, counterValidation) {
  const criteria = COUNTER_SELECTION_CRITERIA;
  const reasons = [];
  for (const [label, summary] of [["原策略开发集", sourceDevelopment], ["原策略验证集", sourceValidation]]) {
    if (!summary || summary.scopes < criteria.min_scopes || summary.n < criteria.min_trades_per_split) reasons.push(`${label}样本不足`);
    else if (!(summary.scope_weighted_ev <= criteria.max_source_ev)) reasons.push(`${label}并非稳定负期望`);
  }
  for (const [label, summary] of [["反策略开发集", counterDevelopment], ["反策略验证集", counterValidation]]) {
    if (!summary || summary.scopes < criteria.min_scopes || summary.n < criteria.min_trades_per_split) reasons.push(`${label}样本不足`);
    else {
      if (!(summary.scope_weighted_ev >= criteria.min_counter_ev)) reasons.push(`${label}期望未达门槛`);
      if (!(summary.positive_scope_pct >= criteria.min_positive_scope_pct)) reasons.push(`${label}正向范围不足`);
    }
  }
  return {
    selected_without_holdout: reasons.length === 0,
    criteria,
    reasons,
  };
}


function counterHoldoutStatus(selection, holdout) {
  if (!selection.selected_without_holdout) return "not_selected";
  if (!holdout || holdout.scopes < COUNTER_SELECTION_CRITERIA.min_scopes || holdout.n < COUNTER_SELECTION_CRITERIA.min_trades_per_split) return "holdout_insufficient";
  return holdout.scope_weighted_ev >= COUNTER_SELECTION_CRITERIA.min_counter_ev
    && holdout.positive_scope_pct >= COUNTER_SELECTION_CRITERIA.min_positive_scope_pct
    ? "holdout_supported"
    : "holdout_failed";
}


async function readCanonical(manifestPath, file) {
  const path = isAbsolute(file) ? file : join(dirname(manifestPath), file);
  const compressed = await readFile(path);
  return JSON.parse(gunzipSync(compressed).toString("utf8"));
}


function splitRows(rows, split) {
  return {
    development: rows.filter((row) => row.signal_bar_ts < split.validation_start),
    validation: rows.filter((row) => row.signal_bar_ts >= split.validation_start && row.signal_bar_ts < split.holdout_start),
    holdout: rows.filter((row) => row.signal_bar_ts >= split.holdout_start),
  };
}


const CONSENSUS_CONFIGS = [];
for (const minVotes of [2, 3, 4]) {
  for (const minEdge of [0.25, 0.40]) {
    for (const minRr of [1.20, 1.50]) {
      for (const regimePolicy of ["not_countertrend", "aligned"]) {
        CONSENSUS_CONFIGS.push({
          id: `v${minVotes}-e${String(minEdge).replace(".", "")}-r${String(minRr).replace(".", "")}-${regimePolicy}`,
          min_votes: minVotes,
          min_edge: minEdge,
          min_rr: minRr,
          regime_policy: regimePolicy,
        });
      }
    }
  }
}


function settleConsensus(state, bar, grossR, reason, exit) {
  const risk = Math.abs(state.entry - state.stop) || 1;
  const costR = state.entry * 0.001 / risk;
  return {
    expert_id: "trained_consensus",
    config_id: state.config_id,
    symbol: state.symbol,
    timeframe: state.timeframe,
    direction: state.direction,
    regime: state.regime,
    signal_bar_ts: state.signal_bar_ts,
    opened_bar_ts: state.entry_bar_ts || bar[0],
    closed_bar_ts: bar[0],
    entry: state.entry,
    exit,
    stop: state.stop,
    target: state.target,
    gross_r: grossR,
    cost_r: costR,
    net_r: grossR - costR,
    close_reason: reason,
    model_version: "consensus-gate-v1",
  };
}


function advanceConsensus(state, bar) {
  if (!state || bar[0] <= state.signal_bar_ts) return { state, trade: null };
  const next = { ...state, age: (state.age || 0) + 1 };
  if (next.status === "pending") {
    const touched = bar[3] <= next.entry && bar[2] >= next.entry;
    if (!touched) return next.age > 12 ? { state: null, trade: null } : { state: next, trade: null };
    next.status = "active";
    next.entry_bar_ts = bar[0];
    next.held = 0;
  }
  next.held = (next.held || 0) + 1;
  const stopHit = next.direction === "long" ? bar[3] <= next.stop : bar[2] >= next.stop;
  const targetHit = next.direction === "long" ? bar[2] >= next.target : bar[3] <= next.target;
  if (stopHit) {
    return { state: null, trade: settleConsensus(next, bar, -1, targetHit ? "same_bar_stop_first" : "stop", next.stop) };
  }
  if (targetHit) {
    return { state: null, trade: settleConsensus(next, bar, next.rr, "target", next.target) };
  }
  if (next.held >= 30) {
    const gross = next.direction === "long"
      ? (bar[4] - next.entry) / Math.abs(next.entry - next.stop)
      : (next.entry - bar[4]) / Math.abs(next.stop - next.entry);
    return { state: null, trade: settleConsensus(next, bar, gross, "timeout_30", bar[4]) };
  }
  return { state: next, trade: null };
}


function regimePass(policy, direction, regime) {
  const aligned = (direction === "long" && regime === "多头趋势")
    || (direction === "short" && regime === "空头趋势");
  if (policy === "aligned") return aligned;
  const counter = (direction === "long" && regime === "空头趋势")
    || (direction === "short" && regime === "多头趋势");
  return !counter;
}


function selectionScore(report) {
  const development = report.development;
  const validation = report.validation;
  if (development.n < 50 || validation.n < 30) return -Infinity;
  const stability = Math.min(development.ev, validation.ev);
  const average = (development.ev + validation.ev) / 2;
  const drawdownPenalty = Math.abs(validation.mdd || 0) / Math.sqrt(Math.max(1, validation.n)) * 0.002;
  return stability + average * 0.25 - drawdownPenalty;
}


function summarizeConsensusCandidates(rowsByConfig, split) {
  return CONSENSUS_CONFIGS.map((config) => {
    const rows = rowsByConfig.get(config.id) || [];
    const parts = splitRows(rows, split);
    const report = {
      config,
      development: summarizeTrades(parts.development),
      validation: summarizeTrades(parts.validation),
      holdout: summarizeTrades(parts.holdout),
      all: summarizeTrades(rows),
    };
    report.selection_score = round(selectionScore(report), 4);
    return report;
  });
}


export function chooseConsensusCandidate(reports) {
  const ranked = [...reports].sort((left, right) => selectionScore(right) - selectionScore(left));
  return ranked[0] || null;
}


function simulateConsensusCandidates(candles, scope, split) {
  const states = new Map(CONSENSUS_CONFIGS.map((config) => [config.id, null]));
  const rows = new Map(CONSENSUS_CONFIGS.map((config) => [config.id, []]));
  for (let index = 80; index < candles.length; index += 1) {
    const bar = candles[index];
    for (const config of CONSENSUS_CONFIGS) {
      const result = advanceConsensus(states.get(config.id), bar);
      states.set(config.id, result.state);
      if (result.trade) rows.get(config.id).push(result.trade);
    }
    const window = candles.slice(Math.max(0, index - 259), index + 1);
    const analysis = analyzeExperts(window, {});
    const directional = analysis.filter((item) => item.direction === "long" || item.direction === "short");
    const long = directional.filter((item) => item.direction === "long");
    const short = directional.filter((item) => item.direction === "short");
    const longWeight = long.reduce((sum, item) => sum + (+item.confidence || 0.3), 0);
    const shortWeight = short.reduce((sum, item) => sum + (+item.confidence || 0.3), 0);
    const totalWeight = longWeight + shortWeight;
    if (!totalWeight || longWeight === shortWeight) continue;
    const direction = longWeight > shortWeight ? "long" : "short";
    const winnerVotes = direction === "long" ? long.length : short.length;
    const edge = Math.abs(longWeight - shortWeight) / totalWeight;
    const regime = analysis[0]?.regime || "区间/过渡";
    const plan = buildPlan(direction, window);
    if (!plan) continue;
    for (const config of CONSENSUS_CONFIGS) {
      if (states.get(config.id)) continue;
      if (winnerVotes < config.min_votes || edge < config.min_edge || plan.rr < config.min_rr) continue;
      if (!regimePass(config.regime_policy, direction, regime)) continue;
      states.set(config.id, {
        config_id: config.id,
        symbol: scope.symbol,
        timeframe: scope.timeframe,
        direction,
        regime,
        signal_bar_ts: bar[0],
        entry: plan.entry,
        stop: plan.stop,
        target: plan.target,
        rr: plan.rr,
        status: "pending",
        age: 0,
        held: 0,
      });
    }
  }
  return summarizeConsensusCandidates(rows, split);
}


function balancedSplit(reports, splitName) {
  const eligible = reports.map((report) => report[splitName]).filter((item) => item && item.n >= 20);
  if (!eligible.length) return { scopes: 0, n: 0, ev: null, positive_scope_pct: null };
  const weights = eligible.map((item) => Math.sqrt(Math.min(item.n, 400)));
  const weight = weights.reduce((sum, value) => sum + value, 0);
  const ev = eligible.reduce((sum, item, index) => sum + item.ev * weights[index], 0) / weight;
  return {
    scopes: eligible.length,
    n: eligible.reduce((sum, item) => sum + item.n, 0),
    ev: round(ev, 3),
    positive_scope_pct: round(eligible.filter((item) => item.ev > 0).length / eligible.length * 100, 1),
  };
}


function chooseGlobalConsensus(globalCandidates) {
  const reports = CONSENSUS_CONFIGS.map((config) => {
    const scopes = globalCandidates.get(config.id) || [];
    const development = balancedSplit(scopes, "development");
    const validation = balancedSplit(scopes, "validation");
    const holdout = balancedSplit(scopes, "holdout");
    const score = development.scopes >= 4 && validation.scopes >= 4
      ? Math.min(development.ev, validation.ev) + (development.ev + validation.ev) * 0.125
      : -Infinity;
    return { config, development, validation, holdout, selection_score: round(score, 4) };
  });
  return reports.sort((left, right) => right.selection_score - left.selection_score)[0];
}


function hashEvidence(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}


export async function buildCoachTraining(manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const methodExperts = EXPERTS.filter((expert) => expert.kind === "method_lens");
  const experts = Object.fromEntries(methodExperts.map((expert) => [expert.id, {
    id: expert.id,
    name: expert.name,
    school: expert.school,
    version: expert.version,
    scopes: {},
    counter_scopes: {},
  }]));
  const scopeRecords = [];
  const globalConsensus = new Map(CONSENSUS_CONFIGS.map((config) => [config.id, []]));
  const executionResearch = new Map(methodExperts.map((expert) => [expert.id, new Map(EXECUTION_REMEDY_CONFIGS.map((config) => [config.id, []]))]));

  for (const scope of manifest.scopes) {
    process.stdout.write(`Calibrating ${scope.symbol} ${scope.timeframe} (${scope.bars} bars)... `);
    const payload = await readCanonical(manifestPath, scope.file);
    const variants = simulateScopeVariants(payload.bars, [], { symbol: scope.symbol, timeframe: scope.timeframe }, { includeStandard: true, includeCounter: true });
    const trades = variants.standard;
    const counterTrades = variants.counter;
    const consensusReports = simulateConsensusCandidates(
      payload.bars,
      { symbol: scope.symbol, timeframe: scope.timeframe },
      payload.split,
    );
    for (const report of consensusReports) globalConsensus.get(report.config.id).push(report);
    const selectedConsensus = chooseConsensusCandidate(consensusReports);
    const grouped = Object.fromEntries(methodExperts.map((expert) => [expert.id, []]));
    const counterGrouped = Object.fromEntries(methodExperts.map((expert) => [expert.id, []]));
    for (const trade of trades) {
      if (grouped[trade.expert_id]) grouped[trade.expert_id].push(trade);
    }
    for (const trade of counterTrades) {
      if (counterGrouped[trade.expert_id]) counterGrouped[trade.expert_id].push(trade);
    }
    const splitCounts = { development: 0, validation: 0, holdout: 0 };
    const counterSplitCounts = { development: 0, validation: 0, holdout: 0 };
    for (const expert of methodExperts) {
      const rows = grouped[expert.id];
      const split = splitRows(rows, payload.split);
      const counterRows = counterGrouped[expert.id];
      const counterSplit = splitRows(counterRows, payload.split);
      const scopeKey = `${scope.symbol}|${scope.timeframe}`;
      const record = {
        development: summarizeTrades(split.development),
        validation: summarizeTrades(split.validation),
        holdout: summarizeTrades(split.holdout, { includeRecent: true }),
        all: summarizeTrades(rows),
      };
      record.holdout.prior_multiplier = scopePrior(record.holdout);
      experts[expert.id].scopes[scopeKey] = record;
      experts[expert.id].counter_scopes[scopeKey] = {
        development: compactTradeSummary(counterSplit.development),
        validation: compactTradeSummary(counterSplit.validation),
        holdout: compactTradeSummary(counterSplit.holdout),
        all: compactTradeSummary(counterRows),
      };
      for (const config of EXECUTION_REMEDY_CONFIGS) {
        executionResearch.get(expert.id).get(config.id).push({
          scope: scopeKey,
          development: compactTradeSummary(split.development.filter((row) => executionRemedyPass(row, config))),
          validation: compactTradeSummary(split.validation.filter((row) => executionRemedyPass(row, config))),
          holdout: compactTradeSummary(split.holdout.filter((row) => executionRemedyPass(row, config))),
        });
      }
      splitCounts.development += split.development.length;
      splitCounts.validation += split.validation.length;
      splitCounts.holdout += split.holdout.length;
      counterSplitCounts.development += counterSplit.development.length;
      counterSplitCounts.validation += counterSplit.validation.length;
      counterSplitCounts.holdout += counterSplit.holdout.length;
    }
    scopeRecords.push({
      symbol: scope.symbol,
      timeframe: scope.timeframe,
      bars: scope.bars,
      from: scope.from,
      through: scope.through,
      split: payload.split,
      trades: trades.length,
      counter_trades: counterTrades.length,
      split_trades_all_methods: splitCounts,
      counter_split_trades_all_methods: counterSplitCounts,
      consensus_model: selectedConsensus ? {
        selected_without_holdout: selectedConsensus.config,
        selection_score: selectedConsensus.selection_score,
        development: selectedConsensus.development,
        validation: selectedConsensus.validation,
        holdout: selectedConsensus.holdout,
        top_candidates_without_holdout: [...consensusReports]
          .sort((left, right) => selectionScore(right) - selectionScore(left))
          .slice(0, 3)
          .map((item) => ({
            config: item.config,
            selection_score: item.selection_score,
            development: item.development,
            validation: item.validation,
          })),
      } : null,
    });
    process.stdout.write(`${trades.length} lens plans; consensus holdout EV ${selectedConsensus?.holdout?.ev ?? "n/a"}R\n`);
  }

  for (const expert of methodExperts) {
    const standardScopes = Object.values(experts[expert.id].scopes);
    const counterScopes = Object.values(experts[expert.id].counter_scopes);
    experts[expert.id].aggregate_holdout = aggregatePrior(standardScopes.map((scope) => scope.holdout));
    const sourceDevelopment = aggregatePrior(standardScopes.map((scope) => scope.development));
    const sourceValidation = aggregatePrior(standardScopes.map((scope) => scope.validation));
    const counterDevelopment = aggregatePrior(counterScopes.map((scope) => scope.development));
    const counterValidation = aggregatePrior(counterScopes.map((scope) => scope.validation));
    const counterHoldout = aggregatePrior(counterScopes.map((scope) => scope.holdout));
    const selection = chooseCounterExperiment(sourceDevelopment, sourceValidation, counterDevelopment, counterValidation);
    experts[expert.id].counter_research = {
      variant: "counter_structural_v1",
      definition: "Use the original lens only as a contrarian direction trigger, then build a fresh opposite-direction structural entry, stop, and target.",
      selection,
      source_development: sourceDevelopment,
      source_validation: sourceValidation,
      development: counterDevelopment,
      validation: counterValidation,
      holdout: counterHoldout,
      status: counterHoldoutStatus(selection, counterHoldout),
    };
    const executionCandidates = EXECUTION_REMEDY_CONFIGS.map((config) => {
      const scopeReports = executionResearch.get(expert.id).get(config.id);
      return {
        config,
        development: aggregatePrior(scopeReports.map((report) => report.development)),
        validation: aggregatePrior(scopeReports.map((report) => report.validation)),
        holdout: aggregatePrior(scopeReports.map((report) => report.holdout)),
        scope_reports: scopeReports,
      };
    });
    const specializationCandidates = executionCandidates.flatMap((candidate) => candidate.scope_reports.map((scopeReport) => ({
      scope: scopeReport.scope,
      config: candidate.config,
      development: scopeReport.development,
      validation: scopeReport.validation,
      holdout: scopeReport.holdout,
    })));
    const bestSpecialization = chooseSpecialization(specializationCandidates);
    const specializationAssessment = assessSpecialization(bestSpecialization);
    experts[expert.id].specialization_research = bestSpecialization ? {
      variant: "development_selected_specialist_v1",
      definition: "Select exactly one market, timeframe, cost ceiling, minimum reward/risk, and regime policy using development only; validation and final holdout may reject it but can never choose a replacement.",
      candidate_count: specializationCandidates.length,
      criteria: SPECIALIZATION_CRITERIA,
      selected_on_development: {
        scope: bestSpecialization.scope,
        ...bestSpecialization.config,
        selection_score: round(specializationDevelopmentScore(bestSpecialization), 4),
      },
      selection: {
        used_validation: false,
        used_holdout: false,
      },
      development: bestSpecialization.development,
      validation: bestSpecialization.validation,
      holdout: bestSpecialization.holdout,
      assessment: specializationAssessment,
      deployment: specializationAssessment.status === "historically_supported" ? "forward_arena_only" : "disabled",
      top_development_candidates: [...specializationCandidates]
        .sort((left, right) => specializationDevelopmentScore(right) - specializationDevelopmentScore(left))
        .slice(0, 3)
        .map((candidate) => ({
          scope: candidate.scope,
          config: candidate.config,
          selection_score: round(specializationDevelopmentScore(candidate), 4),
          development: candidate.development,
        })),
    } : null;
    const bestExecution = chooseExecutionRemedy(executionCandidates);
    const executionSelection = executionRemedySelection(bestExecution);
    experts[expert.id].execution_research = bestExecution ? {
      variant: "cost_aware_abstention_v1",
      definition: "Keep the original direction, but abstain when round-trip cost consumes too much risk, structural reward is too low, or the configured regime policy rejects the plan.",
      candidate_count: EXECUTION_REMEDY_CONFIGS.length,
      best_candidate_without_holdout: bestExecution.config,
      selection: executionSelection,
      development: bestExecution.development,
      validation: bestExecution.validation,
      holdout: bestExecution.holdout,
      status: counterHoldoutStatus(executionSelection, bestExecution.holdout),
      scopes: Object.fromEntries(bestExecution.scope_reports.map((report) => [report.scope, {
        development: report.development,
        validation: report.validation,
        holdout: report.holdout,
      }])),
      top_candidates_without_holdout: [...executionCandidates]
        .sort((left, right) => executionRemedyScore(right) - executionRemedyScore(left))
        .slice(0, 3)
        .map((candidate) => ({
          config: candidate.config,
          selection_score: round(executionRemedyScore(candidate), 4),
          development: candidate.development,
          validation: candidate.validation,
        })),
    } : null;
    if (expert.id === "sentiment") {
      experts[expert.id].calibration_boundary = "Supplied OI/positioning metrics are profiled, but funding-rate history was not present in this package; existing official funding evidence remains separate.";
    } else if (expert.id === "macro") {
      experts[expert.id].calibration_boundary = "Requires historical FRED features; OHLCV alone is not used to fabricate macro calls.";
    } else if (expert.id === "grid") {
      experts[expert.id].calibration_boundary = "Grid is an execution suitability lens and intentionally emits no directional plan in the fixed engine.";
    }
  }

  const body = {
    schema: "ev_desk_coach_training_v2",
    meta: {
      generated_at: new Date().toISOString(),
      engine_version: ENGINE_VERSION,
      source: manifest.source_set,
      content_boundary: "Publishable aggregates only; raw orders, executions, IDs, and minute rows remain local.",
      methodology: {
        split: "chronological development / validation / final holdout; no random shuffle",
        signal_time: "closed bars only; current and earlier bars available",
        execution: "pending 12 bars, maximum hold 30 bars, same-bar stop first, 0.10% round-trip cost",
        calibration: "fixed expert rules are not tuned on holdout; holdout EV only supplies a conservative 0.90x-1.10x prior",
        counter_research: "Opposite-direction candidates are selected with development and validation only; final holdout is disclosed after selection and never enables a candidate retroactively.",
        execution_research: "Cost/R, minimum-RR, and regime abstention candidates are selected with development and validation only; holdout is disclosed after selection and cannot relax activation criteria.",
        specialization_research: "A single specialist role is selected from market x timeframe x cost x RR x regime candidates using development only. Validation is a one-shot exam and final holdout is a one-shot audit; neither may select a replacement.",
        growth_boundary: "historical calibration is not expert growth; only forward-sealed arena results may update growth",
        paul_boundary: "Paul Wei is a separate behavior model supervised by action labels; method-lens PnL is not substituted for his record",
      },
      scopes: scopeRecords,
      trained_consensus: {
        version: "consensus-gate-v1",
        selection_boundary: "Thresholds selected with development and validation only; final holdout is read once after selection.",
        candidates: CONSENSUS_CONFIGS.length,
        global: chooseGlobalConsensus(globalConsensus),
      },
      quality: manifest.quality,
      sources: manifest.sources,
    },
    paul_wei: manifest.paul_wei,
    experts,
  };
  body.meta.content_hash = hashEvidence({
    schema: body.schema,
    engine_version: body.meta.engine_version,
    scopes: body.meta.scopes,
    paul_wei: body.paul_wei,
    experts: body.experts,
  });
  return body;
}


async function main() {
  const args = argsOf(process.argv.slice(2));
  const result = await buildCoachTraining(resolve(args.manifest));
  await writeFile(resolve(args.output), JSON.stringify(result, null, 2) + "\n");
  await writeFile(resolve(args.jsOutput), `window.EV_DESK_DATA=window.EV_DESK_DATA||{};window.EV_DESK_DATA.coachTraining=${JSON.stringify(result)};\n`);
  console.log(`Wrote ${args.output}`);
  console.log(`Wrote ${args.jsOutput}`);
  console.log(`Training evidence hash ${result.meta.content_hash}`);
}


if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
