#!/usr/bin/env node
/** One-shot predeclared strategy diagnostic on public Bitget candles. */
import {mkdirSync,writeFileSync,renameSync} from 'node:fs';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {INTERVAL_MS,prepareSeries,chronologicalSplits} from '../lib/accelerator-core.mjs';
import {loadHistoryForSymbols,CORE_SYMBOLS} from '../lib/accelerator-data.mjs';
import {HYPOTHESIS,evaluatePredeclaredTrend} from '../lib/trend-pullback-hypothesis.mjs';

export function parseArgs(argv){
  const opts={days:180,cacheDir:'research-data/cache',output:'research-data/reports/trend-pullback-v1.json',
    asofMs:Math.floor(Date.now()/INTERVAL_MS)*INTERVAL_MS};
  for(const arg of argv){
    const match=/^--([a-z-]+)=(.+)$/.exec(arg);
    if(!match)throw new Error('UNKNOWN_CLI_ARGUMENT: '+arg);
    const [,k,v]=match;
    if(k==='days')opts.days=Number(v);
    else if(k==='cache-dir')opts.cacheDir=v;
    else if(k==='output')opts.output=v;
    else if(k==='asof')opts.asofMs=Date.parse(v);
    else throw new Error('UNKNOWN_CLI_ARGUMENT: '+k);
  }
  if(!Number.isSafeInteger(opts.days)||opts.days<60||opts.days>365 ||
     !Number.isSafeInteger(opts.asofMs)||opts.asofMs%INTERVAL_MS!==0 ||
     opts.asofMs>Date.now() || typeof opts.output!=='string'||!opts.output)
     throw new Error('INVALID_RESEARCH_CLI_ARGUMENTS');
  return opts;
}

export async function evaluateMain(argv=process.argv.slice(2)){
  const args=parseArgs(argv);
  console.log(JSON.stringify({event:'PREDECLARED_TREND_START',
    asof:new Date(args.asofMs).toISOString(),days:args.days,assets:CORE_SYMBOLS,
    safety:'PUBLIC_GET_NO_ORDERS',holdout:'SEALED_CONSUMED_OCT29'}));
  const history=await loadHistoryForSymbols({symbols:CORE_SYMBOLS,
    cacheDir:args.cacheDir,lookbackDays:args.days,asofMs:args.asofMs});
  const series=Object.fromEntries(Object.entries(history.data)
    .map(([symbol,bars])=>[symbol,prepareSeries(bars)]));
  const splits=chronologicalSplits(history.data.BTCUSDT.length);
  const result=evaluatePredeclaredTrend(series,splits);
  const sourceHash=createHash('sha256').update(JSON.stringify(HYPOTHESIS)).digest('hex');
  const report={time:new Date().toISOString(),datasetSha256:history.datasetSha256,
    hypothesisSha256:sourceHash,asof:new Date(args.asofMs).toISOString(),
    candidateId:HYPOTHESIS.id,source:'PUBLIC_BITGET_1H_HISTORICAL',
    ...result,
    limitations:[
      'This uses previously observed historical validation only, so it is exploration not independent confirmation.',
      'No fresh independent out-of-sample, no forward paper trading and no real-money authorization.',
      'OHLC execution approximates fills and can overstate results (spread, gaps, funding, queue, real depth).',
      'No simultaneous portfolio-equity drawdown, correlations or cross-asset risk replay.',
    ],
  };
  mkdirSync(dirname(args.output),{recursive:true});
  const tmp=args.output+'.tmp';
  writeFileSync(tmp,JSON.stringify(report,null,2)+'\n',{mode:0o600});
  renameSync(tmp,args.output);
  console.log(JSON.stringify({event:'PREDECLARED_TREND_RESULT',
    at:report.time,candidateId:report.candidateId,
    pnlUSD:result.validation.pnlUSD,trades:result.validation.trades,
    positiveFolds:result.validation.positiveFolds,
    folds:result.validation.folds.map(f=>({fold:f.fold,trades:f.validation.trades,
      pnlUSD:f.validation.pnlUSD,profitFactor:f.validation.profitFactor,
      maxDrawdownUSD:f.validation.maxDrawdownUSD})),
    datasetSha256:history.datasetSha256,output:args.output,
    status:report.status,noRealOrders:true,noIndependentOos:true}));
  return report;
}
if(process.argv[1] && fileURLToPath(import.meta.url)===fileURLToPath(new URL('file://'+process.argv[1]))){
  try{await evaluateMain();}
  catch(err){console.error(JSON.stringify({event:'PREDECLARED_TREND_FAILED',
    reason:String(err?.message||err).slice(0,250),safety:'NO_ORDERS'}));
    process.exitCode=1;}
}
