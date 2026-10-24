import test from "node:test";
import assert from "node:assert/strict";
import { positionPnl } from "../scripts/market-shadow-test.mjs";
import { entrySafety, exitThresholdReason } from "../lib/shadow-execution-safety.mjs";

test("large bid/last divergence triggers executable stop, not false hold",()=>{
  const position={quantity:1,entryPrice:100,totalCost:100.1,opened:Date.now()};
  const quote={lastPr:"100",askPr:"100",bidPr:"85.8"};
  const net=positionPnl(position,quote);
  assert.ok(net < -14);
  assert.equal(exitThresholdReason(net,position.totalCost,{stop:.03,tp:.06}),"STOP");
  assert.equal(entrySafety(quote,null).reason,"spread-too-wide");
});
test("missing executable bid does not invent a profitable exit from last trade",()=>{
  const position={quantity:1,entryPrice:100,totalCost:100.1,opened:Date.now()};
  assert.equal(positionPnl(position,{lastPr:"120"}),null);
});
test("normal spread and fee-adjusted simulated result",()=>{
  const position={quantity:1,entryPrice:100,totalCost:100.1,opened:Date.now()};
  const pnl=positionPnl(position,{lastPr:"100",bidPr:"99.99",askPr:"100.01"});
  assert.ok(pnl < 0);
  assert.ok(pnl > -1);
});
