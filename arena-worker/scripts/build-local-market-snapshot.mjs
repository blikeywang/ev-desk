#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";


function args(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) values[argv[index].replace(/^--/, "")] = argv[index + 1];
  return values;
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines.shift().split(",").map((item) => item.trim().toLowerCase());
  const at = Object.fromEntries(headers.map((name, index) => [name, index]));
  return lines.map((line) => line.split(",")).map((cells) => [
    Number(cells[at.timestamp]), Number(cells[at.open]), Number(cells[at.high]),
    Number(cells[at.low]), Number(cells[at.close]), Number(cells[at.volume] || 0),
  ]).filter((row) => row.every(Number.isFinite) && row[1] > 0 && row[2] >= row[3] && row[3] > 0);
}

function aggregate(rows, seconds, offset = 0) {
  const bars = new Map();
  for (const row of rows) {
    const bucket = Math.floor((row[0] - offset) / seconds) * seconds + offset;
    const current = bars.get(bucket);
    if (!current) bars.set(bucket, [bucket, ...row.slice(1)]);
    else {
      current[2] = Math.max(current[2], row[2]);
      current[3] = Math.min(current[3], row[3]);
      current[4] = row[4];
      current[5] += row[5];
    }
  }
  return [...bars.values()].sort((left, right) => left[0] - right[0]);
}

const options = args(process.argv.slice(2));
for (const required of ["symbol", "one-minute", "five-minute", "output"]) {
  if (!options[required]) throw new Error(`Missing --${required}`);
}

const oneMinute = parseCsv(await readFile(resolve(options["one-minute"]), "utf8"));
const fiveMinute = parseCsv(await readFile(resolve(options["five-minute"]), "utf8"));
const latest = fiveMinute.at(-1);
const limit = (rows) => rows.slice(-500);
const sessionOffset = 23 * 3600;
const data = {
  "1m": limit(oneMinute),
  "5m": limit(fiveMinute),
  "15m": limit(aggregate(fiveMinute, 15 * 60, sessionOffset)),
  "1h": limit(aggregate(fiveMinute, 60 * 60, sessionOffset)),
  "4h": limit(aggregate(fiveMinute, 4 * 60 * 60, sessionOffset)),
  "1d": limit(aggregate(fiveMinute, 24 * 60 * 60, sessionOffset)),
};
for (const [timeframe, rows] of Object.entries(data)) {
  if (rows.length < 80) throw new Error(`${timeframe} has only ${rows.length} rows`);
}
const symbol = options.symbol.toUpperCase();
const payload = {
  schema: "ev_desk_market_snapshot_v1",
  symbol,
  ticker: options.ticker || `${symbol}=F`,
  source: "Owner-provided TradingView export snapshot",
  generatedAt: new Date().toISOString(),
  market: {
    exchange: options.exchange || "CME",
    state: "CLOSED_SNAPSHOT",
    asOf: latest[0] * 1000,
    price: latest[4],
    previousClose: null,
    change: null,
    instrumentType: "FUTURE",
    sourceFiles: [basename(options["one-minute"]), basename(options["five-minute"])],
  },
  data,
};
await writeFile(resolve(options.output), JSON.stringify(payload) + "\n", "utf8");
console.log(`${symbol} snapshot: ${Object.entries(data).map(([key, rows]) => `${key}=${rows.length}`).join(" ")}`);
