const TF_SECONDS={"1m":60,"5m":300,"15m":900,"1h":3600,"4h":14400,"1d":86400};
const OKX_TF={"1m":"1m","5m":"5m","15m":"15m","1h":"1H","4h":"4H","1d":"1Dutc"};
const KRAKEN_TF={"1m":1,"5m":5,"15m":15,"1h":60,"4h":240,"1d":1440};
const KRAKEN_PAIR={BTCUSDT:"XBTUSDT",ETHUSDT:"ETHUSDT",SOLUSDT:"SOLUSDT"};
const ALPACA_TF={"1m":"1Min","5m":"5Min","15m":"15Min","1h":"1Hour","4h":"4Hour","1d":"1Day"};
const YAHOO_TICKER={NDX:"^NDX",XAUUSD:"GC=F",WTI:"CL=F"};
const YAHOO_TF={"1m":["1m","5d"],"5m":["5m","1mo"],"15m":["15m","1mo"],"1h":["60m","3mo"],"4h":["60m","3mo"],"1d":["1d","2y"]};

const cleanSymbol=s=>String(s||"").toUpperCase().replace(/[^A-Z0-9]/g,"");
const okxSpot=s=>s.replace(/USDT$/,"-USDT");
const okxSwap=s=>s.replace(/USDT$/,"-USDT-SWAP");
const finite=x=>Number.isFinite(+x)?+x:null;

export function validateScope(symbol,timeframe,allowedSymbols=null){
  const s=cleanSymbol(symbol),tf=String(timeframe||"");
  if(!s||s!==String(symbol||"").toUpperCase()||!TF_SECONDS[tf])throw new Error("invalid market scope");
  if(allowedSymbols&&allowedSymbols.length&&!allowedSymbols.includes(s))throw new Error("symbol is not enabled");
  return{symbol:s,timeframe:tf};
}

export async function fetchJson(url,timeout=10000,headers={},fetchImpl=fetch){
  const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),timeout);
  try{
    const r=await fetchImpl(url,{signal:ctl.signal,headers:{accept:"application/json","user-agent":"ev-desk-arena/0.2",...headers}});
    if(!r.ok)throw new Error(`HTTP ${r.status} @ ${new URL(url).hostname}`);
    return await r.json();
  }finally{clearTimeout(timer);}
}

async function firstOk(tasks){
  const errors=[];
  for(const task of tasks){try{return await task();}catch(e){errors.push(e?.message||String(e));}}
  throw new Error(errors.join(" | ")||"all market providers failed");
}

export function parseBinanceCandles(rows,nowMs=Date.now()){
  if(!Array.isArray(rows))return[];
  return rows.filter(r=>Array.isArray(r)&&r.length>=7&&+r[6]<nowMs)
    .map(r=>[Math.floor(+r[0]/1000),+r[1],+r[2],+r[3],+r[4],+r[5]])
    .filter(r=>r.every(Number.isFinite));
}

export function parseOkxCandles(rows,timeframe,nowSec=Math.floor(Date.now()/1000)){
  if(!Array.isArray(rows))return[];const sec=TF_SECONDS[timeframe]||3600;
  return rows.filter(r=>Array.isArray(r)&&r.length>=6&&(r[8]===undefined?+r[0]/1000+sec<=nowSec:String(r[8])==="1"))
    .map(r=>[Math.floor(+r[0]/1000),+r[1],+r[2],+r[3],+r[4],+r[5]])
    .filter(r=>r.every(Number.isFinite)).sort((a,b)=>a[0]-b[0]);
}

export function parseKrakenCandles(rows,timeframe,nowSec=Math.floor(Date.now()/1000)){
  const sec=TF_SECONDS[timeframe]||3600;if(!Array.isArray(rows))return[];
  return rows.filter(r=>Array.isArray(r)&&+r[0]+sec<=nowSec)
    .map(r=>[+r[0],+r[1],+r[2],+r[3],+r[4],+r[6]])
    .filter(r=>r.every(Number.isFinite));
}

export function aggregateSessionCandles(rows,size=4,offsetSec=0){
  const out=[];let day="",index=0,key="",bar=null;
  const flush=()=>{if(bar)out.push(bar);bar=null;};
  for(const row of rows){const localDay=new Date((row[0]+offsetSec)*1000).toISOString().slice(0,10);if(localDay!==day){flush();day=localDay;index=0;key="";}
    const nextKey=day+"|"+Math.floor(index/size);if(nextKey!==key){flush();key=nextKey;bar=[...row];}else{bar[2]=Math.max(bar[2],row[2]);bar[3]=Math.min(bar[3],row[3]);bar[4]=row[4];bar[5]+=row[5];}index++;}
  flush();return out;
}

export function parseYahooCandles(payload,timeframe,nowSec=Math.floor(Date.now()/1000)){
  const result=payload?.chart?.result?.[0],timestamps=result?.timestamp,quote=result?.indicators?.quote?.[0];
  if(!Array.isArray(timestamps)||!quote)return[];
  const sourceSec=timeframe==="1d"?86400:(timeframe==="4h"||timeframe==="1h")?3600:TF_SECONDS[timeframe],isIndex=result?.meta?.instrumentType==="INDEX",rows=[];
  for(let i=0;i<timestamps.length;i++){const close=finite(quote.close?.[i]),ts=finite(timestamps[i]);if(close==null||ts==null||ts+sourceSec>nowSec)continue;const open=finite(quote.open?.[i])??close,high=finite(quote.high?.[i])??close,low=finite(quote.low?.[i])??close,volume=isIndex?0:finite(quote.volume?.[i])??0;rows.push([ts,open,high,low,close,volume]);}
  return timeframe==="4h"?aggregateSessionCandles(rows,4,finite(result?.meta?.gmtoffset)??0):rows;
}

async function binanceCandles(symbol,timeframe,limit,fetchImpl){
  const path=`/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(timeframe)}&limit=${limit}`;
  return firstOk([
    async()=>({source:"Binance",candles:parseBinanceCandles(await fetchJson("https://api.binance.com"+path,10000,{},fetchImpl))}),
    async()=>({source:"Binance Data API",candles:parseBinanceCandles(await fetchJson("https://data-api.binance.vision"+path,10000,{},fetchImpl))})
  ]);
}

async function okxCandles(symbol,timeframe,limit,fetchImpl){
  const d=await fetchJson(`https://openapi.okx.com/api/v5/market/candles?instId=${encodeURIComponent(okxSpot(symbol))}&bar=${encodeURIComponent(OKX_TF[timeframe])}&limit=${limit}`,10000,{},fetchImpl);
  return{source:"OKX",candles:parseOkxCandles(d?.data,timeframe)};
}

async function krakenCandles(symbol,timeframe,limit,fetchImpl){
  const pair=KRAKEN_PAIR[symbol];if(!pair||!KRAKEN_TF[timeframe])throw new Error("Kraken scope unavailable");
  const d=await fetchJson(`https://api.kraken.com/0/public/OHLC?pair=${encodeURIComponent(pair)}&interval=${KRAKEN_TF[timeframe]}`,10000,{},fetchImpl),key=Object.keys(d?.result||{}).find(x=>x!=="last");
  return{source:"Kraken",candles:parseKrakenCandles((d?.result?.[key]||[]).slice(-limit),timeframe)};
}

async function alpacaCandles(symbol,timeframe,limit,env,fetchImpl){
  if(!env?.ALPACA_KEY_ID||!env?.ALPACA_SECRET_KEY)throw new Error("Alpaca credentials are not configured");
  const sec=TF_SECONDS[timeframe],start=new Date(Date.now()-sec*limit*2.5*1000).toISOString(),url=`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/bars?timeframe=${ALPACA_TF[timeframe]}&start=${encodeURIComponent(start)}&limit=${limit}&adjustment=raw&feed=${encodeURIComponent(env.ALPACA_FEED||"iex")}`;
  const d=await fetchJson(url,12000,{"APCA-API-KEY-ID":env.ALPACA_KEY_ID,"APCA-API-SECRET-KEY":env.ALPACA_SECRET_KEY},fetchImpl),rows=(d?.bars||[]).map(r=>[Math.floor(Date.parse(r.t)/1000),+r.o,+r.h,+r.l,+r.c,+r.v]).filter(r=>r.every(Number.isFinite));
  return{source:`Alpaca ${env.ALPACA_FEED||"IEX"}`,candles:rows.slice(-limit)};
}

async function yahooCandles(symbol,timeframe,limit,fetchImpl){
  const ticker=YAHOO_TICKER[symbol]||symbol,[interval,range]=YAHOO_TF[timeframe],url=`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${range}&interval=${interval}`,payload=await fetchJson(url,14000,{},fetchImpl),candles=parseYahooCandles(payload,timeframe);
  return{source:"Yahoo Finance delayed",candles:candles.slice(-limit)};
}

export async function fetchCandles(symbol,timeframe,{limit=260,env={},fetchImpl=fetch}={}){
  const scope=validateScope(symbol,timeframe),crypto=scope.symbol.endsWith("USDT");
  const result=crypto?await firstOk([
    ()=>binanceCandles(scope.symbol,scope.timeframe,limit,fetchImpl),
    ()=>okxCandles(scope.symbol,scope.timeframe,limit,fetchImpl),
    ()=>krakenCandles(scope.symbol,scope.timeframe,limit,fetchImpl)
  ]):await firstOk([()=>alpacaCandles(scope.symbol,scope.timeframe,limit,env,fetchImpl),()=>yahooCandles(scope.symbol,scope.timeframe,limit,fetchImpl)]);
  if(!result.candles||result.candles.length<80)throw new Error(`insufficient closed candles for ${scope.symbol} ${scope.timeframe}`);
  return{...result,symbol:scope.symbol,timeframe:scope.timeframe,fetchedAt:Date.now(),closedThrough:result.candles.at(-1)[0]};
}

async function binanceDerivatives(symbol,fetchImpl){
  const [premium,oi,oiHist,ticker]=await Promise.all([
    fetchJson(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${encodeURIComponent(symbol)}`,7000,{},fetchImpl),
    fetchJson(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${encodeURIComponent(symbol)}`,7000,{},fetchImpl),
    fetchJson(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${encodeURIComponent(symbol)}&period=5m&limit=288`,9000,{},fetchImpl).catch(()=>[]),
    fetchJson(`https://api.binance.com/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbol)}`,7000,{},fetchImpl)
  ]);
  const hist=Array.isArray(oiHist)?oiHist:[],first=finite(hist[0]?.sumOpenInterestValue),last=finite(hist.at(-1)?.sumOpenInterestValue),mark=finite(premium?.markPrice),openInterest=finite(oi?.openInterest);
  return{source:"Binance Futures",fundingRate:finite(premium?.lastFundingRate),markPrice:mark,openInterestContracts:openInterest,openInterestUsd:openInterest&&mark?openInterest*mark:null,openInterestChange24h:first&&last?last/first-1:null,priceChange24h:finite(ticker?.priceChangePercent)!=null?+ticker.priceChangePercent/100:null,quoteVolume24h:finite(ticker?.quoteVolume),asOf:Math.max(finite(premium?.time)||0,finite(oi?.time)||0,finite(ticker?.closeTime)||0)};
}

async function okxDerivatives(symbol,fetchImpl){
  const inst=okxSwap(symbol),[fund,oi,ticker]=await Promise.all([
    fetchJson(`https://openapi.okx.com/api/v5/public/funding-rate?instId=${encodeURIComponent(inst)}`,7000,{},fetchImpl),
    fetchJson(`https://openapi.okx.com/api/v5/public/open-interest?instType=SWAP&instId=${encodeURIComponent(inst)}`,7000,{},fetchImpl),
    fetchJson(`https://openapi.okx.com/api/v5/market/ticker?instId=${encodeURIComponent(inst)}`,7000,{},fetchImpl)
  ]),f=fund?.data?.[0]||{},o=oi?.data?.[0]||{},t=ticker?.data?.[0]||{},last=finite(t.last),open=finite(t.open24h);
  return{source:"OKX Swap",fundingRate:finite(f.fundingRate),markPrice:last,openInterestContracts:finite(o.oi),openInterestUsd:finite(o.oiUsd),openInterestChange24h:null,priceChange24h:last&&open?last/open-1:null,quoteVolume24h:finite(t.volCcy24h),asOf:Math.max(finite(f.ts)||0,finite(o.ts)||0,finite(t.ts)||0)};
}

export async function fetchDerivativesContext(symbol,{fetchImpl=fetch}={}){
  const s=cleanSymbol(symbol);if(!s.endsWith("USDT"))return{available:false,reason:"derivatives context only supports USDT crypto"};
  try{return{available:true,...await binanceDerivatives(s,fetchImpl)};}catch(binanceError){
    try{return{available:true,...await okxDerivatives(s,fetchImpl),fallbackReason:binanceError?.message||String(binanceError)};}
    catch(okxError){return{available:false,reason:[binanceError?.message,okxError?.message].filter(Boolean).join(" | ")};}
  }
}

function fredValues(payload){
  return(payload?.observations||[]).map(x=>({date:x.date,value:finite(x.value)})).filter(x=>x.value!=null);
}
async function fredSeries(id,key,fetchImpl){
  const d=await fetchJson(`https://api.stlouisfed.org/fred/series/observations?series_id=${encodeURIComponent(id)}&api_key=${encodeURIComponent(key)}&file_type=json&sort_order=desc&limit=12`,10000,{},fetchImpl);
  return fredValues(d);
}
const ratioChange=(rows,index)=>rows.length>index&&rows[index].value?rows[0].value/rows[index].value-1:null;
const pointChange=(rows,index)=>rows.length>index?rows[0].value-rows[index].value:null;

export async function fetchMacroContext(apiKey,{fetchImpl=fetch}={}){
  if(!apiKey)return{available:false,reason:"FRED_API_KEY is not configured",missing:["FRED_API_KEY"],source:"FRED"};
  const [nominal,real,dollar,vix,balance]=await Promise.all([
    fredSeries("DGS10",apiKey,fetchImpl),fredSeries("DFII10",apiKey,fetchImpl),fredSeries("DTWEXBGS",apiKey,fetchImpl),fredSeries("VIXCLS",apiKey,fetchImpl),fredSeries("WALCL",apiKey,fetchImpl)
  ]);
  const dates=[nominal[0]?.date,real[0]?.date,dollar[0]?.date,vix[0]?.date,balance[0]?.date].filter(Boolean).sort();
  return{available:true,source:"FRED",asOf:dates[0]||null,latest:{nominal10y:nominal[0]?.value??null,real10y:real[0]?.value??null,broadDollar:dollar[0]?.value??null,vix:vix[0]?.value??null,fedBalanceMillions:balance[0]?.value??null},nominalYieldChange5d:pointChange(nominal,5),realYieldChange5d:pointChange(real,5),dollarChange5d:ratioChange(dollar,5),vixChange5d:ratioChange(vix,5),fedBalanceChange4w:ratioChange(balance,4)};
}

export const timeframeSeconds=tf=>TF_SECONDS[tf]||3600;
