// GET-only/public BitGet WS protocol smoke. NO API keys and NO orders.
import WebSocket from "ws";
const url="wss://ws.bitget.com/v2/ws/public";
let done=false;
await new Promise((resolve,reject)=>{
  const ws=new WebSocket(url,{handshakeTimeout:10000});
  const timeout=setTimeout(()=>finish(new Error("No literal pong from BitGet WS within 20 seconds")),20000);
  function finish(err){
    if(done)return;done=true;
    clearTimeout(timeout);
    try{ws.close();}catch{}
    if(err)reject(err);else resolve();
  }
  ws.on("open",()=>{
    ws.send(JSON.stringify({op:"subscribe",args:[{instType:"SPOT",channel:"ticker",instId:"BTCUSDT"}]}));
    ws.send("ping"); // BitGet docs require literal text "ping".
  });
  ws.on("message",buf=>{
    const data=buf.toString();
    if(data==="pong"){
      console.log("BITGET_WS_SMOKE_OK literal pong received");
      finish();
    }
  });
  ws.on("error",err=>finish(err));
  ws.on("close",()=>{if(!done)finish(new Error("BitGet WS closed before acknowledging heartbeat"));});
});
