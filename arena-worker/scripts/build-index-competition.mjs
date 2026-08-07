import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ENGINE_VERSION, EXPERTS } from "../src/engine.js";
import { simulateScopeVariants, summarizeTrades } from "./build-evidence.mjs";


const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_DATA_DIR = resolve(ROOT, "../../US/market_data/tradingview/snapshots/2026-07-15-long");
const DEFAULT_NQ_ONE_MINUTE = resolve(DEFAULT_DATA_DIR, "../2026-07-15-nq-1y-1m/nq_1m.csv");
const DEFAULT_START = "2025-07-15T00:00:00.000Z";
const DEFAULT_END = "2026-07-15T04:00:00.000Z";
const DEFAULT_VALIDATION_START = "2026-02-01T00:00:00.000Z";
const DEFAULT_HOLDOUT_START = "2026-05-01T00:00:00.000Z";
const TIMEFRAMES = Object.freeze({ "15m": 900, "1h": 3600, "4h": 14400 });
const CONTRACTS = Object.freeze({
  NQ: {
    file: "nq_5m.csv",
    point_value_usd: 20,
    tick_points: 0.25,
    slippage_ticks_each_side: 1,
    commission_round_trip_usd: 5,
    round_trip_points: 0.75,
    specification: "https://www.cmegroup.com/markets/equities/nasdaq/e-mini-nasdaq-100.contractSpecs.html",
  },
  ES: {
    file: "es_5m.csv",
    point_value_usd: 50,
    tick_points: 0.25,
    slippage_ticks_each_side: 1,
    commission_round_trip_usd: 5,
    round_trip_points: 0.60,
    specification: "https://www.cmegroup.com/markets/equities/sp/e-mini-sandp500.contractSpecs.html",
  },
});


const round = (value, digits = 3) => Number.isFinite(value) ? +value.toFixed(digits) : null;


function argsOf(argv) {
  const out = {
    dataDir: process.env.TV_FUTURES_DIR || DEFAULT_DATA_DIR,
    nqOneMinute: process.env.TV_NQ_1M_PATH || DEFAULT_NQ_ONE_MINUTE,
    start: DEFAULT_START,
    end: DEFAULT_END,
    validationStart: DEFAULT_VALIDATION_START,
    holdoutStart: DEFAULT_HOLDOUT_START,
    output: join(ROOT, "data/index-coach-competition.json"),
    jsOutput: join(ROOT, "data/index-coach-competition.js"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`Unknown argument: ${key}`);
    const name = key.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (!(name in out)) throw new Error(`Unknown argument: ${key}`);
    out[name] = argv[++index];
  }
  return out;
}


function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}


function iso(seconds) {
  return new Date(seconds * 1000).toISOString();
}


export function parseTradingViewCsv(raw, symbol, expectedIntervalSeconds = 300) {
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  const lines = text.trim().split(/\r?\n/);
  if (lines.shift()?.trim() !== "timestamp,open,high,low,close,volume") {
    throw new Error(`${symbol}: unexpected CSV header`);
  }
  const rows = [];
  let duplicates = 0;
  let nonMonotonic = 0;
  let invalidOhlc = 0;
  let scheduledGaps = 0;
  let maximumGapSeconds = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const row = lines[index].split(",").map(Number);
    if (row.length !== 6 || row.some((value) => !Number.isFinite(value))) {
      throw new Error(`${symbol}: invalid numeric row ${index + 2}`);
    }
    const [timestamp, open, high, low, close, volume] = row;
    if (!(timestamp > 0 && low <= Math.min(open, close) && high >= Math.max(open, close) && high >= low && volume >= 0)) invalidOhlc += 1;
    if (rows.length) {
      const gap = timestamp - rows.at(-1)[0];
      if (gap === 0) duplicates += 1;
      if (gap < 0) nonMonotonic += 1;
      if (gap !== expectedIntervalSeconds) scheduledGaps += 1;
      maximumGapSeconds = Math.max(maximumGapSeconds, gap);
    }
    rows.push(row);
  }
  if (!rows.length) throw new Error(`${symbol}: empty CSV`);
  if (duplicates || nonMonotonic || invalidOhlc) {
    throw new Error(`${symbol}: quality failure duplicates=${duplicates}, non_monotonic=${nonMonotonic}, invalid_ohlc=${invalidOhlc}`);
  }
  return {
    rows,
    quality: {
      rows: rows.length,
      first: iso(rows[0][0]),
      through: iso(rows.at(-1)[0]),
      duplicates,
      non_monotonic: nonMonotonic,
      invalid_ohlc: invalidOhlc,
      scheduled_or_market_gaps: scheduledGaps,
      maximum_gap_seconds: maximumGapSeconds,
      gaps_filled: false,
    },
  };
}


export function auditSameBarCollisions(trades, oneMinuteRows) {
  const minuteByTimestamp = new Map(oneMinuteRows.map((row) => [row[0], row]));
  const collisions = trades.filter((trade) => trade.close_reason === "same_bar_stop_first");
  const audit = {
    collisions: collisions.length,
    covered: 0,
    stop_first: 0,
    target_first: 0,
    intraminute_ambiguous: 0,
    unresolved_or_missing: 0,
  };
  for (const trade of collisions) {
    const seconds = TIMEFRAMES[trade.timeframe];
    const minutes = [];
    for (let timestamp = trade.closed_bar_ts; timestamp < trade.closed_bar_ts + seconds; timestamp += 60) {
      const row = minuteByTimestamp.get(timestamp);
      if (row) minutes.push(row);
    }
    if (!minutes.length) {
      audit.unresolved_or_missing += 1;
      continue;
    }
    audit.covered += 1;
    let entered = trade.opened_bar_ts < trade.closed_bar_ts;
    let outcome = null;
    for (const minute of minutes) {
      const entryTouched = minute[3] <= trade.entry && minute[2] >= trade.entry;
      const stopHit = trade.direction === "long" ? minute[3] <= trade.stop : minute[2] >= trade.stop;
      const targetHit = trade.direction === "long" ? minute[2] >= trade.target : minute[3] <= trade.target;
      if (!entered) {
        if (!entryTouched) continue;
        if (stopHit || targetHit) {
          outcome = "intraminute_ambiguous";
          break;
        }
        entered = true;
        continue;
      }
      if (stopHit && targetHit) outcome = "intraminute_ambiguous";
      else if (stopHit) outcome = "stop_first";
      else if (targetHit) outcome = "target_first";
      if (outcome) break;
    }
    if (outcome) audit[outcome] += 1;
    else audit.unresolved_or_missing += 1;
  }
  return audit;
}


export function aggregateBars(rows, seconds) {
  const buckets = new Map();
  for (const row of rows) {
    const timestamp = Math.floor(row[0] / seconds) * seconds;
    const current = buckets.get(timestamp);
    if (current) {
      current[2] = Math.max(current[2], row[2]);
      current[3] = Math.min(current[3], row[3]);
      current[4] = row[4];
      current[5] += row[5];
    } else {
      buckets.set(timestamp, [timestamp, row[1], row[2], row[3], row[4], row[5]]);
    }
  }
  return [...buckets.values()].sort((left, right) => left[0] - right[0]);
}


function splitRows(rows, split) {
  return {
    development: rows.filter((row) => row.signal_bar_ts < split.validation_start),
    validation: rows.filter((row) => row.signal_bar_ts >= split.validation_start && row.signal_bar_ts < split.holdout_start),
    holdout: rows.filter((row) => row.signal_bar_ts >= split.holdout_start),
  };
}


function recentTrades(rows) {
  return [...rows]
    .sort((left, right) => left.closed_bar_ts - right.closed_bar_ts || left.symbol.localeCompare(right.symbol) || left.timeframe.localeCompare(right.timeframe))
    .slice(-20)
    .map((row) => ({
      symbol: row.symbol,
      timeframe: row.timeframe,
      closed_bar_ts: row.closed_bar_ts,
      direction: row.direction,
      net_r: round(row.net_r),
      close_reason: row.close_reason,
      regime: row.regime,
    }));
}


function detailedSummary(rows, includeRecent = false) {
  const ordered = [...rows].sort((left, right) => left.closed_bar_ts - right.closed_bar_ts || left.symbol.localeCompare(right.symbol) || left.timeframe.localeCompare(right.timeframe));
  const summary = summarizeTrades(ordered);
  if (includeRecent) summary.recent_trades = recentTrades(ordered);
  return summary;
}


function balancedSummary(scopeRows, part, includeRecent = false) {
  const scopeSummaries = [];
  const allRows = [];
  for (const record of scopeRows) {
    const rows = record.parts[part];
    if (!rows.length) continue;
    allRows.push(...rows);
    scopeSummaries.push(detailedSummary(rows));
  }
  const combined = detailedSummary(allRows, includeRecent);
  const mean = (key) => scopeSummaries.length
    ? scopeSummaries.reduce((sum, summary) => sum + (+summary[key] || 0), 0) / scopeSummaries.length
    : null;
  return {
    ...combined,
    eligible_scopes: scopeSummaries.length,
    scope_weighted_ev: round(mean("ev")),
    scope_weighted_gross_ev: round(mean("gross_ev")),
    scope_weighted_cost_r: round(mean("avg_cost_r")),
    positive_scope_pct: scopeSummaries.length ? round(scopeSummaries.filter((summary) => summary.ev > 0).length / scopeSummaries.length * 100, 1) : null,
  };
}


function subsetSummary(scopeRows, predicate, part) {
  return balancedSummary(scopeRows.filter(predicate), part);
}


function competitionStatus(validation, holdout) {
  if (!holdout.n) return { status: "not_scored", label: "未形成交易", permission: "none" };
  if (validation.n < 20 || holdout.n < 20 || validation.eligible_scopes < 2 || holdout.eligible_scopes < 2) {
    return { status: "low_sample", label: "样本偏少", permission: "none" };
  }
  const validationPass = validation.scope_weighted_ev >= 0.03 && validation.positive_scope_pct >= 60 && validation.total_r > 0;
  const holdoutPass = holdout.scope_weighted_ev >= 0.03 && holdout.positive_scope_pct >= 60 && holdout.total_r > 0;
  if (validationPass && holdoutPass) {
    return { status: "historically_supported", label: "通过历史门槛", permission: "forward_arena_only" };
  }
  if (holdout.scope_weighted_ev >= 0) return { status: "mixed", label: "留出转正，验证未过", permission: "none" };
  return { status: "downweight", label: "负期望降权", permission: "none" };
}


function absentReason(expert) {
  if (expert.id === "grid") return "网格只判断是否适合区间执行，不产生独立多空方向。";
  if (expert.id === "sentiment") return "情绪教练需要历史资金费率、持仓量与拥挤度，OHLCV不能替代。";
  if (expert.id === "macro") return "宏观教练需要美元、实际利率、VIX与流动性历史，OHLCV不能替代。";
  return "固定规则在本届最终留出阶段没有形成可结算计划。";
}


function coachRecord(expert, scopeRows) {
  const development = balancedSummary(scopeRows, "development");
  const validation = balancedSummary(scopeRows, "validation");
  const holdout = balancedSummary(scopeRows, "holdout", true);
  const fullYear = balancedSummary(scopeRows, "all");
  const assessment = competitionStatus(validation, holdout);
  return {
    id: expert.id,
    name: expert.name,
    school: expert.school,
    version: expert.version,
    ...assessment,
    rank: null,
    reason: holdout.n ? null : absentReason(expert),
    development,
    validation,
    holdout,
    full_year: fullYear,
    by_symbol: Object.fromEntries(Object.keys(CONTRACTS).map((symbol) => [symbol, {
      holdout: subsetSummary(scopeRows, (record) => record.symbol === symbol, "holdout"),
      full_year: subsetSummary(scopeRows, (record) => record.symbol === symbol, "all"),
    }])),
    by_timeframe: Object.fromEntries(Object.keys(TIMEFRAMES).map((timeframe) => [timeframe, {
      holdout: subsetSummary(scopeRows, (record) => record.timeframe === timeframe, "holdout"),
      full_year: subsetSummary(scopeRows, (record) => record.timeframe === timeframe, "all"),
    }])),
    scopes: Object.fromEntries(scopeRows.map((record) => [record.key, {
      development: detailedSummary(record.parts.development),
      validation: detailedSummary(record.parts.validation),
      holdout: detailedSummary(record.parts.holdout),
      full_year: detailedSummary(record.parts.all),
    }])),
  };
}


function rankCoaches(coaches) {
  const ranked = coaches
    .filter((coach) => !["not_scored", "low_sample"].includes(coach.status))
    .sort((left, right) => (right.holdout.scope_weighted_ev ?? -Infinity) - (left.holdout.scope_weighted_ev ?? -Infinity)
      || (right.holdout.positive_scope_pct ?? -Infinity) - (left.holdout.positive_scope_pct ?? -Infinity)
      || right.holdout.total_r - left.holdout.total_r
      || left.name.localeCompare(right.name, "zh-CN"));
  ranked.forEach((coach, index) => { coach.rank = index + 1; });
  return [
    ...ranked,
    ...coaches.filter((coach) => coach.status === "low_sample").sort((left, right) => left.name.localeCompare(right.name, "zh-CN")),
    ...coaches.filter((coach) => coach.status === "not_scored").sort((left, right) => left.name.localeCompare(right.name, "zh-CN")),
  ];
}


function assertAligned(inputs) {
  const [first, ...rest] = Object.values(inputs);
  const timestamps = first.rows.map((row) => row[0]);
  for (const input of rest) {
    if (input.rows.length !== timestamps.length) throw new Error("NQ and ES row counts are not aligned");
    for (let index = 0; index < timestamps.length; index += 1) {
      if (input.rows[index][0] !== timestamps[index]) throw new Error(`NQ and ES timestamps diverge at row ${index + 2}`);
    }
  }
}


export async function buildIndexCompetition(options = {}) {
  const start = Date.parse(options.start || DEFAULT_START) / 1000;
  const end = Date.parse(options.end || DEFAULT_END) / 1000;
  const validationStart = Date.parse(options.validationStart || DEFAULT_VALIDATION_START) / 1000;
  const holdoutStart = Date.parse(options.holdoutStart || DEFAULT_HOLDOUT_START) / 1000;
  if (![start, end, validationStart, holdoutStart].every(Number.isFinite) || !(start < validationStart && validationStart < holdoutStart && holdoutStart < end)) {
    throw new Error("Competition timestamps must be chronological: start < validation < holdout < end");
  }
  const dataDir = resolve(options.dataDir || process.env.TV_FUTURES_DIR || DEFAULT_DATA_DIR);
  const inputs = {};
  for (const [symbol, contract] of Object.entries(CONTRACTS)) {
    const file = join(dataDir, contract.file);
    const raw = await readFile(file);
    const parsed = parseTradingViewCsv(raw, symbol);
    inputs[symbol] = { ...parsed, file, sha256: sha256(raw) };
  }
  assertAligned(inputs);

  const methodExperts = EXPERTS.filter((expert) => expert.kind === "method_lens");
  const rowsByExpert = new Map(methodExperts.map((expert) => [expert.id, []]));
  const scopeRecords = [];
  const nqCompetitionTrades = [];
  for (const [symbol, contract] of Object.entries(CONTRACTS)) {
    const sourceRows = inputs[symbol].rows.filter((row) => row[0] < end);
    for (const [timeframe, seconds] of Object.entries(TIMEFRAMES)) {
      const bars = aggregateBars(sourceRows, seconds);
      const competitionBars = bars.filter((row) => row[0] >= start && row[0] < end);
      process.stdout.write(`Competing ${symbol} ${timeframe} (${competitionBars.length} scored bars)... `);
      const costModel = { type: "fixed_points", round_trip_points: contract.round_trip_points };
      const trades = simulateScopeVariants(
        bars,
        [],
        { symbol, timeframe },
        { includeStandard: true, includeCounter: false, costModel },
      ).standard.filter((trade) => trade.signal_bar_ts >= start && trade.signal_bar_ts < end);
      if (symbol === "NQ") nqCompetitionTrades.push(...trades);
      const grouped = new Map(methodExperts.map((expert) => [expert.id, []]));
      for (const trade of trades) grouped.get(trade.expert_id)?.push(trade);
      const split = { validation_start: validationStart, holdout_start: holdoutStart };
      for (const expert of methodExperts) {
        const rows = grouped.get(expert.id);
        rowsByExpert.get(expert.id).push({
          key: `${symbol}|${timeframe}`,
          symbol,
          timeframe,
          parts: { ...splitRows(rows, split), all: rows },
        });
      }
      scopeRecords.push({
        symbol,
        timeframe,
        source_timeframe: "5m",
        warmup_bars: bars.filter((row) => row[0] < start).length,
        bars: competitionBars.length,
        from: competitionBars.length ? iso(competitionBars[0][0]) : null,
        through: competitionBars.length ? iso(competitionBars.at(-1)[0]) : null,
        plans_settled: trades.length,
      });
      process.stdout.write(`${trades.length} settled plans\n`);
    }
  }

  const coaches = methodExperts.map((expert) => coachRecord(expert, rowsByExpert.get(expert.id)));
  const leaderboard = rankCoaches(coaches);
  const participants = leaderboard.filter((coach) => coach.rank != null);
  const supported = participants.filter((coach) => coach.status === "historically_supported");
  const positive = participants.filter((coach) => coach.holdout.scope_weighted_ev >= 0);
  const lowSample = leaderboard.filter((coach) => coach.status === "low_sample");
  const notScored = leaderboard.filter((coach) => coach.status === "not_scored");
  const winner = participants[0] || null;
  let oneMinuteAudit = { available: false, reason: "NQ one-minute QA file was not supplied; competition scoring remains conservative." };
  const oneMinutePath = resolve(options.nqOneMinute || DEFAULT_NQ_ONE_MINUTE);
  try {
    const raw = await readFile(oneMinutePath);
    const parsed = parseTradingViewCsv(raw, "NQ-1m", 60);
    const audit = auditSameBarCollisions(nqCompetitionTrades, parsed.rows.filter((row) => row[0] >= start && row[0] < end));
    oneMinuteAudit = {
      available: true,
      file_sha256: sha256(raw),
      quality: parsed.quality,
      ...audit,
      use: "Quality audit only. Scores retain the conservative source-bar stop-first rule so NQ and ES use equal information.",
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    oneMinuteAudit = { available: false, reason: `NQ one-minute QA file not found at ${oneMinutePath}; scores remain conservative.` };
  }
  const sourceQuality = Object.fromEntries(Object.entries(inputs).map(([symbol, input]) => [symbol, {
    ...input.quality,
    sha256: input.sha256,
    competition_rows: input.rows.filter((row) => row[0] >= start && row[0] < end).length,
    competition_first: iso(input.rows.find((row) => row[0] >= start)?.[0]),
    competition_through: iso([...input.rows].reverse().find((row) => row[0] < end)?.[0]),
  }]));
  const body = {
    schema: "ev_desk_index_coach_competition_v1",
    meta: {
      generated_at: new Date().toISOString(),
      engine_version: ENGINE_VERSION,
      source: "User-supplied TradingView Desktop exports for CME_MINI:NQ1! and CME_MINI:ES1!",
      source_snapshot: "2026-07-15-long",
      window: { start: iso(start), end_exclusive: iso(end), label: "2025-07-15 至 2026-07-15" },
      timeframes: Object.keys(TIMEFRAMES),
      split: {
        development: `${iso(start)} to ${iso(validationStart)}`,
        validation: `${iso(validationStart)} to ${iso(holdoutStart)}`,
        final_holdout: `${iso(holdoutStart)} to ${iso(end)}`,
        validation_start: validationStart,
        holdout_start: holdoutStart,
        attribution: "Split by signal timestamp; no random shuffle and no future bars are visible to a signal.",
      },
      ranking: {
        primary: "Equal-weight mean final-holdout EV across NQ/ES x 15m/1h/4h scopes with at least one settled plan.",
        eligibility: "A ranked coach needs at least 20 validation trades, 20 final-holdout trades, and two scored scopes in each stage.",
        historical_threshold: "Validation and final holdout must each reach at least +0.03R scope-weighted EV, 60% positive scopes, and positive combined total R.",
        tie_breakers: ["positive final-holdout scope percentage", "final-holdout total R", "coach name"],
        boundary: "Rank is descriptive. Even first place receives no live plan permission unless the published historical threshold and a separate forward arena both pass.",
      },
      execution: {
        risk_unit: "Every settled plan risks 1R from entry to structural stop; no compounding or leverage advantage.",
        signal: "Closed bars only; a plan may fill from the next bar onward.",
        pending_expiry_bars: 12,
        maximum_hold_bars: 30,
        ambiguous_same_bar: "Stop first, including an entry/stop/target collision, because 5-minute source bars do not reveal intrabar path equally for NQ and ES.",
        position_policy: "At most one pending or active plan per coach x symbol x timeframe.",
        friction_assumption: "One minimum tick of slippage on entry and exit plus USD 5.00 round-trip commission per E-mini contract.",
        contracts: Object.fromEntries(Object.entries(CONTRACTS).map(([symbol, contract]) => [symbol, {
          point_value_usd: contract.point_value_usd,
          tick_points: contract.tick_points,
          slippage_ticks_each_side: contract.slippage_ticks_each_side,
          commission_round_trip_usd: contract.commission_round_trip_usd,
          round_trip_points: contract.round_trip_points,
          specification: contract.specification,
        }])),
      },
      quality: {
        aligned_timestamp_rows: true,
        gaps_preserved: true,
        raw_rows_published: false,
        continuous_contract_boundary: "TradingView continuous front-month symbols are used as supplied; results are a chart-history simulation, not contract-level broker fills.",
        inputs: sourceQuality,
        nq_one_minute_path_audit: oneMinuteAudit,
      },
      scopes: scopeRecords,
      paul_wei_boundary: "Paul Wei remains a BTC/XBT behavior model. Durable behavior can coach sequencing, but it is not substituted for a deterministic NQ/ES PnL strategy.",
    },
    summary: {
      roster: methodExperts.length,
      ranked: participants.length,
      low_sample: lowSample.length,
      not_scored: notScored.length,
      positive_final_holdout: positive.length,
      passed_historical_threshold: supported.length,
      winner: winner ? {
        id: winner.id,
        name: winner.name,
        ev: winner.holdout.scope_weighted_ev,
        total_r: winner.holdout.total_r,
        n: winner.holdout.n,
        status: winner.status,
      } : null,
    },
    leaderboard,
  };
  body.meta.content_hash = sha256(JSON.stringify({
    schema: body.schema,
    engine_version: body.meta.engine_version,
    window: body.meta.window,
    quality: body.meta.quality,
    scopes: body.meta.scopes,
    leaderboard: body.leaderboard,
  }));
  return body;
}


async function main() {
  const args = argsOf(process.argv.slice(2));
  const result = await buildIndexCompetition(args);
  await writeFile(resolve(args.output), JSON.stringify(result, null, 2) + "\n");
  await writeFile(resolve(args.jsOutput), `window.EV_DESK_DATA=window.EV_DESK_DATA||{};window.EV_DESK_DATA.indexCompetition=${JSON.stringify(result)};\n`);
  console.log(`Wrote ${args.output}`);
  console.log(`Wrote ${args.jsOutput}`);
  console.log(`Index competition evidence hash ${result.meta.content_hash}`);
}


const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) main().catch((error) => { console.error(error); process.exitCode = 1; });
