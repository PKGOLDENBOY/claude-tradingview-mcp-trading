import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startBitgetHeartbeat } from "../lib/bitget-ws-heartbeat.mjs";

function harness(){
  let clock=0,tick=null,terminated=0,cancelled=false,pong=0,stale=0;
  const sent=[];
  const socket={readyState:1,send:msg=>sent.push(msg),terminate:()=>terminated++};
  const hb=startBitgetHeartbeat(socket,{
    now:()=>clock,schedule:f=>{tick=f;return 31;},
    cancel:n=>{assert.equal(n,31);cancelled=true;},
    onPong:()=>pong++,onStale:()=>stale++,
  });
  return {hb,socket,sent,step:time=>{clock=time;tick();},
    get:()=>({terminated,cancelled,pong,stale})};
}
test("BitGet heartbeat sends literal text ping, not JSON",()=>{
  const a=harness();
  a.step(25000);
  assert.deepEqual(a.sent,["ping"]);
  assert.equal(a.get().terminated,0);
  a.hb.stop();
});
test("literal pong confirms heartbeat and resets timer",()=>{
  const a=harness();
  a.step(25000);
  assert.equal(a.hb.handleMessage(Buffer.from("pong")),true);
  assert.equal(a.hb.handleMessage("pong"),true);
  assert.equal(a.get().pong,1,"Only first pong should be logged");
  a.step(85000); // 60 seconds after lastPong, under 70s timeout
  assert.equal(a.get().terminated,0);
  a.step(105001); // now stale > 70 seconds after pong
  assert.equal(a.get().terminated,1);
  assert.equal(a.get().stale,1);
  assert.equal(a.get().cancelled,true);
});
test("JSON pong is not accepted as plain-text BitGet acknowledgement",()=>{
  const a=harness();
  assert.equal(a.hb.handleMessage('{"op":"pong"}'),false);
  a.step(72000);
  assert.equal(a.get().stale,1);
});
test("closed connections do not emit more heartbeats",()=>{
  const a=harness();a.socket.readyState=3;a.step(25000);
  assert.equal(a.sent.length,0);
  assert.equal(a.get().cancelled,true);
});
test("WebSocket send errors force generation-safe reconnection",()=>{
  const a=harness();
  a.socket.send=()=>{throw new Error("socket broken")};
  a.step(25000);
  assert.equal(a.get().terminated,1);
  assert.equal(a.get().stale,1);
});
test("production bot imports heartbeat and no longer sends JSON-shaped pings",()=>{
  const src=readFileSync(new URL("../bot.js",import.meta.url),"utf8");
  assert.match(src,/startBitgetHeartbeat\(ws/);
  assert.ok(!src.includes('ws.send(JSON.stringify({ op: "ping" }))'));
  assert.match(src,/heartbeat\?\.stop\(\)/);
});
