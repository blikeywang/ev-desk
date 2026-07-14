import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { analyzeExperts, buildPlan, ENGINE_VERSION, EXPERTS } from "../src/engine.js";
import { simulateScope, summarizeTrades } from "./build-evidence.mjs";


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
    return { status: "pending", scopes: 0, n: 0, scope_weighted_ev: null, positive_scope_pct: null, prior_multiplier: 1 };
  }
  const weighted = eligible.map((item) => ({ item, weight: Math.sqrt(Math.min(item.n, 400)) }));
  const weight = weighted.reduce((sum, row) => sum + row.weight, 0);
  const ev = weighted.reduce((sum, row) => sum + row.item.ev * row.weight, 0) / weight;
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
    positive_scope_pct: round(positive * 100, 1),
    prior_multiplier: round(multiplier, 3),
  };
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
  }]));
  const scopeRecords = [];
  const globalConsensus = new Map(CONSENSUS_CONFIGS.map((config) => [config.id, []]));

  for (const scope of manifest.scopes) {
    process.stdout.write(`Calibrating ${scope.symbol} ${scope.timeframe} (${scope.bars} bars)... `);
    const payload = await readCanonical(manifestPath, scope.file);
    const trades = simulateScope(payload.bars, [], { symbol: scope.symbol, timeframe: scope.timeframe });
    const consensusReports = simulateConsensusCandidates(
      payload.bars,
      { symbol: scope.symbol, timeframe: scope.timeframe },
      payload.split,
    );
    for (const report of consensusReports) globalConsensus.get(report.config.id).push(report);
    const selectedConsensus = chooseConsensusCandidate(consensusReports);
    const grouped = Object.fromEntries(methodExperts.map((expert) => [expert.id, []]));
    for (const trade of trades) {
      if (grouped[trade.expert_id]) grouped[trade.expert_id].push(trade);
    }
    const splitCounts = { development: 0, validation: 0, holdout: 0 };
    for (const expert of methodExperts) {
      const rows = grouped[expert.id];
      const split = splitRows(rows, payload.split);
      const record = {
        development: summarizeTrades(split.development),
        validation: summarizeTrades(split.validation),
        holdout: summarizeTrades(split.holdout, { includeRecent: true }),
        all: summarizeTrades(rows),
      };
      record.holdout.prior_multiplier = scopePrior(record.holdout);
      experts[expert.id].scopes[`${scope.symbol}|${scope.timeframe}`] = record;
      splitCounts.development += split.development.length;
      splitCounts.validation += split.validation.length;
      splitCounts.holdout += split.holdout.length;
    }
    scopeRecords.push({
      symbol: scope.symbol,
      timeframe: scope.timeframe,
      bars: scope.bars,
      from: scope.from,
      through: scope.through,
      split: payload.split,
      trades: trades.length,
      split_trades_all_methods: splitCounts,
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
    const summaries = Object.values(experts[expert.id].scopes).map((scope) => scope.holdout);
    experts[expert.id].aggregate_holdout = aggregatePrior(summaries);
    if (expert.id === "sentiment") {
      experts[expert.id].calibration_boundary = "Supplied OI/positioning metrics are profiled, but funding-rate history was not present in this package; existing official funding evidence remains separate.";
    } else if (expert.id === "macro") {
      experts[expert.id].calibration_boundary = "Requires historical FRED features; OHLCV alone is not used to fabricate macro calls.";
    } else if (expert.id === "grid") {
      experts[expert.id].calibration_boundary = "Grid is an execution suitability lens and intentionally emits no directional plan in the fixed engine.";
    }
  }

  const body = {
    schema: "ev_desk_coach_training_v1",
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
