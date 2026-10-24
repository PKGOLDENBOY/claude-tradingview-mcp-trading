import test from "node:test";
import assert from "node:assert/strict";
import {entrySafety,spreadBps,STOP_REENTRY_COOLDOWN_MS} from "../lib/shadow-execution-safety.mjs";
test("wide spreads blocked",()=>assert.equal(entrySafety({bidPr:"80",askPr:"100"},null).reason,"spread-too-wide"));
test("missing and crossed quotes blocked",()=>{assert.equal(entrySafety({lastPr:"100"},null).allowed,false);assert.equal(spreadBps({bidPr:101,askPr:100}),null);});
test("stop cooldown blocks immediate reentry",()=>{const now=10000000;assert.equal(entrySafety({bidPr:99.99,askPr:100},now-1000,now).reason,"post-stop-cooldown");assert.equal(entrySafety({bidPr:99.99,askPr:100},now-STOP_REENTRY_COOLDOWN_MS,now).allowed,true);});
