/**
 * Live public-market, paper-locked, whole-bot startup/HTTP/shadow smoke.
 * Executes NO exchange order: all real-order flags OFF, daily entry cap 0.
 * Uses NO exchange credentials, Anthropic keys or Resend keys.
 * Runs against a disposable GitHub Actions runner, never the user's bot.
 */
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtempSync,readFileSync,existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
const work=mkdtempSync(join(tmpdir(),"alphabot-readonly-e2e-"));
const stateFile=join(work,"account.json"),ltFile=stateFile+".lt-shadow.json";
const pin="909090909090",secret="github-paper-shadow-smoke-secret";
const port=41771,origin="http://127.0.0.1:"+port;
const now=()=>Date.now(),sleep=ms=>new Promise(ok=>setTimeout(ok,ms));
let failures=0;
function safeLog(s){return s.replaceAll(secret,"[REDACTED]").replaceAll(pin,"[REDACTED_PIN]").slice(-9000)}
function start(){
  const child=spawn(process.execPath,["bot.js"],{
    cwd:process.cwd(),
    env:{
      ...process.env,
      PORT:String(port),STATE_FILE:stateFile,
      PAPER_TRADING:"true",LIVE_TRADING_ENABLED:"false",LIVE_TRADING_APPROVED:"false",
      LT_PAPER_SHADOW_ENABLED:"true",LT_ENABLED:"false",
      MAX_ENTRIES_PER_DAY:"0",MAX_TRADES_PER_DAY:"0",
      SWING_TRADING:"false",ALLOW_NEW_SWING_ENTRIES:"false",
      ALLOW_NEW_BREAKOUT_ENTRIES:"false",ENABLE_MOVER_DISCOVERY:"false",
      SNIPER_ENABLED:"false",BITMART_ENABLED:"false",READ_ONLY_ACCOUNT_AUDIT:"false",
      SYMBOLS:"BTCUSDT,ETHUSDT",SYMBOL:"BTCUSDT",
      BOT_PIN:pin,WEBHOOK_SECRET:secret,NOTIFY_EMAIL:"",
      RESEND_API_KEY:"",ANTHROPIC_API_KEY:"",
      // Paper-mode must boot with absolutely NO exchange credentials.
      BITGET_API_KEY:"",BITGET_SECRET_KEY:"",BITGET_PASSPHRASE:"",
    },stdio:["ignore","pipe","pipe"],
  });
  let output="";
  child.stdout.on("data",d=>{output+=(d+"").slice(-25000);output=output.slice(-80000)});
  child.stderr.on("data",d=>{output+=(d+"").slice(-25000);output=output.slice(-80000)});
  const finished=new Promise(resolve=>child.on("exit",(code,signal)=>resolve({code,signal})));
  return {child,finished,get output(){return output;}};
}
async function request(path,opts={},maxMs=10000){
  return await fetch(origin+path,{
    ...opts,signal:AbortSignal.timeout(maxMs),
  });
}
async function waitForHealthy(child,maxMs=40000){
  const until=now()+maxMs;
  while(now()<until){
    if(child.child.exitCode!==null)throw Error("Exited during boot: "+safeLog(child.output));
    try{
      const h=await request("/health",{},1200);
      if(h.status===200)return await h.json();
    }catch{}
    await sleep(500);
  }
  throw Error("Bot did not serve /health: "+safeLog(child.output));
}
function readLt(){return JSON.parse(readFileSync(ltFile,"utf8"));}
async function waitForLt(child,maxMs){
  const until=now()+maxMs;
  while(now()<until){
    if(child.child.exitCode!==null)throw Error("Crash during LT evaluation: "+safeLog(child.output));
    if(existsSync(ltFile)){
      try{const st=readLt();if(st?.lastStatus?.timestamp)return st;}catch{}
    }
    await sleep(1700);
  }
  throw Error("Long-term strategy failed to produce initial report: "+safeLog(child.output));
}
async function stop(obj){
  if(obj.child.exitCode===null)obj.child.kill("SIGTERM");
  await Promise.race([obj.finished,sleep(5000)]);
  if(obj.child.exitCode===null)obj.child.kill("SIGKILL");
}
let first=null,second=null;
try{
  first=start();
  const h=await waitForHealthy(first,45000);
  assert.equal(h.status,"OK");
  assert.equal(h.mode,"PAPER_LOCKED");
  assert.equal(h.exchangeWritesAllowed,false);
  assert.equal(h.guards.entryCapPerDay,0);
  console.log("E2E_HEALTH_OK",JSON.stringify({mode:h.mode,orderWrites:h.exchangeWritesAllowed,entryCap:h.guards.entryCapPerDay}));
  for(const endpoint of ["/status","/api/status","/api/recovery"]){
    const response=await request(endpoint);
    assert.equal(response.status,401,endpoint+" private endpoint exposed");
  }
  const unauthed=await request("/webhook",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({action:"BUY",symbol:"BTCUSDT",secret:"wrong"}),
  });
  assert.equal(unauthed.status,401);
  const unknown=await request("/webhook",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({action:"BUY",symbol:"FAKEUSDT",secret}),
  });
  assert.equal(unknown.status,400);
  const oversize=await request("/webhook",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({action:"BUY",symbol:"BTCUSDT",secret,fill:"A".repeat(9000)}),
  });
  assert.equal(oversize.status,413);
  const authed=await request("/status?pin="+pin);
  assert.equal(authed.status,200);
  const stat=await authed.json();
  assert.equal(stat.paused,false);
  console.log("E2E_WEBHOOK_AND_STATUS_OK",JSON.stringify({
    unauthorized:unauthed.status,unknownSymbol:unknown.status,
    oversize:oversize.status,statusAuth:authed.status,
  }));
  const lt=await waitForLt(first,175000);
  assert.equal(lt.mode,"PUBLIC_MARKET_READ_ONLY_LONGTERM");
  assert.ok(lt.lastStatus);
  assert.equal(lt.lastStatus.realOrders,0);
  assert.ok(Number.isFinite(lt.cashUsd) && lt.cashUsd>=0);
  assert.ok(Array.isArray(lt.events));
  assert.ok(lt.events.every(e=>["SIMULATED_BUY","SIMULATED_SELL"].includes(e.kind)));
  const b=lt.events.filter(e=>e.kind==="SIMULATED_BUY").length;
  const a=lt.events.filter(e=>e.kind==="SIMULATED_SELL").length;
  console.log("E2E_LT_SHADOW_OK",JSON.stringify({
    policy:lt.lastStatus.policy,market:lt.lastStatus.regime,
    scored:lt.lastStatus.scoredSymbols,signals:lt.lastStatus.signals,
    dataFailures:lt.lastStatus.failedFeeds,virtualEntries:b,virtualExits:a,
    virtualEquity:lt.lastStatus.simulatedPortfolioValue,
    runtimeSeconds:Math.round((now()-Date.parse(h?.at||new Date().toISOString()))/1000),
  }));
  assert.ok(!/exchange writes: authorized/i.test(first.output),"Unexpected real-trading mode");
  assert.ok(!/LIVE TRADING\b/i.test(first.output),"Real-trading startup log detected");
  // Test persistence and non-duplicated entries after an ordinary process restart.
  await stop(first);first=null;
  second=start();
  const h2=await waitForHealthy(second,45000);
  assert.equal(h2.exchangeWritesAllowed,false);
  const before=readLt().lastStatus.timestamp;
  const cutoff=now()+35000;
  while(now()<cutoff){
    if(second.child.exitCode!==null)throw Error("Crashed after restart: "+safeLog(second.output));
    const cur=readLt();
    if(cur.lastStatus.timestamp!==before)break;
    await sleep(900);
  }
  const after=readLt();
  assert.ok(after?.lastStatus?.timestamp!==before,"No LT status after restart");
  assert.equal(after.lastStatus.realOrders,0);
  const buyCount=after.events.filter(e=>e.kind==="SIMULATED_BUY").length;
  assert.equal(buyCount,b,"Duplicate virtual entry on rapid process restart");
  console.log("E2E_RESTART_PERSISTENCE_OK",JSON.stringify({
    virtualBuysBefore:b,virtualBuysAfter:buyCount,ledgerFileExists:existsSync(ltFile),
    policy:after.lastStatus.policy,
  }));
}catch(err){
  failures++;
  console.error("E2E_FULL_BOT_SMOKE_FAILED",String(err?.stack||err).slice(0,7000));
  console.error("E2E_FIRST_PROCESS_LOG_TAIL",safeLog(first?.output||""));
  console.error("E2E_SECOND_PROCESS_LOG_TAIL",safeLog(second?.output||""));
}finally{
  if(first)await stop(first);
  if(second)await stop(second);
  console.log("E2E_SMOKE_COMPLETE",JSON.stringify({failures,safeRealOrderWrites:0}));
  if(failures)process.exitCode=1;
}
