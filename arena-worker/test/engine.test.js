import test from "node:test";
import assert from "node:assert/strict";
import {EXPERTS,analyzeExperts,atr,buildPlan,emaSeries,intervalSeconds,rsi} from "../src/engine.js";

function candles(n=240,mode="up"){
  const out=[];
  for(let i=0;i<n;i++){
    const drift=mode==="up"?i*.8:mode==="down"?-i*.8:Math.sin(i/8)*8;
    const base=1000+drift+Math.sin(i/5)*3,o=base-1,c=base+1,h=base+3,l=base-3,v=1000+(i%17===0?900:0);
    out.push([1700000000+i*3600,o,h,l,c,v]);
  }
  return out;
}

test("indicator primitives are deterministic",()=>{
  const c=candles(),cl=c.map(x=>x[4]);
  assert.equal(emaSeries(cl,20).length,cl.length);
  assert.ok(rsi(cl)>50);
  assert.ok(atr(c)>0);
});

test("17 built-in methods and the external Paul Wei identity stay separate",()=>{
  const result=analyzeExperts(candles(),0.0001);
  assert.equal(EXPERTS.length,18);
  assert.equal(result.length,17);
  assert.equal(new Set(result.map(x=>x.id)).size,17);
  assert.equal(result.some(x=>x.id==="paul_wei"),false);
  assert.equal(EXPERTS.find(x=>x.id==="paul_wei").kind,"behavior_model");
  assert.ok(result.every(x=>typeof x.name==="string"&&typeof x.regime==="string"));
});

test("directional experts receive complete positive-risk plans when eligible",()=>{
  const result=analyzeExperts(candles(240,"up"),0.0006);
  const planned=result.filter(x=>x.direction&&x.plan);
  assert.ok(planned.length>0);
  for(const x of planned){
    assert.ok(Number.isFinite(x.plan.entry));
    assert.ok(Number.isFinite(x.plan.stop));
    assert.ok(Number.isFinite(x.plan.target));
    assert.ok(x.plan.rr>=1);
    if(x.direction==="long")assert.ok(x.plan.stop<x.plan.entry&&x.plan.target>x.plan.entry);
    if(x.direction==="short")assert.ok(x.plan.stop>x.plan.entry&&x.plan.target<x.plan.entry);
  }
});

test("timeframe seconds are explicit",()=>{
  assert.equal(intervalSeconds("1m"),60);
  assert.equal(intervalSeconds("15m"),900);
  assert.equal(intervalSeconds("4h"),14400);
});

test("macro direction requires at least two independent inputs",()=>{
  const result=analyzeExperts(candles(),{macro:{dollarChange5d:-0.01,realYieldChange5d:-0.2,vixChange5d:-0.15}});
  const macro=result.find(x=>x.id==="macro");
  assert.equal(macro.direction,"long");
  assert.ok(macro.reason.includes("广义美元"));
});

test("external directions can use the same audited plan builder",()=>{
  const plan=buildPlan("long",candles());
  assert.ok(plan);
  assert.ok(plan.stop<plan.entry&&plan.target>plan.entry&&plan.rr>0);
});

test("insufficient history is rejected",()=>{
  assert.throws(()=>analyzeExperts(candles(50)),/80 candles/);
});
