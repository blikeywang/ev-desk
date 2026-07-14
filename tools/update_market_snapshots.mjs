import {mkdir,writeFile} from "node:fs/promises";
import path from "node:path";

const SYMBOLS={
  AAPL:"AAPL",MSFT:"MSFT",NVDA:"NVDA",AMZN:"AMZN",META:"META",GOOGL:"GOOGL",
  TSLA:"TSLA",AMD:"AMD",AVGO:"AVGO",MU:"MU",SPY:"SPY",QQQ:"QQQ",NDX:"^NDX",
  NQ:"NQ=F",XAUUSD:"GC=F",WTI:"CL=F"
};
const SPECS={"1m":["1m","5d"],"5m":["5m","1mo"],"15m":["15m","1mo"],"1h":["60m","3mo"],"1d":["1d","2y"]};
const TF_SECONDS={"1m":60,"5m":300,"15m":900,"1h":3600,"4h":14400,"1d":86400};
const outputDir=path.resolve(process.argv[2]||"data/market-snapshots");
const requested=String(process.env.SYMBOLS||Object.keys(SYMBOLS).join(",")).split(",").map(x=>x.trim().toUpperCase()).filter(Boolean);

const finite=value=>Number.isFinite(+value)?+value:null;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function fetchText(url,timeout=20000){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
  try{
    const response=await fetch(url,{signal:controller.signal,headers:{accept:"application/json,text/plain;q=0.9,*/*;q=0.1","user-agent":"ev-desk-market-snapshot/1.0"}});
    const text=await response.text();
    if(!response.ok)throw new Error(`HTTP ${response.status}`);
    return text;
  }finally{clearTimeout(timer);}
}

function parseJina(text){
  const marker="Markdown Content:",at=text.indexOf(marker),body=(at>=0?text.slice(at+marker.length):text).trim();
  const start=body.indexOf("{"),end=body.lastIndexOf("}");
  if(start<0||end<=start)throw new Error("Jina response did not contain JSON");
  return JSON.parse(body.slice(start,end+1));
}

async function fetchChart(ticker,interval,range){
  const encoded=encodeURIComponent(ticker),query=`range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}`,errors=[];
  for(const host of ["query2.finance.yahoo.com","query1.finance.yahoo.com"]){
    const url=`https://${host}/v8/finance/chart/${encoded}?${query}`;
    try{return JSON.parse(await fetchText(url));}catch(error){errors.push(`${host}: ${error.message}`);}
  }
  try{
    const url=`https://r.jina.ai/http://query2.finance.yahoo.com/v8/finance/chart/${encoded}?${query}`;
    return parseJina(await fetchText(url,30000));
  }catch(error){errors.push(`jina: ${error.message}`);}
  throw new Error(errors.join(" | "));
}

function aggregateSessionCandles(rows,size=4,offsetSec=0){
  const out=[];let day="",index=0,key="",bar=null;
  const flush=()=>{if(bar)out.push(bar);bar=null;};
  for(const row of rows){
    const localDay=new Date((row[0]+offsetSec)*1000).toISOString().slice(0,10);
    if(localDay!==day){flush();day=localDay;index=0;key="";}
    const nextKey=day+"|"+Math.floor(index/size);
    if(nextKey!==key){flush();key=nextKey;bar=[...row];}
    else{bar[2]=Math.max(bar[2],row[2]);bar[3]=Math.min(bar[3],row[3]);bar[4]=row[4];bar[5]+=row[5];}
    index++;
  }
  flush();return out;
}

function parseCandles(payload,timeframe){
  const result=payload?.chart?.result?.[0],timestamps=result?.timestamp,quote=result?.indicators?.quote?.[0];
  if(!Array.isArray(timestamps)||!quote)throw new Error("chart payload is empty");
  const sourceSec=timeframe==="1d"?86400:(timeframe==="4h"||timeframe==="1h")?3600:TF_SECONDS[timeframe],now=Math.floor(Date.now()/1000),isIndex=result?.meta?.instrumentType==="INDEX",rows=[];
  for(let i=0;i<timestamps.length;i++){
    const close=finite(quote.close?.[i]),ts=finite(timestamps[i]);
    if(close==null||ts==null||ts+sourceSec>now)continue;
    rows.push([ts,finite(quote.open?.[i])??close,finite(quote.high?.[i])??close,finite(quote.low?.[i])??close,close,isIndex?0:finite(quote.volume?.[i])??0]);
  }
  const candles=timeframe==="4h"?aggregateSessionCandles(rows,4,finite(result?.meta?.gmtoffset)??0):rows;
  return{candles:candles.slice(-400),meta:result.meta||{}};
}

function marketMeta(meta,last){
  const price=finite(meta.regularMarketPrice)??last?.[4]??null,previousClose=finite(meta.chartPreviousClose)??finite(meta.previousClose);
  return{exchange:meta.fullExchangeName||meta.exchangeName||"",state:meta.marketState||"",asOf:(finite(meta.regularMarketTime)??last?.[0]??0)*1000,price,previousClose,change:price&&previousClose?price/previousClose-1:null,instrumentType:meta.instrumentType||""};
}

async function buildSymbol(symbol,ticker){
  const payloads={},data={};let primaryMeta={};
  for(const [timeframe,[interval,range]] of Object.entries(SPECS)){
    const key=interval+"|"+range,payload=payloads[key]||(payloads[key]=await fetchChart(ticker,interval,range)),parsed=parseCandles(payload,timeframe);
    if(parsed.candles.length<80)throw new Error(`${symbol} ${timeframe} has only ${parsed.candles.length} closed candles`);
    data[timeframe]=parsed.candles;if(timeframe==="15m")primaryMeta=parsed.meta;
    await sleep(180);
  }
  const hourlyPayload=payloads["60m|3mo"],fourHour=parseCandles(hourlyPayload,"4h");
  if(fourHour.candles.length<80)throw new Error(`${symbol} 4h has only ${fourHour.candles.length} closed candles`);
  data["4h"]=fourHour.candles;
  return{schema:"ev_desk_market_snapshot_v1",symbol,ticker,source:"Yahoo Finance delayed snapshot",generatedAt:new Date().toISOString(),market:marketMeta(primaryMeta,data["15m"].at(-1)),data};
}

await mkdir(outputDir,{recursive:true});
for(const symbol of requested){
  const ticker=SYMBOLS[symbol];if(!ticker)throw new Error(`unknown symbol ${symbol}`);
  const snapshot=await buildSymbol(symbol,ticker);
  await writeFile(path.join(outputDir,`${symbol}.json`),JSON.stringify(snapshot));
  console.log(`${symbol}: ${Object.entries(snapshot.data).map(([tf,rows])=>`${tf}=${rows.length}`).join(" ")}`);
}
