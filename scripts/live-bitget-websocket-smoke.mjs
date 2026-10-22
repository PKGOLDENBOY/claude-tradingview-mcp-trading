/**
 * No-trade PUBLIC BitGet WebSocket integration. No exchange keys or orders.
 * Confirms at least one real spot quote and a literal pong heartbeat.
 */
import WebSocket from "ws";
import {startBitgetHeartbeat} from "../lib/bitget-ws-heartbeat.mjs";
const endpoint="wss://ws.bitget.com/v2/ws/public";
let socket=null,clock=null,heartbeat=null,opened=false,subscribed=false;
let quotes=0,pongs=0,unexpected=0,errors=[];
const emit=(tag,fields={})=>console.log(JSON.stringify({tag,now:new Date().toISOString(),...fields}));
const finalize=(err)=>{
  try{heartbeat?.stop()}catch{}
  try{clearTimeout(clock)}catch{}
  try{socket?.terminate()}catch{}
  if(err){emit("PUBLIC_WS_FAILURE",{error:String(err),opened,subscribed,quotes,pongs,errors});process.exitCode=1;}
  else emit("PUBLIC_WS_SUCCESS",{opened,subscribed,quotes,pongs,orders:0,credentials:0});
};
try{
  socket=new WebSocket(endpoint,{
    handshakeTimeout:12000,perMessageDeflate:false,
    headers:{"User-Agent":"AlphaBot-PUBLIC-NoOrder-CI/1"},
  });
  clock=setTimeout(()=>finalize(new Error("WebSocket feed heartbeat or quote timed out")),55000);
  socket.on("open",()=>{
    opened=true;
    socket.send(JSON.stringify({op:"subscribe",args:[
      {instType:"SPOT",channel:"ticker",instId:"BTCUSDT"},
      {instType:"SPOT",channel:"ticker",instId:"ETHUSDT"},
    ]}));
    heartbeat=startBitgetHeartbeat(socket,{
      pingEveryMs:7000,pongTimeoutMs:25000,
      onPong:()=>{pongs++;emit("PUBLIC_WS_PONG",{pongs})},
      onStale:()=>{errors.push("stale heartbeat");finalize(new Error("Public WebSocket stopped responding"))},
    });
    emit("PUBLIC_WS_OPEN");
  });
  socket.on("message",(raw)=>{
    const msg=raw.toString();
    if(heartbeat?.handleMessage(msg)){
      if(quotes>0&&pongs>0)finalize();
      return;
    }
    try{
      const data=JSON.parse(msg);
      if(data.event==="subscribe"){subscribed=true;return;}
      if(data?.arg?.channel==="ticker"&&Array.isArray(data.data)){
        for(const tick of data.data){
          const price=Number(tick.lastPr),sym=tick.instId||data.arg.instId;
          if(Number.isFinite(price)&&price>0&&["BTCUSDT","ETHUSDT"].includes(sym))quotes++;
          else unexpected++;
        }
        if(quotes>0&&pongs>0)finalize();
      }else if(data.event==="error")errors.push("BitGet error "+JSON.stringify(data).slice(0,280));
    }catch{unexpected++}
  });
  socket.on("error",err=>{errors.push(String(err.message).slice(0,200));finalize(err)});
  socket.on("close",code=>{
    if(!opened)return;
    if(process.exitCode===1)return;
    if(!(quotes>0&&pongs>0))finalize(new Error("Unexpected close "+code));
  });
}catch(err){finalize(err)}
