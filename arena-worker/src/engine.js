export const ENGINE_VERSION = "arena-v2.0.0";

export const EXPERTS = [
  ["trend","老趋势","趋势跟踪"],
  ["dow","道氏","道氏理论"],
  ["brooks","Brooks","价格行为"],
  ["wyckoff","威科夫","量价/主力行为"],
  ["chan","缠师","缠论"],
  ["smc","SMC","供需/结构"],
  ["ict","ICT流动性","扫损/FVG/流动性"],
  ["levels","关键位","支撑阻力"],
  ["volume_profile","成交量分布","Volume Profile"],
  ["avwap","锚定VWAP","成本/均价"],
  ["fib","斐波","斐波那契"],
  ["ichimoku","一目均衡","Ichimoku"],
  ["mean_reversion","回归","均值回归"],
  ["momentum","因子","动量/相对强度"],
  ["grid","网格","区间执行"],
  ["sentiment","情绪","资金费率/拥挤"],
  ["macro","宏观","全球宏观","method_lens","FRED 利率/美元/波动率/流动性"],
  ["paul_wei","Paul Wei 重建","行为概率模型","behavior_model","Paul Wei teacher dataset + 1H OHLCV"]
].map(([id,name,school,kind="method_lens",data])=>({
  id,name,school,kind,data_dependencies:data||"已收盘 OHLCV",
  version:id==="paul_wei"?"paul-wei-core-v2":ENGINE_VERSION
}));

const col=(c,i)=>c.map(x=>+x[i]);
const max=a=>Math.max(...a),min=a=>Math.min(...a);
const avg=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));

export function emaSeries(v,n){
  if(!v.length)return[];const k=2/(n+1),out=[v[0]];let e=v[0];
  for(let i=1;i<v.length;i++){e=v[i]*k+e*(1-k);out.push(e);}return out;
}
export function rsi(v,n=14){
  if(v.length<n+1)return 50;let g=0,l=0;
  for(let i=1;i<=n;i++){const d=v[i]-v[i-1];g+=Math.max(d,0);l+=Math.max(-d,0);}
  let ag=g/n,al=l/n;for(let i=n+1;i<v.length;i++){const d=v[i]-v[i-1];ag=(ag*(n-1)+Math.max(d,0))/n;al=(al*(n-1)+Math.max(-d,0))/n;}
  return 100-100/(1+(al?ag/al:999));
}
export function atr(c,n=14){
  if(c.length<n+1)return 0;const tr=[];
  for(let i=1;i<c.length;i++)tr.push(Math.max(c[i][2]-c[i][3],Math.abs(c[i][2]-c[i-1][4]),Math.abs(c[i][3]-c[i-1][4])));
  return avg(tr.slice(-n));
}
function std(a){const m=avg(a);return Math.sqrt(avg(a.map(x=>(x-m)**2)));}
function boll(v,n=20,k=2){const a=v.slice(-n),m=avg(a),s=std(a);return[m-k*s,m,m+k*s];}
function macdHist(v){
  const f=emaSeries(v,12),s=emaSeries(v,26),line=f.map((x,i)=>x-s[i]),sig=emaSeries(line,9);return line.map((x,i)=>x-sig[i]);
}
function swingPoints(c,look=80){
  const d=c.slice(-look),hi=[],lo=[];
  for(let i=2;i<d.length-2;i++){if(d[i][2]>=max([d[i-2][2],d[i-1][2],d[i+1][2],d[i+2][2]]))hi.push([d[i][0],d[i][2]]);
    if(d[i][3]<=min([d[i-2][3],d[i-1][3],d[i+1][3],d[i+2][3]]))lo.push([d[i][0],d[i][3]]);}
  return{hi,lo};
}
function volumeNodes(c,bins=28){
  const d=c.slice(-120);if(!d.some(r=>+r[5]>0))return[];const lo=min(col(d,3)),hi=max(col(d,2)),step=(hi-lo)/bins;if(!(step>0))return[];
  const v=Array(bins).fill(0);d.forEach(r=>{const p=(r[2]+r[3]+r[4])/3,i=clamp(Math.floor((p-lo)/step),0,bins-1);v[i]+=r[5]||0;});
  return v.map((x,i)=>({p:lo+(i+.5)*step,v:x})).sort((a,b)=>b.v-a.v).slice(0,3);
}
function anchoredVWAP(c){
  const d=c.slice(-80);if(!d.length||!d.some(r=>+r[5]>0))return 0;let at=0,rg=-1;
  d.forEach((r,i)=>{if(r[2]-r[3]>rg){rg=r[2]-r[3];at=i;}});let pv=0,v=0;
  d.slice(at).forEach(r=>{const z=r[5]||1;pv+=(r[2]+r[3]+r[4])/3*z;v+=z;});return v?pv/v:0;
}
function niceStep(p){return p>=10000?1000:p>=1000?100:p>=100?10:p>=10?1:Math.max(.0001,p*.01);}
function buildZones(c,A){
  const p=c[c.length-1][4],pts=[],push=(price,src,w)=>{if(Number.isFinite(price)&&price>0)pts.push({p:price,src,w});};
  const sw=swingPoints(c,150);sw.hi.forEach(x=>push(x[1],"摆动高",1.1));sw.lo.forEach(x=>push(x[1],"摆动低",1.1));
  const d=c.slice(-60),H=max(col(d,2)),L=min(col(d,3)),range=H-L,closes=col(c,4),e20=emaSeries(closes,20).at(-1),e50=emaSeries(closes,50).at(-1),bb=boll(closes);
  push(max(col(c.slice(-20),2)),"唐奇安上沿",1.6);push(min(col(c.slice(-20),3)),"唐奇安下沿",1.6);push(H,"波段高",1.7);push(L,"波段低",1.7);
  push(e20,"EMA20",.8);push(e50,"EMA50",1.1);bb.forEach((x,i)=>push(x,["布林下轨","布林中轨","布林上轨"][i],.7));
  [.382,.5,.618,.786].forEach(x=>push(H-range*x,"Fib "+x,1));volumeNodes(c).forEach((x,i)=>push(x.p,i?"HVN":"POC",i?1.2:1.8));push(anchoredVWAP(c),"锚定VWAP",1.6);
  const prev=c[c.length-2];if(prev){const P=(prev[2]+prev[3]+prev[4])/3;push(prev[2],"前高",1.5);push(prev[3],"前低",1.5);push(P,"枢轴P",1);push(2*P-prev[3],"R1",1.1);push(2*P-prev[2],"S1",1.1);}
  const step=niceStep(p),base=Math.round(p/step)*step;for(let i=-2;i<=2;i++)push(base+i*step,"整数关口",.75);
  const tol=Math.max(A*.32,p*.0015),clusters=[];
  pts.sort((a,b)=>a.p-b.p).forEach(x=>{const z=clusters.at(-1);if(z&&Math.abs(x.p-z.p)<=tol){z.items.push(x);const w=z.items.reduce((s,q)=>s+q.w,0);z.p=z.items.reduce((s,q)=>s+q.p*q.w,0)/w;}else clusters.push({p:x.p,items:[x]});});
  return clusters.map(z=>{const sources=[...new Set(z.items.map(x=>x.src))],score=Math.min(10,z.items.reduce((s,x)=>s+x.w,0)+(sources.length-1)*.65);
    return{p:z.p,lo:z.p-tol*.48,hi:z.p+tol*.48,score,sources,type:z.p<p?"support":"resistance"};}).filter(z=>Math.abs(z.p-p)<A*12||z.score>=3).sort((a,b)=>a.p-b.p);
}
function planFor(direction,c,A,zones){
  const p=c.at(-1)[4],sup=zones.filter(z=>z.p<p).sort((a,b)=>b.p-a.p),res=zones.filter(z=>z.p>p).sort((a,b)=>a.p-b.p),S=sup[0],R=res[0];if(!S||!R)return null;
  if(direction==="long"){const entry=Math.min(p,S.hi),stop=S.lo-.35*A,target=(res.find(z=>z.score>=2.5&&Math.abs(z.lo-entry)/Math.abs(entry-stop)>=1.3)||R).lo,rr=(target-entry)/Math.abs(entry-stop);
    return rr>0?{entry,stop,target,rr,trigger:`触及 ${S.lo.toFixed(6)}–${S.hi.toFixed(6)} 后收回`,invalid:`收盘跌破 ${S.lo.toFixed(6)}`}:null;}
  const entry=Math.max(p,R.lo),stop=R.hi+.35*A,target=(sup.find(z=>z.score>=2.5&&Math.abs(entry-z.hi)/Math.abs(stop-entry)>=1.3)||S).hi,rr=(entry-target)/Math.abs(stop-entry);
  return rr>0?{entry,stop,target,rr,trigger:`触及 ${R.lo.toFixed(6)}–${R.hi.toFixed(6)} 后跌回`,invalid:`收盘站上 ${R.hi.toFixed(6)}`}:null;
}
export function buildPlan(direction,candles){
  const c=candles.map(r=>r.map(Number));
  if(c.length<80||!['long','short'].includes(direction))return null;
  const p=c.at(-1)[4],A=atr(c)||p*.01;
  return planFor(direction,c,A,buildZones(c,A));
}
function vote(id,direction,confidence,reason){return{id,direction,confidence,reason};}
export function analyzeExperts(candles,context=null){
  const c=candles.map(r=>r.map(Number));if(c.length<80)throw new Error("at least 80 candles required");
  const ctx=typeof context==="number"?{fundingRate:context}:(context||{}),fundingRate=ctx.fundingRate??null;
  const closes=col(c,4),p=closes.at(-1),A=atr(c)||p*.01,e20s=emaSeries(closes,20),e50s=emaSeries(closes,50),e20=e20s.at(-1),e50=e50s.at(-1),R=rsi(closes),bb=boll(closes),sw=swingPoints(c),hi=sw.hi,lo=sw.lo;
  const dcH=max(col(c.slice(-20),2)),dcL=min(col(c.slice(-20),3)),range60=max(col(c.slice(-60),2))-min(col(c.slice(-60),3)),pos=(p-dcL)/(dcH-dcL||1),v=col(c,5),hasVolume=v.slice(-20).some(x=>x>0),surge=hasVolume&&v.at(-1)>avg(v.slice(-20))*1.4;
  const trendUp=p>e20&&e20>e50&&e50s.at(-1)>e50s.at(-10),trendDown=p<e20&&e20<e50&&e50s.at(-1)<e50s.at(-10),regime=trendUp?"多头趋势":trendDown?"空头趋势":"区间/过渡";
  const votes=[];
  votes.push(vote("trend",trendUp?"long":trendDown?"short":null,.7,trendUp||trendDown?"均线与价格同向":"均线纠缠"));
  const H1=hi.at(-1)?.[1],H0=hi.at(-2)?.[1],L1=lo.at(-1)?.[1],L0=lo.at(-2)?.[1];
  votes.push(vote("dow",H1>H0&&L1>L0?"long":H1<H0&&L1<L0?"short":null,.65,"摆动高低点结构"));
  const bars=c.slice(-12),bull=bars.filter(x=>x[4]>x[1]).length;votes.push(vote("brooks",bull>=8&&p>e20?"long":bull<=4&&p<e20?"short":null,.6,"趋势K与EMA上下文"));
  votes.push(vote("wyckoff",pos<.3&&surge&&p>closes.at(-2)?"long":pos>.7&&surge&&p<closes.at(-2)?"short":null,hasVolume?.6:0,hasVolume?"区间位置与量价反应":"当前市场没有可用成交量"));
  const mh=macdHist(closes),p1=min(closes.slice(-10)),p2=min(closes.slice(-30,-10)),h1=min(mh.slice(-10)),h2=min(mh.slice(-30,-10)),P1=max(closes.slice(-10)),P2=max(closes.slice(-30,-10)),Hh1=max(mh.slice(-10)),Hh2=max(mh.slice(-30,-10));
  votes.push(vote("chan",p1<p2&&h1>h2?"long":P1>P2&&Hh1<Hh2?"short":null,.58,"价格与MACD柱背驰"));
  const mid=H1!=null&&L1!=null?(H1+L1)/2:p;votes.push(vote("smc",p>(H1||dcH)?"long":p<(L1||dcL)?"short":p<mid?"long":"short",.45,"BOS与供需区位置"));
  const last=c.at(-1),prior=c.slice(-22,-1),ph=max(col(prior,2)),pl=min(col(prior,3));votes.push(vote("ict",last[3]<pl&&last[4]>pl?"long":last[2]>ph&&last[4]<ph?"short":null,.62,"流动性清扫并收回"));
  const zones=buildZones(c,A),S=zones.filter(z=>z.p<p).at(-1),Z=zones.find(z=>z.p>p);votes.push(vote("levels",S&&p-S.p<.55*A?"long":Z&&Z.p-p<.55*A?"short":null,.65,"高汇合支撑阻力"));
  const nodes=volumeNodes(c),poc=nodes[0]?.p,near=nodes.sort((a,b)=>Math.abs(a.p-p)-Math.abs(b.p-p))[0]?.p;votes.push(vote("volume_profile",near&&Math.abs(p-near)<.7*A?(p>poc?"long":"short"):null,hasVolume?.45:0,hasVolume?"POC/HVN接受度":"当前市场没有可用成交量"));
  const av=anchoredVWAP(c),dist=av?(p-av)/A:0;votes.push(vote("avwap",av&&Math.abs(dist)>.4?(dist>0?"long":"short"):null,hasVolume?.45:0,hasVolume?"锚定成本上/下方":"当前市场没有可用成交量"));
  const H=max(col(c.slice(-60),2)),L=min(col(c.slice(-60),3)),retr=(H-p)/(H-L||1);votes.push(vote("fib",retr>=.5&&retr<=.66?"long":retr>.85?"short":null,.5,"波段回撤比例"));
  const midN=n=>{const d=c.slice(-n);return(max(col(d,2))+min(col(d,3)))/2},ten=midN(9),kij=midN(26),sa=(ten+kij)/2,sb=midN(52),top=Math.max(sa,sb),bot=Math.min(sa,sb);
  votes.push(vote("ichimoku",p>top&&ten>kij?"long":p<bot&&ten<kij?"short":null,.62,"云层与转换/基准线"));
  votes.push(vote("mean_reversion",p<=bb[0]&&R<32?"long":p>=bb[2]&&R>68?"short":null,.58,"布林极值与RSI"));
  const mom=p/closes.at(-16)-1;votes.push(vote("momentum",mom>.05&&R>55?"long":mom<-.05&&R<45?"short":null,.6,"15期动量与RSI"));
  votes.push(vote("grid",null,.3,Math.abs(p-e50)/e50<.03&&range60/p<.09?"适合区间执行":"趋势中不启用网格"));
  const oi=ctx.openInterestChange24h,oiText=Number.isFinite(oi)?`，24H持仓量${oi>=0?"+":""}${(oi*100).toFixed(1)}%`:"";
  votes.push(vote("sentiment",fundingRate!=null?(fundingRate>=.0005?"short":fundingRate<=-.0003?"long":null):null,fundingRate==null?0:.5,"资金费率拥挤度"+oiText));
  const m=ctx.macro||{},macroParts=[];let macroScore=0,macroInputs=0;
  if(Number.isFinite(m.dollarChange5d)){macroInputs++;macroScore+=m.dollarChange5d<=-.005?1:m.dollarChange5d>=.005?-1:0;macroParts.push(`广义美元5日${(m.dollarChange5d*100).toFixed(1)}%`);}
  if(Number.isFinite(m.realYieldChange5d)){macroInputs++;macroScore+=m.realYieldChange5d<=-.10?1:m.realYieldChange5d>=.10?-1:0;macroParts.push(`10Y实际利率5日${m.realYieldChange5d>=0?"+":""}${m.realYieldChange5d.toFixed(2)}pct`);}
  if(Number.isFinite(m.vixChange5d)){macroInputs++;macroScore+=m.vixChange5d<=-.10?.5:m.vixChange5d>=.10?-.5:0;macroParts.push(`VIX 5日${(m.vixChange5d*100).toFixed(1)}%`);}
  if(Number.isFinite(m.fedBalanceChange4w)){macroInputs++;macroScore+=m.fedBalanceChange4w>0?.5:m.fedBalanceChange4w<0?-.5:0;macroParts.push(`Fed资产负债表4周${m.fedBalanceChange4w>=0?"扩张":"收缩"}`);}
  votes.push(vote("macro",macroInputs>=2?(macroScore>=1.5?"long":macroScore<=-1.5?"short":null):null,macroInputs>=2?.48:0,macroInputs?macroParts.join("；"):"等待独立宏观数据源"));
  const byId=Object.fromEntries(EXPERTS.map(x=>[x.id,x]));
  return votes.map(v=>{const plan=v.direction?planFor(v.direction,c,A,zones):null;return Object.assign({},byId[v.id],v,{regime,atr:A,price:p,plan:plan&&plan.rr>=1?plan:null});});
}

export function intervalSeconds(tf){return{"1m":60,"5m":300,"15m":900,"1h":3600,"4h":14400,"1d":86400}[tf]||3600;}
