import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function makeCsvWriter() {
  const src=readFileSync(new URL("../bot.js",import.meta.url),"utf8");
  const begin=src.indexOf("function initCsv() {");
  const end=src.indexOf("// Tax summary command:",begin);
  assert(begin>=0&&end>begin,"Cannot find CSV writer");
  const writes=new Map();
  const fs={
    existsSync:(p)=>writes.has(p),
    writeFileSync:(p,s)=>{writes.set(p,s);},
    appendFileSync:(p,s)=>{writes.set(p,(writes.get(p)||"")+s);}
  };
  const fn=new Function("existsSync","writeFileSync","appendFileSync","CSV_FILE",
    "getFeePct","acct","SNIPER","emailEntry","emailExit","PAPER_FEE_FRACTION",
    src.slice(begin,end)+"\nreturn {initCsv,writeTradeCsv};");
  const writer=fn(fs.existsSync,fs.writeFileSync,fs.appendFileSync,
    "in-memory.csv",()=>0.00064,()=>({exchange:"bitget"}),
    {trailActivatePct:0.1,trailPct:0.2,maxHoldMin:60,stopLossPct:0.1},
    ()=>{},()=>{},0.001);
  return {...writer,get:()=>writes.get("in-memory.csv")};
}
test("empty ledger has ONLY a header and no unrelated marketing note",()=>{
  const writer=makeCsvWriter();writer.initCsv();
  const lines=writer.get().trim().split("\n");
  assert.equal(lines.length,1);
  assert.match(lines[0],/Date,Time \(UTC\),Exchange/);
});
test("completed swing sells are correctly marked PAPER SELL, not HELD",()=>{
  const w=makeCsvWriter();w.initCsv();
  w.writeTradeCsv({timestamp:"2026-10-19T18:00:00Z",type:"exit",symbol:"BTCUSDT",
    price:80000.12345,quantity:"0.00012134",orderPlaced:true,
    paperTrading:true,tradeType:"swing",feeAdjusted:true,exitFeeUSD:0.012345,
    pnlPct:-3,pnlUSD:-0.3,exitReasons:['"Emergency" stopped']});
  const rows=w.get().trim().split("\n");
  assert.equal(rows.length,2);
  assert.ok(rows[1].includes(",SELL,"));
  assert.ok(rows[1].includes(",PAPER,"));
  assert.ok(!rows[1].includes(",HELD,"));
  assert.ok(rows[1].includes("0.012345"),"exact paper exit fee");
  assert.ok(rows[1].includes('""Emergency""'),"embedded quotes should be escaped");
});
test("micro-price and BTC quantities are recorded with 8 decimal places",()=>{
  const w=makeCsvWriter();w.initCsv();
  w.writeTradeCsv({timestamp:"2026-10-19T18:00:00Z",type:"entry",symbol:"BTCUSDT",
    price:80000.12345678,tradeSize:10,paperEntryFeeUsd:0.01,
    orderId:"PAPER-X",orderPlaced:true,paperTrading:true});
  const rows=w.get().trim().split("\n");
  assert.match(rows[1],/80000\.12345678/);
  assert.match(rows[1],/0\.00012500/);
  assert.ok(rows[1].includes("0.010000"));
});

test("paper sniper entries are PAPER, fee-adjusted, and retain 8-decimal quantity",()=>{
  const w=makeCsvWriter();w.initCsv();
  w.writeTradeCsv({timestamp:"2026-10-20T18:00:00Z",type:"entry",symbol:"BTCUSDT",
    tradeType:"sniper",paperTrading:true,orderPlaced:true,
    price:80000,tradeSize:10,paperEntryFeeUsd:0.012345,orderId:"PAPER-SNIPER-A"});
  const row=w.get().trim().split("\n").at(-1);
  assert.ok(row.includes(",PAPER,"));
  assert.ok(!row.includes(",LIVE,"));
  assert.ok(row.includes(",0.00012500,"));
  assert.ok(row.includes(",0.012345,"));
});
test("paper sniper exits record adjusted fees and never claim LIVE",()=>{
  const w=makeCsvWriter();w.initCsv();
  w.writeTradeCsv({timestamp:"2026-10-20T19:00:00Z",type:"exit",symbol:"BTCUSDT",
    tradeType:"sniper",paperTrading:true,orderPlaced:true,feeAdjusted:true,
    quantity:0.000125,price:81000,pnlPct:1.25,pnlUSD:0.1,
    exitFeeUSD:0.017123,exitReasons:["stop"],orderId:"PAPER-SNIPER-B"});
  const row=w.get().trim().split("\n").at(-1);
  assert.ok(row.includes(",PAPER,"));
  assert.ok(!row.includes(",LIVE,"));
  assert.ok(row.includes(",0.017123,"));
});
test("existing LIVE sniper accounting remains labelled LIVE",()=>{
  const w=makeCsvWriter();w.initCsv();
  w.writeTradeCsv({timestamp:"2026-10-20T20:00:00Z",type:"entry",symbol:"BTCUSDT",
    tradeType:"sniper",paperTrading:false,orderPlaced:true,
    price:80000,tradeSize:10,orderId:"LIVE-SNIPER-A"});
  const row=w.get().trim().split("\n").at(-1);
  assert.ok(row.includes(",LIVE,"));
  assert.ok(!row.includes(",PAPER,"));
  assert.ok(row.includes(",0.000125,"));
});
