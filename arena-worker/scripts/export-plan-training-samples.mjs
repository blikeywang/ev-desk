import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createGzip, gunzipSync } from "node:zlib";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { analyzeExperts, atr, buildPlan, emaSeries, rsi } from "../src/engine.js";


const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const EXPERT_IDS = [
  "trend", "dow", "brooks", "wyckoff", "chan", "smc", "ict",
  "levels", "volume_profile", "avwap", "fib", "ichimoku",
  "mean_reversion", "momentum", "grid", "sentiment", "macro",
];


function argsOf(argv) {
  const out = {
    manifest: "/tmp/ev-desk-coach-training/manifest.json",
    output: "/tmp/ev-desk-coach-training/plan-samples.jsonl.gz",
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--manifest") out.manifest = argv[++i];
    else if (argv[i] === "--output") out.output = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return out;
}


const avg = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const std = (values) => {
  const mean = avg(values);
  return Math.sqrt(avg(values.map((value) => (value - mean) ** 2)));
};
const clip = (value, low, high) => Math.max(low, Math.min(high, Number.isFinite(value) ? value : 0));


async function readCanonical(manifestPath, file) {
  const path = isAbsolute(file) ? file : join(dirname(manifestPath), file);
  return JSON.parse(gunzipSync(await readFile(path)).toString("utf8"));
}


function evaluatePlan(candles, signalIndex, direction, plan) {
  let status = "pending";
  let age = 0;
  let held = 0;
  let opened = null;
  const risk = Math.abs(plan.entry - plan.stop);
  if (!(risk > 0)) return null;
  for (let index = signalIndex + 1; index < candles.length; index += 1) {
    const bar = candles[index];
    age += 1;
    if (status === "pending") {
      const touched = bar[3] <= plan.entry && bar[2] >= plan.entry;
      if (!touched) {
        if (age > 12) return null;
        continue;
      }
      status = "active";
      opened = bar[0];
      held = 0;
    }
    held += 1;
    const stopHit = direction === "long" ? bar[3] <= plan.stop : bar[2] >= plan.stop;
    const targetHit = direction === "long" ? bar[2] >= plan.target : bar[3] <= plan.target;
    let grossR = null;
    let reason = null;
    if (stopHit) {
      grossR = -1;
      reason = targetHit ? "same_bar_stop_first" : "stop";
    } else if (targetHit) {
      grossR = plan.rr;
      reason = "target";
    } else if (held >= 30) {
      grossR = direction === "long"
        ? (bar[4] - plan.entry) / risk
        : (plan.entry - bar[4]) / risk;
      reason = "timeout_30";
    }
    if (grossR != null) {
      const costR = plan.entry * 0.001 / risk;
      return {
        net_r: grossR - costR,
        gross_r: grossR,
        cost_r: costR,
        close_reason: reason,
        opened_bar_ts: opened,
        closed_bar_ts: bar[0],
      };
    }
  }
  return null;
}


function featureRow(candles, analysis, direction, plan, scope) {
  const closes = candles.map((bar) => +bar[4]);
  const highs = candles.map((bar) => +bar[2]);
  const lows = candles.map((bar) => +bar[3]);
  const volumes = candles.map((bar) => +bar[5] || 0);
  const price = closes.at(-1);
  const current = candles.at(-1);
  const A = atr(candles) || price * 0.01;
  const ema20 = emaSeries(closes, 20).at(-1);
  const ema50 = emaSeries(closes, 50).at(-1);
  const rangeHigh = Math.max(...highs.slice(-20));
  const rangeLow = Math.min(...lows.slice(-20));
  const range = rangeHigh - rangeLow || A;
  const recentVolume = volumes.slice(-72);
  const volumeStd = std(recentVolume) || 1;
  const directional = analysis.filter((item) => item.direction === "long" || item.direction === "short");
  const long = directional.filter((item) => item.direction === "long");
  const short = directional.filter((item) => item.direction === "short");
  const longWeight = long.reduce((sum, item) => sum + (+item.confidence || 0.3), 0);
  const shortWeight = short.reduce((sum, item) => sum + (+item.confidence || 0.3), 0);
  const totalWeight = longWeight + shortWeight || 1;
  const sign = direction === "long" ? 1 : -1;
  const regime = analysis[0]?.regime || "区间/过渡";
  const timestamp = +current[0];
  const date = new Date(timestamp * 1000);
  const risk = Math.abs(plan.entry - plan.stop);
  const features = {
    direction_sign: sign,
    rr: clip(plan.rr, 0, 8),
    entry_distance_atr: clip(Math.abs(plan.entry - price) / A, 0, 10),
    risk_atr: clip(risk / A, 0, 10),
    target_atr: clip(Math.abs(plan.target - plan.entry) / A, 0, 20),
    atr_pct: clip(A / price, 0, 0.25),
    current_range_atr: clip((current[2] - current[3]) / A, 0, 10),
    close_location: clip((price - current[3]) / Math.max(1e-12, current[2] - current[3]), 0, 1),
    rsi_14: clip(rsi(closes) / 100, 0, 1),
    price_ema20_atr: clip((price - ema20) / A, -12, 12),
    price_ema50_atr: clip((price - ema50) / A, -20, 20),
    ema_spread_atr: clip((ema20 - ema50) / A, -12, 12),
    donchian_position: clip((price - rangeLow) / range, 0, 1),
    return_6: clip(price / closes.at(-7) - 1, -0.5, 0.5),
    return_24: clip(price / closes.at(-25) - 1, -0.8, 0.8),
    volume_z_72: clip((volumes.at(-1) - avg(recentVolume)) / volumeStd, -8, 12),
    vote_edge_relative: clip(sign * (longWeight - shortWeight) / totalWeight, -1, 1),
    vote_count_for: direction === "long" ? long.length : short.length,
    vote_count_against: direction === "long" ? short.length : long.length,
    regime_aligned: ((direction === "long" && regime === "多头趋势") || (direction === "short" && regime === "空头趋势")) ? 1 : 0,
    regime_counter: ((direction === "long" && regime === "空头趋势") || (direction === "short" && regime === "多头趋势")) ? 1 : 0,
    hour_sin: Math.sin(date.getUTCHours() / 24 * Math.PI * 2),
    hour_cos: Math.cos(date.getUTCHours() / 24 * Math.PI * 2),
    weekday_sin: Math.sin(date.getUTCDay() / 7 * Math.PI * 2),
    weekday_cos: Math.cos(date.getUTCDay() / 7 * Math.PI * 2),
    symbol_btc: scope.symbol === "BTCUSDT" ? 1 : 0,
    symbol_eth: scope.symbol === "ETHUSDT" ? 1 : 0,
    symbol_nq: scope.symbol === "NQ" ? 1 : 0,
    symbol_es: scope.symbol === "ES" ? 1 : 0,
    timeframe_15m: scope.timeframe === "15m" ? 1 : 0,
    timeframe_1h: scope.timeframe === "1h" ? 1 : 0,
    timeframe_4h: scope.timeframe === "4h" ? 1 : 0,
  };
  const byId = Object.fromEntries(analysis.map((item) => [item.id, item]));
  for (const expertId of EXPERT_IDS) {
    const vote = byId[expertId];
    const relative = !vote?.direction ? 0 : vote.direction === direction ? 1 : -1;
    features[`vote_${expertId}`] = relative * (+vote?.confidence || 0);
  }
  return features;
}


function splitName(timestamp, split) {
  if (timestamp < split.validation_start) return "development";
  if (timestamp < split.holdout_start) return "validation";
  return "holdout";
}


async function writeLine(gzip, value) {
  if (!gzip.write(JSON.stringify(value) + "\n")) await once(gzip, "drain");
}


async function main() {
  const args = argsOf(process.argv.slice(2));
  const manifestPath = resolve(args.manifest);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const output = createWriteStream(resolve(args.output));
  const gzip = createGzip({ level: 6 });
  gzip.pipe(output);
  let total = 0;
  for (const scope of manifest.scopes) {
    const payload = await readCanonical(manifestPath, scope.file);
    const candles = payload.bars;
    const step = scope.timeframe === "15m" ? 8 : scope.timeframe === "1h" ? 2 : 1;
    let written = 0;
    for (let index = 260; index < candles.length - 42; index += step) {
      const window = candles.slice(index - 259, index + 1);
      const analysis = analyzeExperts(window, {});
      for (const direction of ["long", "short"]) {
        const plan = buildPlan(direction, window);
        if (!plan || plan.rr < 1 || plan.rr > 8) continue;
        const outcome = evaluatePlan(candles, index, direction, plan);
        if (!outcome) continue;
        const signalTs = candles[index][0];
        await writeLine(gzip, {
          symbol: scope.symbol,
          timeframe: scope.timeframe,
          signal_bar_ts: signalTs,
          split: splitName(signalTs, payload.split),
          ...featureRow(window, analysis, direction, plan, scope),
          ...outcome,
        });
        total += 1;
        written += 1;
      }
    }
    process.stdout.write(`Exported ${scope.symbol} ${scope.timeframe}: ${written} executed plan samples\n`);
  }
  gzip.end();
  await once(output, "close");
  console.log(`Wrote ${args.output}: ${total} rows`);
}


if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

