import test from "node:test";
import assert from "node:assert/strict";
import {aggregateSessionCandles,fetchCandles,parseBinanceCandles,parseKrakenCandles,parseOkxCandles,parseYahooCandles,validateScope} from "../src/providers.js";

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

test("Yahoo index candles are parsed and four-hour bars stay inside each session",()=>{
  const start=1_699_920_000,rows=Array.from({length:8},(_,i)=>[start+i*3600,100+i,102+i,99+i,101+i,10]);
  const aggregated=aggregateSessionCandles(rows,4,0);
  assert.equal(aggregated.length,2);
  assert.deepEqual(aggregated[0],[start,100,105,99,104,40]);

  const payload={chart:{result:[{meta:{gmtoffset:0,instrumentType:"INDEX"},timestamp:rows.map(r=>r[0]),indicators:{quote:[{open:rows.map(r=>r[1]),high:rows.map(r=>r[2]),low:rows.map(r=>r[3]),close:rows.map(r=>r[4]),volume:rows.map(r=>r[5])}]}}]}};
  const indexCandles=parseYahooCandles(payload,"4h",1_800_000_000);
  assert.equal(indexCandles.length,2);
  assert.equal(indexCandles[0][5],0);
});

test("US Tech 100 falls back to the delayed index feed without credentials",async()=>{
  const start=1_700_000_000,timestamps=Array.from({length:90},(_,i)=>start+i*3600),values=timestamps.map((_,i)=>100+i);
  const payload={chart:{result:[{meta:{symbol:"^NDX",gmtoffset:-14400},timestamp:timestamps,indicators:{quote:[{open:values,high:values.map(x=>x+1),low:values.map(x=>x-1),close:values,volume:values.map(()=>0)}]}}]}};
  let requested="";
  const fetchImpl=async url=>{requested=String(url);return{ok:true,json:async()=>payload};};
  const result=await fetchCandles("NDX","1h",{limit:80,fetchImpl});
  assert.equal(result.source,"Yahoo Finance delayed");
  assert.equal(result.candles.length,80);
  assert.match(requested,/%5ENDX/);
});
