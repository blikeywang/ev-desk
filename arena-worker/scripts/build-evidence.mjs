import {createHash} from "node:crypto";
import {mkdir,writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {ENGINE_VERSION,EXPERTS,analyzeExperts,intervalSeconds} from "../src/engine.js";

const HERE=path.dirname(fileURLToPath(import.meta.url));
const ROOT=path.resolve(HERE,"../..");
const DEFAULT_DAYS={"15m":180,"1h":730,"4h":1095};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const round=(x,n=4)=>Number.isFinite(x)?+x.toFixed(n):null;
const mean=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;

function argsOf(argv){
  const out={symbols:"BTCUSDT,ETHUSDT,SOLUSDT",timeframes:"15m,1h,4h",output:path.join(ROOT,"data/expert-evidence.json"),jsOutput:path.join(ROOT,"data/expert-evidence.js"),end:null,quick:false};
  for(let i=0;i<argv.length;i++){
    const a=argv[i];if(a==="--quick")out.quick=true;else if(a.startsWith("--")){const k=a.slice(2).replace(/-([a-z])/g,(_,c)=>c.toUpperCase());out[k]=argv[++i];}
  }
  return out;
}

async function fetchJson(url,timeout=20000){
  const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),timeout);
  try{const r=await fetch(url,{signal:ctl.signal,headers:{accept:"application/json","user-agent":"ev-desk-evidence/1.0"}});if(!r.ok)throw new Error(`HTTP ${r.status}`);return await r.json();}finally{clearTimeout(timer);}
}

async function binance(pathname,query){
  const qs=new URLSearchParams(query).toString(),errors=[];
  for(const base of ["https://api.binance.com","https://data-api.binance.vision"]){
    try{return await fetchJson(`${base}${pathname}?${qs}`);}catch(e){errors.push(`${new URL(base).hostname}: ${e?.message||e}`);}
  }
  throw new Error(errors.join(" | "));
}

export async function downloadCandles(symbol,timeframe,startMs,endMs){
  const rows=[];let cursor=startMs;
  while(cursor<endMs){
    const page=await binance("/api/v3/klines",{symbol,interval:timeframe,startTime:String(cursor),endTime:String(endMs),limit:"1000"});
    if(!Array.isArray(page)||!page.length)break;
    for(const r of page)if(+r[6]<endMs)rows.push([Math.floor(+r[0]/1000),+r[1],+r[2],+r[3],+r[4],+r[5]]);
    const next=+page.at(-1)[0]+intervalSeconds(timeframe)*1000;if(next<=cursor)break;cursor=next;
    if(page.length<1000)break;await sleep(60);
  }
  return [...new Map(rows.map(r=>[r[0],r])).values()].sort((a,b)=>a[0]-b[0]);
}

export async function downloadFunding(symbol,startMs,endMs){
  const rows=[];let cursor=startMs;
  while(cursor<endMs){
    let page;
    try{page=await fetchJson(`https://fapi.binance.com/fapi/v1/fundingRate?${new URLSearchParams({symbol,startTime:String(cursor),endTime:String(endMs),limit:"1000"})}`);}catch(e){return rows;}
    if(!Array.isArray(page)||!page.length)break;
    page.forEach(x=>rows.push([Math.floor(+x.fundingTime/1000),+x.fundingRate]));
    const next=+page.at(-1).fundingTime+1;if(next<=cursor)break;cursor=next;
    if(page.length<1000)break;await sleep(80);
  }
  return [...new Map(rows.map(r=>[r[0],r])).values()].sort((a,b)=>a[0]-b[0]);
}

function settle(state,bar,grossR,reason,exit){
  const risk=Math.abs(state.entry-state.stop)||1,costR=state.entry*.001/risk;
  return{expert_id:state.expert_id,symbol:state.symbol,timeframe:state.timeframe,direction:state.direction,regime:state.regime,signal_bar_ts:state.signal_bar_ts,opened_bar_ts:state.entry_bar_ts||bar[0],closed_bar_ts:bar[0],entry:state.entry,exit,stop:state.stop,target:state.target,gross_r:grossR,cost_r:costR,net_r:grossR-costR,close_reason:reason,model_version:state.model_version};
}

function advance(state,bar){
  if(!state||bar[0]<=state.signal_bar_ts)return{state,trade:null};
  let s={...state,age:(state.age||0)+1};
  if(s.status==="pending"){
    const touched=bar[3]<=s.entry&&bar[2]>=s.entry;
    if(!touched)return s.age>12?{state:null,trade:null}:{state:s,trade:null};
    s.status="active";s.entry_bar_ts=bar[0];s.held=0;
  }
  s.held=(s.held||0)+1;
  const stopHit=s.direction==="long"?bar[3]<=s.stop:bar[2]>=s.stop,targetHit=s.direction==="long"?bar[2]>=s.target:bar[3]<=s.target;
  if(stopHit)return{state:null,trade:settle(s,bar,-1,targetHit?"same_bar_stop_first":"stop",s.stop)};
  if(targetHit)return{state:null,trade:settle(s,bar,s.rr,"target",s.target)};
  if(s.held>=30){const gross=s.direction==="long"?(bar[4]-s.entry)/Math.abs(s.entry-s.stop):(s.entry-bar[4])/Math.abs(s.stop-s.entry);return{state:null,trade:settle(s,bar,gross,"timeout_30",bar[4])};}
  return{state:s,trade:null};
}

export function simulateScope(candles,fundingRows=[],scope={symbol:"TESTUSDT",timeframe:"1h"}){
  const states={},trades=[],funding=[...fundingRows].sort((a,b)=>a[0]-b[0]);let fundingIndex=-1,currentFunding=null;
  for(let i=80;i<candles.length;i++){
    const bar=candles[i];while(fundingIndex+1<funding.length&&funding[fundingIndex+1][0]<=bar[0])currentFunding=funding[++fundingIndex][1];
    for(const id of Object.keys(states)){
      const result=advance(states[id],bar);if(result.trade)trades.push(result.trade);if(result.state)states[id]=result.state;else delete states[id];
    }
    const window=candles.slice(Math.max(0,i-259),i+1),analysis=analyzeExperts(window,{fundingRate:currentFunding});
    for(const x of analysis){
      if(states[x.id]||!x.direction||!x.plan||x.plan.rr<1)continue;
      states[x.id]={expert_id:x.id,symbol:scope.symbol,timeframe:scope.timeframe,direction:x.direction,regime:x.regime,signal_bar_ts:bar[0],entry:x.plan.entry,stop:x.plan.stop,target:x.plan.target,rr:x.plan.rr,model_version:x.version,status:"pending",age:0,held:0};
    }
  }
  return trades;
}

function wilson(wins,n,z=1.96){
  if(!n)return[0,0];const p=wins/n,den=1+z*z/n,center=(p+z*z/(2*n))/den,margin=z*Math.sqrt((p*(1-p)+z*z/(4*n))/n)/den;return[center-margin,center+margin];
}
function downsample(curve,max=80){
  if(curve.length<=max)return curve.map(x=>round(x,3));const out=[];for(let i=0;i<max;i++)out.push(round(curve[Math.min(curve.length-1,Math.floor(i*(curve.length-1)/(max-1)))],3));return out;
}
export function summarizeTrades(rows,options={}){
  const R=rows.map(x=>+x.net_r),n=R.length,wins=R.filter(x=>x>0).length,gp=R.filter(x=>x>0).reduce((a,b)=>a+b,0),gl=Math.abs(R.filter(x=>x<=0).reduce((a,b)=>a+b,0));let eq=0,peak=0,mdd=0;const curve=[];
  R.forEach(r=>{eq+=r;peak=Math.max(peak,eq);mdd=Math.min(mdd,eq-peak);curve.push(eq);});
  const ev=mean(R),variance=n>1?R.reduce((s,x)=>s+(x-ev)**2,0)/(n-1):0,se=Math.sqrt(variance/Math.max(1,n)),winCi=wilson(wins,n);
  const cutoff=rows.length?rows.at(-1).closed_bar_ts-90*86400:0,recent=R.filter((_,i)=>rows[i].closed_bar_ts>=cutoff),prior=R.filter((_,i)=>rows[i].closed_bar_ts<cutoff&&rows[i].closed_bar_ts>=cutoff-90*86400);
  const byRegime={};rows.forEach(x=>(byRegime[x.regime]||(byRegime[x.regime]=[])).push(x));
  const recentTrades=rows.slice(-20).map(row=>({
    closed_bar_ts:row.closed_bar_ts,
    direction:row.direction,
    net_r:round(+row.net_r,3),
    close_reason:row.close_reason,
    regime:row.regime,
  }));
  const summary={n,win:round(n?wins/n*100:0,1),win_ci95:winCi.map(x=>round(x*100,1)),ev:round(ev,3),ev_ci95:[round(ev-1.96*se,3),round(ev+1.96*se,3)],pf:round(gl?gp/gl:(gp?9.99:0),2),mdd:round(mdd,2),total_r:round(eq,2),recent_90d_ev:recent.length?round(mean(recent),3):null,prior_90d_ev:prior.length?round(mean(prior),3):null,drift_90d:recent.length&&prior.length?round(mean(recent)-mean(prior),3):null,curve:downsample(curve),first_trade:rows[0]?.opened_bar_ts||null,last_trade:rows.at(-1)?.closed_bar_ts||null,regimes:Object.fromEntries(Object.entries(byRegime).map(([k,v])=>[k,{n:v.length,ev:round(mean(v.map(x=>x.net_r)),3)}]))};
  if(options.includeRecent)summary.recent_trades=recentTrades;
  return summary;
}

function scopeKey(symbol){return symbol.replace(/USDT$/,"");}
function hashEvidence(x){return createHash("sha256").update(JSON.stringify(x)).digest("hex");}

export async function buildEvidence(options={}){
  const symbols=String(options.symbols||"BTCUSDT,ETHUSDT,SOLUSDT").split(",").filter(Boolean),timeframes=String(options.timeframes||"15m,1h,4h").split(",").filter(Boolean),endMs=options.end?Date.parse(options.end):Date.now(),stats={},scopes=[],coverage={};
  for(const symbol of symbols){
    coverage[scopeKey(symbol)]=[];
    for(const timeframe of timeframes){
      const days=options.quick?30:(DEFAULT_DAYS[timeframe]||365),startMs=endMs-days*86400*1000;
      process.stdout.write(`Fetching ${symbol} ${timeframe} (${days}d)... `);
      const [candles,funding]=await Promise.all([downloadCandles(symbol,timeframe,startMs,endMs),downloadFunding(symbol,startMs,endMs)]);
      if(candles.length<100){process.stdout.write("insufficient\n");continue;}
      const trades=simulateScope(candles,funding,{symbol,timeframe}),by={};trades.forEach(t=>(by[t.expert_id]||(by[t.expert_id]=[])).push(t));
      for(const expert of EXPERTS){
        const rows=by[expert.id]||[];if(!rows.length)continue;const name=expert.name,key=scopeKey(symbol);stats[name]=stats[name]||{};stats[name][key]=stats[name][key]||{};stats[name][key][timeframe]=summarizeTrades(rows);
      }
      coverage[scopeKey(symbol)].push(timeframe);scopes.push({symbol,timeframe,candles:candles.length,funding_points:funding.length,from:new Date(candles[0][0]*1000).toISOString(),through:new Date(candles.at(-1)[0]*1000).toISOString(),trades:trades.length});process.stdout.write(`${candles.length} bars / ${trades.length} trades\n`);
    }
  }
  const evidence={schema:"ev_desk_expert_evidence_v3",meta:{generated_at:new Date().toISOString(),engine_version:ENGINE_VERSION,source:"Binance official Spot Klines + USDⓈ-M funding history",coverage,pending:["美股与大宗需 Alpaca/授权行情后按同口径生成","宏观方法需历史 FRED 特征","Paul Wei 是行为概率模型，不与规则化技术方法混为一套PnL回测"],methodology:{decision_time:"closed bars only; every signal can use current and earlier bars only",pending_expiry_bars:12,max_hold_bars:30,same_bar_rule:"stop first",round_trip_cost_pct:.1,position_policy:"one pending/active plan per expert x symbol x timeframe",statistics:"R multiples; 95% Wilson win-rate interval and normal-approximation EV interval",growth_boundary:"historical 90d drift is regime drift, not model learning; model growth uses forward-only arena"},scopes},stats};
  evidence.meta.content_hash=hashEvidence({schema:evidence.schema,engine_version:ENGINE_VERSION,scopes,stats});return evidence;
}

async function main(){
  const args=argsOf(process.argv.slice(2)),evidence=await buildEvidence(args);await mkdir(path.dirname(args.output),{recursive:true});await writeFile(args.output,JSON.stringify(evidence,null,2)+"\n");await mkdir(path.dirname(args.jsOutput),{recursive:true});await writeFile(args.jsOutput,`window.EV_DESK_DATA=window.EV_DESK_DATA||{};window.EV_DESK_DATA.historical=${JSON.stringify(evidence)};\n`);console.log(`Wrote ${args.output}`);console.log(`Wrote ${args.jsOutput}`);console.log(`Evidence hash ${evidence.meta.content_hash}`);
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e);process.exitCode=1;});
