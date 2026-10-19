// BitGet exchange WebSocket heartbeat (v2 public trading feed).
// BitGet expects a literal text frame "ping", replies with literal "pong".
// Sending JSON.stringify({op:"ping"}) is NOT a valid heartbeat and leads to
// disconnections after roughly two minutes despite normal market data.
export function startBitgetHeartbeat(socket,opts={}) {
  const now=opts.now??Date.now;
  const every=opts.pingEveryMs??25000;
  const staleAfter=opts.pongTimeoutMs??70000;
  const schedule=opts.schedule??setInterval;
  const cancel=opts.cancel??clearInterval;
  const onPong=opts.onPong??(()=>{});
  const onStale=opts.onStale??(()=>{});
  let lastPong=now();
  let closed=false;
  let seenPong=false;
  const timer=schedule(()=>{
    if(closed)return;
    if(socket.readyState!==1) { stop();return; }
    if(now()-lastPong>staleAfter) {
      stop();
      onStale();
      try{socket.terminate();}catch{}
      return;
    }
    try{socket.send("ping");}
    catch{
      stop();
      onStale();
      try{socket.terminate();}catch{}
    }
  },every);
  function handleMessage(data){
    const frame=(typeof data==="string"?data:String(data)).trim();
    if(frame!=="pong")return false;
    lastPong=now();
    if(!seenPong){seenPong=true;onPong();}
    return true;
  }
  function stop(){
    if(closed)return;
    closed=true;
    cancel(timer);
  }
  return {handleMessage,stop,getLastPong:()=>lastPong};
}
