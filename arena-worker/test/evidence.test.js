import test from "node:test";
import assert from "node:assert/strict";
import {simulateScope,summarizeTrades} from "../scripts/build-evidence.mjs";

function candles(n=420){
  const out=[];for(let i=0;i<n;i++){const wave=Math.sin(i/18)*28,trend=i*.15,base=1000+wave+trend,o=base-Math.sin(i)*3,c=base+Math.cos(i/3)*4,h=Math.max(o,c)+9,l=Math.min(o,c)-9,v=1000+(i%23===0?1500:0);out.push([1700000000+i*3600,o,h,l,c,v]);}return out;
}

test("historical simulator emits only future-bar settlements",()=>{
  const rows=simulateScope(candles(),[],{symbol:"TESTUSDT",timeframe:"1h"});
  assert.ok(rows.length>0);
  assert.ok(rows.every(x=>x.opened_bar_ts>x.signal_bar_ts));
  assert.ok(rows.every(x=>Number.isFinite(x.net_r)&&x.cost_r>0));
});

test("evidence summary exposes uncertainty and drawdown",()=>{
  const rows=[1,-1,.5,-.25].map((r,i)=>({net_r:r,opened_bar_ts:100+i,closed_bar_ts:200+i,regime:i<2?"trend":"range"})),s=summarizeTrades(rows);
  assert.equal(s.n,4);
  assert.equal(s.win,50);
  assert.equal(s.win_ci95.length,2);
  assert.ok(s.mdd<=0);
  assert.equal(Object.keys(s.regimes).length,2);
});
