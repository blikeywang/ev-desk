import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";


const appPath = new URL("../../app.html", import.meta.url);


test("decision desk ships an interactive candlestick chart, plan overlays and drawing tools", async () => {
  const html = await readFile(appPath, "utf8");
  assert.match(html, /lightweight-charts\.standalone\.production\.js/);
  assert.match(html, /id="decisionChart"/);
  assert.match(html, /id="chartDrawingLayer"/);
  assert.match(html, /data-chart-mode="trend"/);
  assert.match(html, /data-chart-mode="horizontal"/);
  assert.match(html, /function renderDecisionChart\(\)/);
  assert.match(html, /DECISION_SERIES\.candles\.update/);
  assert.match(html, /window\.EVREFERENCE/);
  assert.match(html, /参考进场/);
  assert.match(html, /weightedScore>=\.33&&nl>=2/);
  assert.match(html, /if\(trainedGate&&\(!trainedGate\.authorized\|\|!trainedGate\.available\|\|!trainedGate\.pass\)\)executable=false/);
});


test("first-visit tutorial explains every workspace and remains manually replayable", async () => {
  const html = await readFile(appPath, "utf8");
  assert.match(html, /id="tourLaunch"/);
  assert.match(html, /id="productTour" hidden/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /const TOUR_STEPS=\[/);
  assert.match(html, /selector:"\.decision-chart"/);
  assert.match(html, /selector:"\.opp-hero"/);
  assert.match(html, /selector:"\.arena-hero"/);
  assert.match(html, /selector:"#growthBox"/);
  assert.match(html, /selector:"#meBox"/);
  assert.match(html, /evDeskProductTourV1/);
  assert.match(html, /以后不再自动弹出/);
  assert.match(html, /onclick="startTour\(true\)"/);
  assert.match(html, /reload\(\)\.finally\(maybeStartTour\)/);
  assert.match(html, /教学示例 · 不是当前交易建议/);
  assert.match(html, /主计划是回踩 98 入场、95 止损、104 目标/);
  assert.match(html, /本次 1R 就是最多承担 100 美元/);
  assert.match(html, /62分不是 62% 胜率/);
  assert.match(html, /把 NQ 放入等待清单/);
});


test("radar scans a cross-asset watchlist and exposes trigger filters", async () => {
  const html = await readFile(appPath, "utf8");
  assert.match(html, /data-filter="ready"/);
  assert.match(html, /triggerCode/);
  assert.match(html, /"NQ","QQQ","NVDA","TSLA","SPY","XAUUSD"/);
  assert.match(html, /closedPrimaryCandles\(\)\.at\(-1\)/);
});


test("coach history renders curves, recent settlements and evidence levels", async () => {
  const html = await readFile(appPath, "utf8");
  assert.match(html, /function miniCurveSVG/);
  assert.match(html, /最近 20 笔真实结算/);
  assert.match(html, /镜头等级/);
  assert.match(html, /纪律化组合门控/);
  assert.match(html, /简单反向实验/);
  assert.match(html, /成本感知补救/);
  assert.match(html, /单一岗位考试/);
  assert.match(html, /团队消融实验/);
  assert.match(html, /计划席/);
  assert.match(html, /反向结果单独记账，不替代原专家战绩/);
  assert.match(html, /只否决，不发单/);
  assert.match(html, /当前范围未获授权/);
});


test("NQ and US-stock intraday coverage keeps exact evidence boundaries", async () => {
  const html = await readFile(appPath, "utf8");
  assert.match(html, /data\/intraday-coaches\.js/);
  assert.match(html, /function sessionCoachContext\(\)/);
  assert.match(html, /NQ 日内计划席/);
  assert.match(html, /个股不能继承这项授权/);
  assert.match(html, /\$20\/点.*\$2\/点/);
  assert.match(html, /RTH VWAP/);
  assert.match(html, /result\.auditPlan=/);
  assert.match(html, /forwardStep\(symbol,timeframe,ohlc\.data,CARDS\)/);
});


test("every selectable US market has a deployable fallback snapshot", async () => {
  const symbols = ["AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "TSLA", "AMD", "AVGO", "MU", "SPY", "QQQ", "NDX", "NQ"];
  for (const symbol of symbols) {
    const url = new URL(`../../data/market-snapshots/${symbol}.json`, import.meta.url);
    const payload = JSON.parse(await readFile(url, "utf8"));
    assert.equal(payload.schema, "ev_desk_market_snapshot_v1");
    assert.equal(payload.symbol, symbol);
    for (const timeframe of ["1m", "5m", "15m", "1h", "4h", "1d"]) {
      assert.ok(payload.data[timeframe].length >= 80, `${symbol} ${timeframe} fallback is incomplete`);
    }
  }
});
