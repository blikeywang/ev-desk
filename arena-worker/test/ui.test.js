import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";


const appPath = new URL("../../app.html", import.meta.url);


test("decision desk ships its own candlestick canvas and plan overlays", async () => {
  const html = await readFile(appPath, "utf8");
  assert.match(html, /id="decisionChart"/);
  assert.match(html, /function renderDecisionChart\(\)/);
  assert.match(html, /window\.EVREFERENCE/);
  assert.match(html, /参考进场/);
});


test("radar scans a cross-asset watchlist and exposes trigger filters", async () => {
  const html = await readFile(appPath, "utf8");
  assert.match(html, /data-filter="ready"/);
  assert.match(html, /triggerCode/);
  assert.match(html, /"NDX","QQQ","SPY","XAUUSD","WTI"/);
  assert.match(html, /closedPrimaryCandles\(\)\.at\(-1\)/);
});


test("coach history renders curves, recent settlements and evidence levels", async () => {
  const html = await readFile(appPath, "utf8");
  assert.match(html, /function miniCurveSVG/);
  assert.match(html, /最近 20 笔真实结算/);
  assert.match(html, /镜头等级/);
  assert.match(html, /组合计划门控/);
});
