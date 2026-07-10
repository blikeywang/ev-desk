import {EXPERTS,analyzeExperts,intervalSeconds} from "./engine.js";

const enc=new TextEncoder();
const now=()=>Date.now();
const idSafe=s=>String(s).replace(/[^a-zA-Z0-9_.|:-]/g,"_");
const stable=x=>JSON.stringify(x,Object.keys(x).sort());
async function sha256(s){const b=await crypto.subtle.digest("SHA-256",enc.encode(s));return[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("");}
function cors(env){return{"access-control-allow-origin":env.ALLOWED_ORIGIN||"*","access-control-allow-methods":"GET,POST,OPTIONS","access-control-allow-headers":"authorization,content-type","cache-control":"no-store"};}
function json(env,data,status=200){return new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json;charset=UTF-8",...cors(env)}});}
function csvList(x,fallback){return String(x||fallback).split(",").map(s=>s.trim()).filter(Boolean);}
async function getState(env,key){const r=await env.DB.prepare("SELECT value FROM arena_state WHERE key=?").bind(key).first();return r?.value??null;}
function stateStmt(env,key,value){return env.DB.prepare("INSERT INTO arena_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(key,String(value),now());}

async function appendHash(env,kind,payload){
  const previous=await getState(env,"chain_head")||"GENESIS",recordHash=await sha256(previous+"|"+kind+"|"+stable(payload));
  return{previous,recordHash,state:stateStmt(env,"chain_head",recordHash)};
}
async function seedExperts(env){
  const ts=now(),stmts=EXPERTS.map(x=>env.DB.prepare("INSERT INTO experts(id,name,school,version,enabled,created_at) VALUES(?,?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,school=excluded.school,version=excluded.version").bind(x.id,x.name,x.school,x.version,ts));
  if(stmts.length)await env.DB.batch(stmts);
}
async function fetchJson(url,timeout=10000){
  const ctl=new AbortController(),t=setTimeout(()=>ctl.abort(),timeout);
  try{const r=await fetch(url,{signal:ctl.signal,headers:{"user-agent":"ev-desk-arena/0.1"}});if(!r.ok)throw new Error("HTTP "+r.status);return await r.json();}finally{clearTimeout(t);}
}
async function fetchCandles(symbol,timeframe){
  const url="https://api.binance.com/api/v3/klines?symbol="+encodeURIComponent(symbol)+"&interval="+encodeURIComponent(timeframe)+"&limit=240",d=await fetchJson(url);
  if(!Array.isArray(d)||d.length<80)throw new Error("insufficient candles for "+symbol+" "+timeframe);
  return d.slice(0,-1).map(r=>[Math.floor(+r[0]/1000),+r[1],+r[2],+r[3],+r[4],+r[5]]);
}
async function fetchFunding(symbol){
  try{const d=await fetchJson("https://fapi.binance.com/fapi/v1/premiumIndex?symbol="+encodeURIComponent(symbol),7000);return d.lastFundingRate==null?null:+d.lastFundingRate;}catch(e){return null;}
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
      if(!touched){if(age>s.expires_bars)await env.DB.prepare("UPDATE signals SET status='expired',age_bars=?,closed_bar_ts=? WHERE id=?").bind(age,bar[0],s.id).run();else await env.DB.prepare("UPDATE signals SET age_bars=? WHERE id=?").bind(age,s.id).run();continue;}
      status="active";entryTs=bar[0];held=0;
    }
    held++;
    const stopHit=s.direction==="long"?bar[3]<=s.stop:bar[2]>=s.stop,targetHit=s.direction==="long"?bar[2]>=s.target:bar[3]<=s.target;
    if(stopHit){closed+=await settle(env,Object.assign({},s,{entry_bar_ts:entryTs}),bar,-1,targetHit?"同根触及止损与目标，按悲观规则先止损":"止损",s.stop);continue;}
    if(targetHit){closed+=await settle(env,Object.assign({},s,{entry_bar_ts:entryTs}),bar,s.rr,"目标",s.target);continue;}
    if(held>=s.max_hold_bars){const gross=s.direction==="long"?(bar[4]-s.entry)/Math.abs(s.entry-s.stop):(s.entry-bar[4])/Math.abs(s.stop-s.entry);closed+=await settle(env,Object.assign({},s,{entry_bar_ts:entryTs}),bar,gross,"30根超时退出",bar[4]);continue;}
    await env.DB.prepare("UPDATE signals SET status=?,entry_bar_ts=?,age_bars=?,held_bars=? WHERE id=?").bind(status,entryTs,age,held,s.id).run();
  }
  return closed;
}
async function sealSignals(env,symbol,timeframe,bar,analysis){
  const open=await env.DB.prepare("SELECT expert_id FROM signals WHERE symbol=? AND timeframe=? AND status IN ('pending','active')").bind(symbol,timeframe).all(),busy=new Set((open.results||[]).map(x=>x.expert_id));let created=0;
  for(const x of analysis){
    if(!x.direction||!x.plan||x.plan.rr<1||busy.has(x.id))continue;
    const id=idSafe([x.id,symbol,timeframe,bar[0],x.version].join("|")),payload={id,expert_id:x.id,symbol,timeframe,direction:x.direction,confidence:x.confidence,regime:x.regime,bar_ts:bar[0],created_at:now(),signal_price:bar[4],entry:x.plan.entry,stop:x.plan.stop,target:x.plan.target,rr:x.plan.rr,status:"pending",trigger_text:x.plan.trigger,invalid_text:x.plan.invalid};
    if(await env.DB.prepare("SELECT id FROM signals WHERE id=?").bind(id).first())continue;
    const h=await appendHash(env,"signal",payload);
    const r=await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO signals(id,expert_id,symbol,timeframe,direction,confidence,regime,bar_ts,created_at,signal_price,entry,stop,target,rr,status,trigger_text,invalid_text,previous_hash,record_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(id,x.id,symbol,timeframe,x.direction,x.confidence,x.regime,bar[0],payload.created_at,bar[4],x.plan.entry,x.plan.stop,x.plan.target,x.plan.rr,"pending",x.plan.trigger,x.plan.invalid,h.previous,h.recordHash),
      h.state
    ]);
    if(r[0]?.meta?.changes)created++;
  }
  return created;
}
async function runScope(env,symbol,timeframe){
  const candles=await fetchCandles(symbol,timeframe),funding=await fetchFunding(symbol),lastBar=candles.at(-1),key="last_bar:"+symbol+":"+timeframe,last=+(await getState(env,key)||0);let closed=0;
  if(last)for(const bar of candles.filter(x=>x[0]>last))closed+=await processBar(env,symbol,timeframe,bar);
  const analysis=analyzeExperts(candles,funding),created=await sealSignals(env,symbol,timeframe,lastBar,analysis);
  await stateStmt(env,key,lastBar[0]).run();return{created,closed};
}
export async function runArena(env){
  await seedExperts(env);const symbols=csvList(env.ARENA_SYMBOLS,"BTCUSDT,ETHUSDT,SOLUSDT"),tfs=csvList(env.ARENA_TIMEFRAMES,"15m,1h,4h"),started=now(),id="run|"+started;
  await env.DB.prepare("INSERT INTO arena_runs(id,started_at,status) VALUES(?,?,'running')").bind(id,started).run();let created=0,closed=0,scopes=0;const errors=[];
  for(const symbol of symbols)for(const tf of tfs){try{const r=await runScope(env,symbol,tf);created+=r.created;closed+=r.closed;scopes++;}catch(e){errors.push(symbol+" "+tf+": "+(e?.message||e));}}
  const status=errors.length?"partial":"ok";await env.DB.prepare("UPDATE arena_runs SET finished_at=?,status=?,symbols=?,signals_created=?,trades_closed=?,error_text=? WHERE id=?").bind(now(),status,scopes,created,closed,errors.join("\n")||null,id).run();
  await stateStmt(env,"last_run",JSON.stringify({id,started_at:started,finished_at:now(),status,scopes,signals_created:created,trades_closed:closed,errors})).run();
  return{id,status,scopes,signals_created:created,trades_closed:closed,errors};
}
function calcStats(rows){
  const R=rows.map(x=>+x.net_r),n=R.length,w=R.filter(x=>x>0),gp=w.reduce((a,b)=>a+b,0),gl=Math.abs(R.filter(x=>x<=0).reduce((a,b)=>a+b,0));let eq=0,peak=0,mdd=0,curve=[];
  R.forEach(r=>{eq+=r;peak=Math.max(peak,eq);mdd=Math.min(mdd,eq-peak);curve.push(Math.round(eq*1000)/1000);});
  const ev=n?eq/n:0,recent=n>=5?avg(R.slice(-Math.min(10,n))):null,prior=n>=10?avg(R.slice(-Math.min(20,n),-10)):null;
  return{n,win_rate:n?w.length/n*100:0,ev,profit_factor:gl?gp/gl:(gp?9.99:0),max_drawdown_r:mdd,total_r:eq,growth:recent!=null&&prior!=null?recent-prior:null,curve};
}
function avg(a){return a.length?a.reduce((x,y)=>x+y,0)/a.length:0;}
function grade(s){if(s.n<5)return"warming_up";if(s.n<20)return"observing";if(s.ev>=.12&&s.max_drawdown_r>-8)return"forward_valid";if(s.ev<=-.12)return"downweighted";return"stable";}
function trust(s){if(s.n<5)return 1;const rel=s.n/(s.n+25),dd=Math.max(0,(-s.max_drawdown_r-6)/18);return Math.max(.65,Math.min(1.35,1+rel*s.ev*.42-rel*dd*.16));}
async function allTrades(env,url){
  const symbol=url.searchParams.get("symbol"),tf=url.searchParams.get("timeframe");let sql="SELECT * FROM trades",bind=[];const where=[];
  if(symbol){where.push("symbol=?");bind.push(symbol);}if(tf){where.push("timeframe=?");bind.push(tf);}if(where.length)sql+=" WHERE "+where.join(" AND ");sql+=" ORDER BY closed_bar_ts ASC LIMIT 10000";
  return (await env.DB.prepare(sql).bind(...bind).all()).results||[];
}
async function leaderboard(env,url){
  const trades=await allTrades(env,url),by=Object.fromEntries(EXPERTS.map(x=>[x.id,[]]));trades.forEach(t=>(by[t.expert_id]||(by[t.expert_id]=[])).push(t));
  const positions=(await env.DB.prepare("SELECT expert_id,COUNT(*) n FROM signals WHERE status IN ('pending','active') GROUP BY expert_id").all()).results||[],open=Object.fromEntries(positions.map(x=>[x.expert_id,x.n]));
  return EXPERTS.map(e=>{const s=calcStats(by[e.id]||[]);return{...e,...s,status:grade(s),trust_multiplier:trust(s),open_plans:open[e.id]||0};}).sort((a,b)=>(b.n?b.ev*b.n/(b.n+20):-99)-(a.n?a.ev*a.n/(a.n+20):-99));
}
async function route(req,env){
  const url=new URL(req.url),p=url.pathname;if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors(env)});
  if(p==="/health")return json(env,{ok:true,service:"ev-desk-arena",time:now()});
  if(p==="/api/v1/arena/meta"){const head=await getState(env,"chain_head"),last=await getState(env,"last_run"),counts=await env.DB.prepare("SELECT (SELECT COUNT(*) FROM signals) signals,(SELECT COUNT(*) FROM trades) trades,(SELECT COUNT(*) FROM signals WHERE status='active') active,(SELECT COUNT(*) FROM signals WHERE status='pending') pending").first();return json(env,{scope:"server_forward_only",source:env.ARENA_SOURCE||"public market data",chain_head:head,last_run:last?JSON.parse(last):null,...counts});}
  if(p==="/api/v1/arena/leaderboard")return json(env,{scope:"server_forward_only",items:await leaderboard(env,url)});
  if(p==="/api/v1/arena/positions"){const r=await env.DB.prepare("SELECT s.*,e.name,e.school FROM signals s JOIN experts e ON e.id=s.expert_id WHERE s.status IN ('pending','active') ORDER BY s.created_at DESC LIMIT 500").all();return json(env,{items:r.results||[]});}
  if(p==="/api/v1/arena/ledger"){const limit=clampInt(url.searchParams.get("limit"),1,500,100),r=await env.DB.prepare("SELECT t.*,e.name,e.school FROM trades t JOIN experts e ON e.id=t.expert_id ORDER BY t.closed_bar_ts DESC LIMIT ?").bind(limit).all();return json(env,{items:r.results||[]});}
  if(p.startsWith("/api/v1/arena/experts/")){const id=decodeURIComponent(p.split("/").pop()),e=EXPERTS.find(x=>x.id===id||x.name===id);if(!e)return json(env,{error:"expert not found"},404);const t=(await env.DB.prepare("SELECT * FROM trades WHERE expert_id=? ORDER BY closed_bar_ts ASC LIMIT 2000").bind(e.id).all()).results||[],pos=(await env.DB.prepare("SELECT * FROM signals WHERE expert_id=? AND status IN ('pending','active') ORDER BY created_at DESC").bind(e.id).all()).results||[];return json(env,{expert:e,stats:{...calcStats(t),status:grade(calcStats(t)),trust_multiplier:trust(calcStats(t))},positions:pos,trades:t.slice(-200).reverse()});}
  if(p.startsWith("/api/v1/arena/proof/")){const h=decodeURIComponent(p.split("/").pop()),s=await env.DB.prepare("SELECT 'signal' kind,id,previous_hash,record_hash,created_at FROM signals WHERE record_hash=?").bind(h).first(),t=s?null:await env.DB.prepare("SELECT 'trade' kind,id,previous_hash,record_hash,created_at FROM trades WHERE record_hash=?").bind(h).first();return s||t?json(env,s||t):json(env,{error:"record not found"},404);}
  if(p==="/api/v1/admin/run"&&req.method==="POST"){const token=(req.headers.get("authorization")||"").replace(/^Bearer\s+/i,"");if(!env.ADMIN_TOKEN||token!==env.ADMIN_TOKEN)return json(env,{error:"unauthorized"},401);return json(env,await runArena(env));}
  return json(env,{error:"not found"},404);
}
function clampInt(x,a,b,d){const n=parseInt(x,10);return Number.isFinite(n)?Math.max(a,Math.min(b,n)):d;}

export default {
  fetch(req,env){return route(req,env).catch(e=>json(env,{error:e?.message||String(e)},500));},
  scheduled(_event,env,ctx){ctx.waitUntil(runArena(env));}
};
