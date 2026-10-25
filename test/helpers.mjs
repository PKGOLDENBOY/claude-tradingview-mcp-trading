import { INTERVAL_MS } from '../lib/accelerator-core.mjs';
export function syntheticBars(n=1440,{seed=23,startMs=Date.UTC(2026,1,1),trend=.0005,fluctuation=.003}={}){
  const out=[];
  let previous=100;
  let state=seed>>>0;
  const rnd=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
  for(let i=0;i<n;i++){
    // Mixed regimes: deterministic, NOT market history and not evidence of profit.
    const regime=Math.floor(i/280)%3;
    const bias=regime===0?trend:regime===1?-trend:.00002;
    const open=previous;
    const change=bias+(rnd()-.5)*fluctuation;
    const close=open*Math.exp(change);
    const range=open*(.0015+rnd()*.002);
    const high=Math.max(open,close)+range;
    const low=Math.min(open,close)-range;
    out.push({ts:startMs+i*INTERVAL_MS,open,high,low,close,volume:100000,
      quoteVolume:180000+rnd()*180000});
    previous=close;
  }
  return out;
}
export function testUniverse(n=1440){
  return Object.fromEntries(['BTCUSDT','ETHUSDT','SOLUSDT'].map((sym,i)=>
    [sym,syntheticBars(n,{seed:23+i*200,trend:.00045+i*.0001})]));
}
