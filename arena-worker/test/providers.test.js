import test from "node:test";
import assert from "node:assert/strict";
import {parseBinanceCandles,parseKrakenCandles,parseOkxCandles,validateScope} from "../src/providers.js";

test("scope validation rejects provider-controlled input",()=>{
  assert.deepEqual(validateScope("BTCUSDT","4h"),{symbol:"BTCUSDT",timeframe:"4h"});
  assert.throws(()=>validateScope("BTC-USDT","4h"),/invalid market scope/);
  assert.throws(()=>validateScope("BTCUSDT","7h"),/invalid market scope/);
});

test("Binance parser keeps only closed candles",()=>{
  const now=1_800_000_000_000,rows=[
    [1_700_000_000_000,"1","2","0.5","1.5","10",1_700_003_599_999],
    [1_800_000_000_000,"1","2","0.5","1.5","10",1_800_003_599_999]
  ];
  assert.equal(parseBinanceCandles(rows,now).length,1);
});

test("OKX confirm flag and Kraken close time are respected",()=>{
  const okx=parseOkxCandles([
    ["1700000000000","1","2","0.5","1.5","10","0","0","1"],
    ["1700003600000","1","2","0.5","1.5","10","0","0","0"]
  ],"1h",1_800_000_000);
  assert.equal(okx.length,1);
  const kraken=parseKrakenCandles([[1_700_000_000,"1","2","0.5","1.5","0","10"]],"1h",1_700_004_000);
  assert.equal(kraken.length,1);
});
