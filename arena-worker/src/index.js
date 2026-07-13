import {ENGINE_VERSION,EXPERTS,analyzeExperts,buildPlan,intervalSeconds} from "./engine.js";
import {fetchCandles,fetchDerivativesContext,fetchMacroContext,validateScope} from "./providers.js";

const enc=new TextEncoder();
const now=()=>Date.now();
const nowSec=()=>Math.floor(Date.now()/1000);
const idSafe=s=>String(s).replace(/[^a-zA-Z0-9_.|:-]/g,"_");
const avg=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
const csvList=(x,fallback)=>String(x||fallback).split(",").map(s=>s.trim()).filter(Boolean);
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==="object"?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const stable=x=>JSON.stringify(canonical(x));

async function sha256(s){
  const b=await crypto.subtle.digest("SHA-256",enc.encode(s));
  return[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("");
}
function cors(env){return{"access-control-allow-origin":env.ALLOWED_ORIGIN||"*","access-control-allow-methods":"GET,POST,OPTIONS","access-control-allow-headers":"authorization,content-type","cache-control":"no-store"};}
function json(env,data,status=200){return new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json;charset=UTF-8",...cors(env)}});}
function clampInt(x,a,b,d){const n=parseInt(x,10);return Number.isFinite(n)?Math.max(a,Math.min(b,n)):d;}
async function getState(env,key){const r=await env.DB.prepare("SELECT value,updated_at FROM arena_state WHERE key=?").bind(key).first();return r||null;}
function stateStmt(env,key,value){return env.DB.prepare("INSERT INTO arena_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(key,String(value),now());}

async function appendHash(env,kind,payload){
  const previous=(await getState(env,"chain_head"))?.value||"GENESIS",recordHash=await sha256(previous+"|"+kind+"|"+stable(payload));
  return{previous,recordHash,state:stateStmt(env,"chain_head",recordHash)};
}

async function seedExperts(env){
  const ts=now(),expertStmts=[],versionStmts=[];
  for(const x of EXPERTS){
    expertStmts.push(env.DB.prepare("INSERT INTO experts(id,name,school,version,enabled,created_at) VALUES(?,?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,school=excluded.school,version=excluded.version").bind(x.id,x.name,x.school,x.version,ts));
    const rulesHash=await sha256(stable({id:x.id,version:x.version,school:x.school,kind:x.kind,data_dependencies:x.data_dependencies}));
    versionStmts.push(env.DB.prepare("INSERT OR IGNORE INTO expert_versions(expert_id,version,kind,data_dependencies,rules_hash,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)").bind(x.id,x.version,x.kind,x.data_dependencies,rulesHash,JSON.stringify(x),ts));
  }
  if(expertStmts.length)await env.DB.batch([...expertStmts,...versionStmts]);
}

async function loadMacro(env){
  const cached=await getState(env,"macro_context_v1");
  if(cached&&now()-cached.updated_at<6*3600*1000){try{return JSON.parse(cached.value);}catch(e){}}
  let value;
  try{value=await fetchMacroContext(env.FRED_API_KEY);}catch(e){value={available:false,source:"FRED",reason:e?.message||String(e)};}
  await stateStmt(env,"macro_context_v1",JSON.stringify(value)).run();
  return value;
}

async function scopeData(env,symbol,timeframe){
  validateScope(symbol,timeframe);
  const [market,derivatives,macro]=await Promise.all([
    fetchCandles(symbol,timeframe,{limit:260,env}),
    fetchDerivativesContext(symbol),
    loadMacro(env)
  ]);
  const context={
    fundingRate:derivatives?.fundingRate??null,
    openInterestUsd:derivatives?.openInterestUsd??null,
    openInterestChange24h:derivatives?.openInterestChange24h??null,
    priceChange24h:derivatives?.priceChange24h??null,
    quoteVolume24h:derivatives?.quoteVolume24h??null,
    derivatives,
    macro
  };
  return{market,context,candles:market.candles,lastBar:market.candles.at(-1)};
}

async function persistMarketContext(env,symbol,timeframe,data){
  const payload={symbol,timeframe,bar_ts:data.lastBar[0],price:data.lastBar[4],candle_source:data.market.source,closed_through:data.market.closedThrough,fetched_at:data.market.fetchedAt,derivatives:data.context.derivatives,macro:data.context.macro};
  const id=idSafe(`market|${symbol}|${timeframe}|${data.lastBar[0]}`);
  await env.DB.prepare("INSERT OR REPLACE INTO market_context_snapshots(id,symbol,timeframe,bar_ts,created_at,candle_source,context_json) VALUES(?,?,?,?,?,?,?)")
    .bind(id,symbol,timeframe,data.lastBar[0],now(),data.market.source,JSON.stringify(payload)).run();
  return payload;
}

async function persistMethodViews(env,symbol,timeframe,bar,analysis){
  const stmts=[];
  for(const x of analysis){
    const evidence={regime:x.regime,price:x.price,atr:x.atr,reason:x.reason,plan:x.plan||null,engine_version:ENGINE_VERSION};
    const payload={expert_id:x.id,kind:x.kind||"method_lens",symbol,timeframe,bar_ts:bar[0],direction:x.direction||null,confidence:+x.confidence||0,reason:x.reason,model_version:x.version,evidence};
    const contentHash=await sha256(stable(payload)),id=idSafe(`view|${x.id}|${symbol}|${timeframe}|${bar[0]}|${x.version}`),p=x.plan||{};
    stmts.push(env.DB.prepare("INSERT OR IGNORE INTO expert_view_snapshots(id,expert_id,kind,symbol,timeframe,bar_ts,observed_at,valid_until,direction,stance,confidence,reason,action_text,risk_unit,entry,stop,target,rr,model_version,source_url,evidence_json,content_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(id,x.id,x.kind||"method_lens",symbol,timeframe,bar[0],now(),bar[0]+intervalSeconds(timeframe),x.direction||null,x.direction||"watch",+x.confidence||0,x.reason,null,null,p.entry??null,p.stop??null,p.target??null,p.rr??null,x.version,null,JSON.stringify(evidence),contentHash));
  }
  if(stmts.length)await env.DB.batch(stmts);
}

async function externalViews(env,symbol,timeframe,candles,regime){
  const r=await env.DB.prepare("SELECT v.*,e.name,e.school FROM expert_view_snapshots v JOIN experts e ON e.id=v.expert_id WHERE v.symbol=? AND v.timeframe=? AND v.kind!='method_lens' AND (v.valid_until IS NULL OR v.valid_until>=?) ORDER BY v.bar_ts DESC LIMIT 100")
    .bind(symbol,timeframe,nowSec()).all(),seen=new Set(),out=[];
  for(const v of r.results||[]){
    if(seen.has(v.expert_id))continue;seen.add(v.expert_id);
    let evidence={};try{evidence=JSON.parse(v.evidence_json||"{}");}catch(e){}
    let plan=v.entry!=null&&v.stop!=null&&v.target!=null?{entry:+v.entry,stop:+v.stop,target:+v.target,rr:+v.rr,trigger:evidence.trigger||v.action_text||"等待观点触发",invalid:evidence.invalid||"观点有效期结束"}:null;
    if(!plan&&v.direction)plan=buildPlan(v.direction,candles);
    out.push({id:v.expert_id,name:v.name,school:v.school,kind:v.kind,version:v.model_version,direction:v.direction,confidence:+v.confidence||0,reason:v.reason,regime:evidence.regime||regime,price:candles.at(-1)[4],plan,sourceViewId:v.id,externalEvidence:evidence});
  }
  return out;
}

async function settle(env,s,bar,grossR,reason,exit){
  const risk=Math.abs(s.entry-s.stop)||1,costR=s.entry*.001/risk,netR=Math.round((grossR-costR)*1000000)/1000000,ts=now(),tradeId="t|"+s.id;
  const payload={id:tradeId,signal_id:s.id,expert_id:s.expert_id,symbol:s.symbol,timeframe:s.timeframe,direction:s.direction,regime:s.regime,opened_bar_ts:s.entry_bar_ts||bar[0],closed_bar_ts:bar[0],entry:s.entry,exit,stop:s.stop,target:s.target,gross_r:grossR,cost_r:costR,net_r:netR,close_reason:reason,created_at:ts};
  const h=await appendHash(env,"trade",payload);
  await env.DB.batch([
    env.DB.prepare("UPDATE signals SET status='closed',closed_bar_ts=? WHERE id=?").bind(bar[0],s.id),
    env.DB.prepare("INSERT OR IGNORE INTO trades(id,signal_id,expert_id,symbol,timeframe,direction,regime,opened_bar_ts,closed_bar_ts,entry,exit,stop,target,gross_r,cost_r,net_r,close_reason,created_at,previous_hash,record_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(tradeId,s.id,s.expert_id,s.symbol,s.timeframe,s.direction,s.regime,payload.opened_bar_ts,bar[0],s.entry,exit,s.stop,s.target,grossR,costR,netR,reason,ts,h.previous,h.recordHash),
    h.state
  ]);
  return 1;
}

async function processBar(env,symbol,timeframe,bar){
  const q=await env.DB.prepare("SELECT * FROM signals WHERE symbol=? AND timeframe=? AND status IN ('pending','active')").bind(symbol,timeframe).all();let closed=0;
  for(const s of q.results||[]){
    if(bar[0]<=s.bar_ts)continue;
    let status=s.status,age=(s.age_bars||0)+1,held=s.held_bars||0,entryTs=s.entry_bar_ts;
    if(status==="pending"){
      const touched=bar[3]<=s.entry&&bar[2]>=s.entry;
      if(!touched){
        if(age>s.expires_bars)await env.DB.prepare("UPDATE signals SET status='expired',age_bars=?,closed_bar_ts=? WHERE id=?").bind(age,bar[0],s.id).run();
        else await env.DB.prepare("UPDATE signals SET age_bars=? WHERE id=?").bind(age,s.id).run();
        continue;
      }
      status="active";entryTs=bar[0];held=0;
    }
    held++;
    const stopHit=s.direction==="long"?bar[3]<=s.stop:bar[2]>=s.stop,targetHit=s.direction==="long"?bar[2]>=s.target:bar[3]<=s.target;
    if(stopHit){closed+=await settle(env,{...s,entry_bar_ts:entryTs},bar,-1,targetHit?"同根触及止损与目标，按悲观规则先止损":"止损",s.stop);continue;}
    if(targetHit){closed+=await settle(env,{...s,entry_bar_ts:entryTs},bar,s.rr,"目标",s.target);continue;}
    if(held>=s.max_hold_bars){
      const gross=s.direction==="long"?(bar[4]-s.entry)/Math.abs(s.entry-s.stop):(s.entry-bar[4])/Math.abs(s.stop-s.entry);
      closed+=await settle(env,{...s,entry_bar_ts:entryTs},bar,gross,"30根超时退出",bar[4]);continue;
    }
    await env.DB.prepare("UPDATE signals SET status=?,entry_bar_ts=?,age_bars=?,held_bars=? WHERE id=?").bind(status,entryTs,age,held,s.id).run();
  }
  return closed;
}

async function sealSignals(env,symbol,timeframe,bar,analysis){
  const open=await env.DB.prepare("SELECT expert_id FROM signals WHERE symbol=? AND timeframe=? AND status IN ('pending','active')").bind(symbol,timeframe).all(),busy=new Set((open.results||[]).map(x=>x.expert_id));let created=0;
  for(const x of analysis){
    if(!x.direction||!x.plan||x.plan.rr<1||busy.has(x.id))continue;
    const id=idSafe(x.sourceViewId?`external|${x.sourceViewId}`:[x.id,symbol,timeframe,bar[0],x.version].join("|"));
    if(await env.DB.prepare("SELECT id FROM signals WHERE id=?").bind(id).first())continue;
    const payload={id,expert_id:x.id,symbol,timeframe,direction:x.direction,confidence:x.confidence,regime:x.regime,bar_ts:bar[0],created_at:now(),signal_price:bar[4],entry:x.plan.entry,stop:x.plan.stop,target:x.plan.target,rr:x.plan.rr,status:"pending",trigger_text:x.plan.trigger,invalid_text:x.plan.invalid};
    const h=await appendHash(env,"signal",payload),r=await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO signals(id,expert_id,symbol,timeframe,direction,confidence,regime,bar_ts,created_at,signal_price,entry,stop,target,rr,status,trigger_text,invalid_text,previous_hash,record_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(id,x.id,symbol,timeframe,x.direction,x.confidence,x.regime,bar[0],payload.created_at,bar[4],x.plan.entry,x.plan.stop,x.plan.target,x.plan.rr,"pending",x.plan.trigger,x.plan.invalid,h.previous,h.recordHash),
      h.state
    ]);
    if(r[0]?.meta?.changes){created++;busy.add(x.id);}
  }
  return created;
}

function calcStats(rows){
  const R=rows.map(x=>+x.net_r),n=R.length,w=R.filter(x=>x>0),gp=w.reduce((a,b)=>a+b,0),gl=Math.abs(R.filter(x=>x<=0).reduce((a,b)=>a+b,0));let eq=0,peak=0,mdd=0,curve=[];
  R.forEach(r=>{eq+=r;peak=Math.max(peak,eq);mdd=Math.min(mdd,eq-peak);curve.push(Math.round(eq*1000)/1000);});
  const ev=n?eq/n:0,recent=n>=5?avg(R.slice(-Math.min(10,n))):null,prior=n>=10?avg(R.slice(-Math.min(20,n),-10)):null;
  return{n,win_rate:n?w.length/n*100:0,ev,profit_factor:gl?gp/gl:(gp?9.99:0),max_drawdown_r:mdd,total_r:eq,growth:recent!=null&&prior!=null?recent-prior:null,curve};
}
function grade(s){if(s.n<5)return"warming_up";if(s.n<20)return"observing";if(s.ev>=.12&&s.max_drawdown_r>-8)return"forward_valid";if(s.ev<=-.12)return"downweighted";return"stable";}
function trust(s){if(s.n<5)return 1;const rel=s.n/(s.n+25),dd=Math.max(0,(-s.max_drawdown_r-6)/18);return Math.max(.65,Math.min(1.35,1+rel*s.ev*.42-rel*dd*.16));}
function withGrade(rows){const s=calcStats(rows);return{...s,status:grade(s),trust_multiplier:trust(s)};}
function groupStats(rows,key){
  const by={};for(const row of rows){const k=row[key]||"unknown";(by[k]||(by[k]=[])).push(row);}
  return Object.fromEntries(Object.entries(by).map(([k,v])=>[k,withGrade(v)]));
}

async function opportunityTrustMap(env,ids){
  const out=Object.fromEntries(ids.map(x=>[x,1]));if(!ids.length)return out;
  const marks=ids.map(()=>"?").join(","),r=await env.DB.prepare("SELECT expert_id,net_r FROM trades WHERE expert_id IN ("+marks+") ORDER BY closed_bar_ts ASC").bind(...ids).all(),by={};
  (r.results||[]).forEach(x=>(by[x.expert_id]||(by[x.expert_id]=[])).push(x));
  Object.entries(by).forEach(([id,rows])=>out[id]=trust(calcStats(rows)));
  return out;
}

async function cacheOpportunity(env,symbol,timeframe,bar,analysis){
  const directional=analysis.filter(x=>x.direction==="long"||x.direction==="short"),ids=directional.map(x=>x.id),trusts=await opportunityTrustMap(env,ids);
  let longW=0,shortW=0;directional.forEach(x=>{const w=(+x.confidence||.3)*(trusts[x.id]||1);if(x.direction==="long")longW+=w;else shortW+=w;});
  const total=longW+shortW,consensus=total?Math.abs(longW-shortW)/total:0,direction=directional.length<2||consensus<.18?"flat":longW>shortW?"long":"short";
  const aligned=directional.filter(x=>x.direction===direction).sort((a,b)=>(b.confidence*(trusts[b.id]||1))-(a.confidence*(trusts[a.id]||1))),plans=aligned.filter(x=>x.plan).sort((a,b)=>(b.plan.rr||0)-(a.plan.rr||0)),pick=plans[0],plan=pick?.plan||null;
  const price=analysis[0]?.price||bar[4],A=analysis[0]?.atr||price*.01,location=plan?Math.max(0,Math.min(1,1-Math.abs(price-plan.entry)/A/1.5)):0,rr=plan?.rr||0,rrQ=Math.max(0,Math.min(1,(rr-1)/2.2));
  const trustAvg=aligned.length?aligned.reduce((s,x)=>s+(trusts[x.id]||1),0)/aligned.length:1,trustQ=Math.max(0,Math.min(1,(trustAvg-.65)/.7)),regime=analysis[0]?.regime||"区间/过渡";
  const regimeFit=direction==="flat"?0:regime==="区间/过渡"?.7:((direction==="long"&&regime==="多头趋势")||(direction==="short"&&regime==="空头趋势"))?1:.35,conflict=total?Math.min(longW,shortW)/total:1;
  let score=Math.max(0,Math.min(100,(consensus*.27+location*.27+rrQ*.23+trustQ*.13+regimeFit*.10)*100-conflict*25));if(!plan)score=Math.min(score,35);if(rr&&rr<1.2)score=Math.min(score,45);
  const stage=plan&&score>=68&&location>=.62&&rr>=1.5?"A":plan&&score>=52&&rr>=1.3?"B":plan&&score>=35?"C":"D",top=aligned.slice(0,3).map(x=>x.name),opp=direction==="flat"?[]:directional.filter(x=>x.direction!==direction).sort((a,b)=>b.confidence-a.confidence).slice(0,2).map(x=>x.name);
  const summary=stage==="A"?"接近触发，等待确认后执行":stage==="B"?"设预警，等待价格进入计划区":stage==="C"?"继续观察，暂不占用风险预算":"无位置优势，禁止追价";
  const payload={symbol,timeframe,bar_ts:bar[0],direction,score,stage,rr,consensus,location,trust:trustQ,regime_fit:regimeFit,conflict,price,entry:plan?.entry||null,stop:plan?.stop||null,target:plan?.target||null,trigger:plan?.trigger||null,invalid:plan?.invalid||null,top_experts:top,opposing_experts:opp,summary};
  const id=idSafe("opp|"+symbol+"|"+timeframe+"|"+bar[0]);
  await env.DB.prepare("INSERT OR REPLACE INTO opportunity_snapshots(id,symbol,timeframe,bar_ts,created_at,direction,score,stage,rr,consensus,location_score,trust_score,regime_fit,conflict,entry,stop,target,trigger_text,invalid_text,top_experts,opposing_experts,summary,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(id,symbol,timeframe,bar[0],now(),direction,score,stage,rr,consensus,location,trustQ,regimeFit,conflict,plan?.entry||null,plan?.stop||null,plan?.target||null,plan?.trigger||null,plan?.invalid||null,JSON.stringify(top),JSON.stringify(opp),summary,JSON.stringify(payload)).run();
  return payload;
}

async function runScope(env,symbol,timeframe){
  const data=await scopeData(env,symbol,timeframe),{candles,lastBar,context}=data,key="last_bar:"+symbol+":"+timeframe,last=+(await getState(env,key))?.value||0;let closed=0;
  if(last)for(const bar of candles.filter(x=>x[0]>last))closed+=await processBar(env,symbol,timeframe,bar);
  const methods=analyzeExperts(candles,context);await persistMethodViews(env,symbol,timeframe,lastBar,methods);await persistMarketContext(env,symbol,timeframe,data);
  const external=await externalViews(env,symbol,timeframe,candles,methods[0]?.regime),analysis=[...methods,...external];
  await cacheOpportunity(env,symbol,timeframe,lastBar,analysis);const created=await sealSignals(env,symbol,timeframe,lastBar,analysis);
  await stateStmt(env,key,lastBar[0]).run();return{created,closed,views:analysis.length,source:data.market.source};
}

export async function runArena(env){
  await seedExperts(env);const symbols=csvList(env.ARENA_SYMBOLS,"BTCUSDT,ETHUSDT,SOLUSDT"),tfs=csvList(env.ARENA_TIMEFRAMES,"15m,1h,4h"),started=now(),id="run|"+started;
  await env.DB.prepare("INSERT INTO arena_runs(id,started_at,status) VALUES(?,?,'running')").bind(id,started).run();let created=0,closed=0,scopes=0,views=0;const errors=[],sources={};
  for(const symbol of symbols)for(const tf of tfs){try{const r=await runScope(env,symbol,tf);created+=r.created;closed+=r.closed;views+=r.views;scopes++;sources[r.source]=(sources[r.source]||0)+1;}catch(e){errors.push(symbol+" "+tf+": "+(e?.message||e));}}
  const status=errors.length?"partial":"ok",finished=now();await env.DB.prepare("UPDATE arena_runs SET finished_at=?,status=?,symbols=?,signals_created=?,trades_closed=?,error_text=? WHERE id=?").bind(finished,status,scopes,created,closed,errors.join("\n")||null,id).run();
  const result={id,started_at:started,finished_at:finished,status,scopes,views_saved:views,signals_created:created,trades_closed:closed,sources,errors};await stateStmt(env,"last_run",JSON.stringify(result)).run();return result;
}

async function allTrades(env,url){
  const {where,bind}=arenaQueryFilters(url);let sql="SELECT * FROM trades";
  if(where.length)sql+=" WHERE "+where.join(" AND ");sql+=" ORDER BY closed_bar_ts ASC LIMIT 10000";
  return(await env.DB.prepare(sql).bind(...bind).all()).results||[];
}

export function arenaQueryFilters(url,alias="",includeExpert=true){
  const prefix=alias?alias+".":"",where=[],bind=[],pairs=[["symbol","symbol"],["timeframe","timeframe"]];
  if(includeExpert)pairs.push(["expert","expert_id"]);
  for(const [param,column] of pairs){const value=url.searchParams.get(param);if(value){where.push(prefix+column+"=?");bind.push(value);}}
  return{where,bind};
}

async function dbExperts(env){
  const r=await env.DB.prepare("SELECT e.*,COALESCE(v.kind,'method_lens') kind,COALESCE(v.data_dependencies,'') data_dependencies,v.rules_hash FROM experts e LEFT JOIN expert_versions v ON v.expert_id=e.id AND v.version=e.version WHERE e.enabled=1 ORDER BY e.created_at,e.id").all();
  return r.results||[];
}

async function leaderboard(env,url){
  const trades=await allTrades(env,url),experts=await dbExperts(env),by=Object.fromEntries(experts.map(x=>[x.id,[]]));trades.forEach(t=>(by[t.expert_id]||(by[t.expert_id]=[])).push(t));
  const where=[],bind=[];if(url.searchParams.get("symbol")){where.push("symbol=?");bind.push(url.searchParams.get("symbol"));}if(url.searchParams.get("timeframe")){where.push("timeframe=?");bind.push(url.searchParams.get("timeframe"));}
  let sql="SELECT expert_id,COUNT(*) n FROM signals WHERE status IN ('pending','active')";if(where.length)sql+=" AND "+where.join(" AND ");sql+=" GROUP BY expert_id";
  const positions=(await env.DB.prepare(sql).bind(...bind).all()).results||[],open=Object.fromEntries(positions.map(x=>[x.expert_id,x.n]));
  return experts.map(e=>{const s=withGrade(by[e.id]||[]);return{...e,...s,open_plans:open[e.id]||0};}).sort((a,b)=>(b.n?b.ev*b.n/(b.n+20):-99)-(a.n?a.ev*a.n/(a.n+20):-99));
}

async function currentViews(env,symbol,timeframe){
  const r=await env.DB.prepare("SELECT v.*,e.name,e.school FROM expert_view_snapshots v JOIN experts e ON e.id=v.expert_id WHERE v.symbol=? AND v.timeframe=? AND v.bar_ts=(SELECT MAX(v2.bar_ts) FROM expert_view_snapshots v2 WHERE v2.expert_id=v.expert_id AND v2.symbol=v.symbol AND v2.timeframe=v.timeframe) ORDER BY v.confidence DESC,e.name")
    .bind(symbol,timeframe).all();
  return(r.results||[]).map(x=>{let evidence={};try{evidence=JSON.parse(x.evidence_json||"{}");}catch(e){}return{...x,evidence};});
}

async function deskSnapshot(env,symbol,timeframe){
  validateScope(symbol,timeframe);const cached=await env.DB.prepare("SELECT * FROM market_context_snapshots WHERE symbol=? AND timeframe=? ORDER BY bar_ts DESC LIMIT 1").bind(symbol,timeframe).first();
  if(cached&&now()-cached.created_at<Math.max(360000,intervalSeconds(timeframe)*1000*.15)){
    let market={};try{market=JSON.parse(cached.context_json);}catch(e){}
    return{scope:"latest_sealed_closed_bar",generated_at:now(),market,views:await currentViews(env,symbol,timeframe)};
  }
  const data=await scopeData(env,symbol,timeframe),methods=analyzeExperts(data.candles,data.context),external=await externalViews(env,symbol,timeframe,data.candles,methods[0]?.regime);
  return{scope:"live_read_closed_bar",generated_at:now(),market:{symbol,timeframe,bar_ts:data.lastBar[0],price:data.lastBar[4],candle_source:data.market.source,closed_through:data.market.closedThrough,derivatives:data.context.derivatives,macro:data.context.macro},views:[...methods,...external].map(x=>({expert_id:x.id,name:x.name,school:x.school,kind:x.kind,model_version:x.version,direction:x.direction,confidence:x.confidence,reason:x.reason,regime:x.regime,plan:x.plan||null}))};
}

function adminAuthorized(req,env){const token=(req.headers.get("authorization")||"").replace(/^Bearer\s+/i,"");return Boolean(env.ADMIN_TOKEN&&token===env.ADMIN_TOKEN);}
function asSeconds(value){const n=typeof value==="number"?value:Date.parse(value);if(!Number.isFinite(n))return null;return n>1e12?Math.floor(n/1000):Math.floor(n);}
function validPlan(direction,p){
  if(!p||p.entry==null||p.stop==null||p.target==null)return null;const entry=+p.entry,stop=+p.stop,target=+p.target;if(![entry,stop,target].every(Number.isFinite))throw new Error("invalid plan prices");
  const risk=Math.abs(entry-stop);if(!(risk>0)||(direction==="long"&&!(stop<entry&&target>entry))||(direction==="short"&&!(stop>entry&&target<entry)))throw new Error("plan prices do not match direction");
  return{entry,stop,target,rr:Math.abs(target-entry)/risk};
}

async function ingestExpertViews(req,env){
  const body=await req.json(),items=Array.isArray(body)?body:Array.isArray(body.views)?body.views:[body],saved=[];
  for(const item of items){
    if(item.schema!=="ev_desk_expert_view_v1")throw new Error("unsupported expert view schema");
    const expert=item.expert||{},id=idSafe(expert.id||"");if(!id||id!==expert.id)throw new Error("invalid expert id");
    const name=String(expert.name||id).slice(0,80),school=String(expert.school||"外部专家观点").slice(0,120),kind=String(expert.kind||"human");if(!["human","behavior_model"].includes(kind))throw new Error("external expert kind must be human or behavior_model");
    const version=String(expert.version||"v1").slice(0,80),{symbol,timeframe}=validateScope(item.symbol,item.timeframe),barTs=asSeconds(item.asOf),validUntil=asSeconds(item.validUntil);
    if(!barTs||barTs>nowSec()+300||barTs<nowSec()-31*86400)throw new Error("expert view asOf is outside the accepted window");
    if(validUntil&&((validUntil<barTs)||(validUntil>barTs+7*86400)))throw new Error("expert view validity must be within seven days");
    const direction=item.direction==null?null:String(item.direction);if(direction!=null&&!['long','short'].includes(direction))throw new Error("invalid expert direction");
    const confidence=Math.max(0,Math.min(1,+item.confidence||0)),plan=validPlan(direction,item.plan),evidence=item.evidence&&typeof item.evidence==="object"?item.evidence:{},reason=String(item.reason||item.action||"未提供观点说明").slice(0,1000);
    const payload={schema:item.schema,expert:{id,name,school,kind,version},symbol,timeframe,bar_ts:barTs,valid_until:validUntil,direction,stance:item.stance||direction||"watch",confidence,reason,action:item.action||null,riskUnit:item.riskUnit||null,plan,evidence,sourceUrl:item.sourceUrl||null};
    const contentHash=await sha256(stable(payload)),viewId=idSafe(`view|${id}|${symbol}|${timeframe}|${barTs}|${version}|${contentHash.slice(0,12)}`),ts=now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO experts(id,name,school,version,enabled,created_at) VALUES(?,?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,school=excluded.school,version=excluded.version").bind(id,name,school,version,ts),
      env.DB.prepare("INSERT OR IGNORE INTO expert_versions(expert_id,version,kind,data_dependencies,rules_hash,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)").bind(id,version,kind,String(expert.dataDependencies||"外部结构化观点"),contentHash,JSON.stringify(expert),ts),
      env.DB.prepare("INSERT OR IGNORE INTO expert_view_snapshots(id,expert_id,kind,symbol,timeframe,bar_ts,observed_at,valid_until,direction,stance,confidence,reason,action_text,risk_unit,entry,stop,target,rr,model_version,source_url,evidence_json,content_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(viewId,id,kind,symbol,timeframe,barTs,ts,validUntil,direction,payload.stance,confidence,reason,payload.action,payload.riskUnit,plan?.entry??null,plan?.stop??null,plan?.target??null,plan?.rr??null,version,payload.sourceUrl,JSON.stringify(evidence),contentHash)
    ]);
    saved.push({id:viewId,content_hash:contentHash,expert_id:id,symbol,timeframe,bar_ts:barTs});
  }
  return{schema:"ev_desk_expert_view_ingest_v1",saved};
}

async function route(req,env){
  const url=new URL(req.url),p=url.pathname;if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors(env)});
  if(p==="/health")return json(env,{ok:true,service:"ev-desk-arena",engine_version:ENGINE_VERSION,time:now()});
  if(p==="/api/v1/market/bundle"){
    const symbol=String(url.searchParams.get("symbol")||"BTCUSDT").toUpperCase(),tfs=csvList(url.searchParams.get("timeframes"),"15m,1h,4h,1d").slice(0,6);tfs.forEach(tf=>validateScope(symbol,tf));
    const [markets,derivatives,macro]=await Promise.all([Promise.all(tfs.map(tf=>fetchCandles(symbol,tf,{limit:260,env}))),fetchDerivativesContext(symbol),loadMacro(env)]),data={};markets.forEach(x=>data[x.timeframe]={source:x.source,closed_through:x.closedThrough,candles:x.candles});
    return json(env,{schema:"ev_desk_market_bundle_v1",symbol,generated_at:now(),data,derivatives,macro});
  }
  if(p==="/api/v1/desk/snapshot"){
    const symbol=String(url.searchParams.get("symbol")||"BTCUSDT").toUpperCase(),tf=url.searchParams.get("timeframe")||"4h";return json(env,await deskSnapshot(env,symbol,tf));
  }
  if(p==="/api/v1/arena/meta"){
    const head=(await getState(env,"chain_head"))?.value,last=(await getState(env,"last_run"))?.value,counts=await env.DB.prepare("SELECT (SELECT COUNT(*) FROM signals) signals,(SELECT COUNT(*) FROM trades) trades,(SELECT COUNT(*) FROM signals WHERE status='active') active,(SELECT COUNT(*) FROM signals WHERE status='pending') pending,(SELECT COUNT(*) FROM opportunity_snapshots) opportunity_snapshots,(SELECT COUNT(*) FROM expert_view_snapshots) expert_views,(SELECT COUNT(*) FROM market_context_snapshots) market_snapshots").first();
    return json(env,{scope:"server_forward_only",engine_version:ENGINE_VERSION,source:env.ARENA_SOURCE||"official public market APIs",chain_head:head,last_run:last?JSON.parse(last):null,...counts});
  }
  if(p==="/api/v1/arena/leaderboard")return json(env,{scope:"server_forward_only",items:await leaderboard(env,url)});
  if(p==="/api/v1/arena/opportunities"){
    const symbol=url.searchParams.get("symbol"),tf=url.searchParams.get("timeframe"),where=[],bind=[];if(symbol){where.push("o.symbol=?");bind.push(symbol);}if(tf){where.push("o.timeframe=?");bind.push(tf);}
    let sql="SELECT o.* FROM opportunity_snapshots o JOIN (SELECT symbol,timeframe,MAX(bar_ts) bar_ts FROM opportunity_snapshots GROUP BY symbol,timeframe) m ON o.symbol=m.symbol AND o.timeframe=m.timeframe AND o.bar_ts=m.bar_ts";if(where.length)sql+=" WHERE "+where.join(" AND ");sql+=" ORDER BY o.score DESC,o.created_at DESC LIMIT 500";
    const q=env.DB.prepare(sql),r=await(bind.length?q.bind(...bind):q).all();return json(env,{scope:"latest_server_cache",generated_at:now(),items:(r.results||[]).map(x=>{try{return JSON.parse(x.payload_json);}catch(e){return x;}})});
  }
  if(p==="/api/v1/arena/views"){
    const symbol=String(url.searchParams.get("symbol")||"BTCUSDT").toUpperCase(),tf=url.searchParams.get("timeframe")||"4h";validateScope(symbol,tf);return json(env,{scope:"latest_closed_bar_per_expert",items:await currentViews(env,symbol,tf)});
  }
  if(p==="/api/v1/arena/positions"){
    const {where,bind}=arenaQueryFilters(url,"s");let sql="SELECT s.*,e.name,e.school FROM signals s JOIN experts e ON e.id=s.expert_id WHERE s.status IN ('pending','active')";
    if(where.length)sql+=" AND "+where.join(" AND ");sql+=" ORDER BY s.created_at DESC LIMIT 500";const q=env.DB.prepare(sql),r=await(bind.length?q.bind(...bind):q).all();return json(env,{items:r.results||[]});
  }
  if(p==="/api/v1/arena/ledger"){
    const limit=clampInt(url.searchParams.get("limit"),1,500,100),{where,bind}=arenaQueryFilters(url,"t");let sql="SELECT t.*,e.name,e.school FROM trades t JOIN experts e ON e.id=t.expert_id";
    if(where.length)sql+=" WHERE "+where.join(" AND ");sql+=" ORDER BY t.closed_bar_ts DESC LIMIT ?";const r=await env.DB.prepare(sql).bind(...bind,limit).all();return json(env,{items:r.results||[]});
  }
  if(p.startsWith("/api/v1/arena/experts/")){
    const id=decodeURIComponent(p.split("/").pop()),e=await env.DB.prepare("SELECT e.*,COALESCE(v.kind,'method_lens') kind,v.data_dependencies,v.rules_hash FROM experts e LEFT JOIN expert_versions v ON v.expert_id=e.id AND v.version=e.version WHERE e.id=? OR e.name=? LIMIT 1").bind(id,id).first();if(!e)return json(env,{error:"expert not found"},404);
    const {where,bind}=arenaQueryFilters(url,"",false),scope=where.length?" AND "+where.join(" AND "):"",args=[e.id,...bind];
    const t=(await env.DB.prepare("SELECT * FROM trades WHERE expert_id=?"+scope+" ORDER BY closed_bar_ts ASC LIMIT 5000").bind(...args).all()).results||[],pos=(await env.DB.prepare("SELECT * FROM signals WHERE expert_id=? AND status IN ('pending','active')"+scope+" ORDER BY created_at DESC").bind(...args).all()).results||[],views=(await env.DB.prepare("SELECT * FROM expert_view_snapshots WHERE expert_id=?"+scope+" ORDER BY bar_ts DESC LIMIT 100").bind(...args).all()).results||[];
    return json(env,{expert:e,stats:withGrade(t),stats_by_scope:groupStats(t,"symbol"),stats_by_timeframe:groupStats(t,"timeframe"),stats_by_regime:groupStats(t,"regime"),positions:pos,trades:t.slice(-200).reverse(),views});
  }
  if(p.startsWith("/api/v1/arena/proof/")){
    const h=decodeURIComponent(p.split("/").pop()),s=await env.DB.prepare("SELECT 'signal' kind,id,previous_hash,record_hash,created_at FROM signals WHERE record_hash=?").bind(h).first(),t=s?null:await env.DB.prepare("SELECT 'trade' kind,id,previous_hash,record_hash,created_at FROM trades WHERE record_hash=?").bind(h).first();return s||t?json(env,s||t):json(env,{error:"record not found"},404);
  }
  if(p==="/api/v1/admin/expert-views"&&req.method==="POST"){
    if(!adminAuthorized(req,env))return json(env,{error:"unauthorized"},401);return json(env,await ingestExpertViews(req,env),201);
  }
  if(p==="/api/v1/admin/run"&&req.method==="POST"){
    if(!adminAuthorized(req,env))return json(env,{error:"unauthorized"},401);return json(env,await runArena(env));
  }
  return json(env,{error:"not found"},404);
}

export default {
  fetch(req,env){return route(req,env).catch(e=>json(env,{error:e?.message||String(e)},500));},
  scheduled(_event,env,ctx){ctx.waitUntil(runArena(env));}
};
