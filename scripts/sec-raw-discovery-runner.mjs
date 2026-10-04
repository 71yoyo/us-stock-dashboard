import { readFileSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { latestRawAccession } from '../worker/src/sec-standard-raw-runtime.js';
import { buildCompactSecRawMessage } from './sec-raw-compact-producer.mjs';
import { validatePromotionEnvelope,assertHistoricalScopeProcessed,currentCheckpoint } from './sec-raw-promotion.mjs';
import { createSecRawQueueTransport,queueTransportFailure } from './sec-raw-queue-transport.mjs';
import { createAdminDatabase } from './specialized-d1-admin.mjs';

/** Node one-shot interface다. 원문 취득은 injectable loader이며 자동 다운로드/daemon/Cron은 만들지 않는다. */
export async function runSecRawDiscovery({tickers,envelope,DB,loadCompanyFacts,transport,
  checkpoint=currentCheckpoint(),detectOnly=false,enqueueEnabled=false,dryRun=true,oneShot=true}) {
  validatePromotionEnvelope(envelope,{checkpoint});
  if (!oneShot || !Array.isArray(tickers) || !tickers.length || new Set(tickers).size !== tickers.length
    || tickers.some(ticker=>!envelope.tickers.includes(ticker))) throw new Error('SEC_RAW_DISCOVERY_SCOPE');
  if (detectOnly && enqueueEnabled) throw new Error('SEC_RAW_DISCOVERY_MODE');
  if (enqueueEnabled && !dryRun) await assertHistoricalScopeProcessed(DB,envelope);
  const results = [];
  for (const ticker of tickers) {
    const input = await loadCompanyFacts(ticker);
    if (Number(input.companyFacts?.cik) !== Number(envelope.ciks[ticker])) throw new Error('SEC_RAW_DISCOVERY_CIK');
    const accession = latestRawAccession(input.companyFacts.facts);
    const financialPeriods = (await DB.prepare(`SELECT period_type,fiscal_period_end FROM financial_metrics
      WHERE ticker=? AND source='SEC EDGAR' ORDER BY period_type,fiscal_period_end`).bind(ticker).all()).results;
    const message = await buildCompactSecRawMessage({ticker,accession,companyFacts:input.companyFacts,financialPeriods});
    const previous = await DB.prepare("SELECT accession,source_identity FROM sec_raw_payload_checkpoint WHERE ticker=? AND channel='compact'").bind(ticker).first();
    // 같은 accession도 source가 바뀌면 재처리 후보다. 신규 판정만으로 DB ready가 되지는 않는다.
    if (previous?.accession === accession && previous.source_identity === message.sourceIdentity) {
      results.push({ticker,accession,status:'unchanged'});continue;
    }
    if (detectOnly || !enqueueEnabled || dryRun) results.push({ticker,accession,status:detectOnly?'detected':'dry-run',sourceIdentity:message.sourceIdentity});
    else {
      if (!transport?.send) throw new Error('SEC_RAW_DISCOVERY_TRANSPORT');
      results.push({ticker,accession,...await transport.send(message)});
    }
  }
  return {oneShot:true,results};
}

export function parseDiscoveryArguments(args) {
  const options={dryRun:true,enqueueEnabled:false,detectOnly:false,oneShot:true};
  const values={'--ticker':'ticker','--tickers':'tickerList','--manifest':'manifestFile','--cache-dir':'cacheDir','--credential-file':'credentialFile'};
  for(let i=0;i<args.length;i++) {
    if(args[i]==='--enqueue-enabled'){options.enqueueEnabled=true;options.dryRun=false;}
    else if(args[i]==='--dry-run')options.dryRun=true;
    else if(args[i]==='--detect-only')options.detectOnly=true;
    else if(args[i]==='--one-shot')options.oneShot=true;
    else if(values[args[i]] && args[i+1] && !args[i+1].startsWith('--'))options[values[args[i]]]=args[++i];
    else throw new Error('SEC_RAW_DISCOVERY_ARGUMENTS');
  }
  if(!options.manifestFile || !options.cacheDir || !options.credentialFile
    || Boolean(options.ticker)===Boolean(options.tickerList) || options.detectOnly && options.enqueueEnabled) throw new Error('SEC_RAW_DISCOVERY_ARGUMENTS');
  options.tickers=(options.ticker || options.tickerList).split(',').map(value=>value.trim().toUpperCase());
  return options;
}

if(process.argv[1]===resolve('scripts/sec-raw-discovery-runner.mjs')) {
  try {
    if(!process.execArgv.includes('--use-system-ca'))throw new Error('SEC_RAW_SYSTEM_CA_REQUIRED');
    const options=parseDiscoveryArguments(process.argv.slice(2));
    if(options.enqueueEnabled && !options.dryRun && execFileSync('git',['status','--short'],{encoding:'utf8'}).trim()) {
      throw new Error('SEC_RAW_CLEAN_CHECKPOINT_REQUIRED');
    }
    for(const file of [options.manifestFile,options.credentialFile]) {
      execFileSync('git',['check-ignore','--quiet',file]);
      if(execFileSync('git',['ls-files',file],{encoding:'utf8'}).trim())throw new Error('SEC_RAW_LOCAL_ARTIFACT_REQUIRED');
    }
    const envelope=JSON.parse(readFileSync(options.manifestFile,'utf8'));
    validatePromotionEnvelope(envelope);
    const credential=readFileSync(options.credentialFile,'utf8').match(/^CLOUDFLARE_API_TOKEN=(.+)$/m)?.[1]?.trim();
    const DB=createAdminDatabase({accountId:envelope.queue.accountId,dbId:envelope.target.databaseId,token:credential});
    const transport=createSecRawQueueTransport({accountId:envelope.queue.accountId,queueId:envelope.queue.queueId,
      queueName:envelope.queue.name,credential,DB,envelope,enabled:options.enqueueEnabled,dryRun:options.dryRun});
    const result=await runSecRawDiscovery({...options,envelope,DB,transport,
      loadCompanyFacts:async ticker=>({companyFacts:JSON.parse(readFileSync(join(options.cacheDir,`${ticker}.json`),'utf8'))})});
    console.log(JSON.stringify(result,null,2));
  }catch(error){
    // 외부 exception/body/header를 출력하지 않고 고정 category/status만 보고한다.
    console.error(JSON.stringify({status:'stopped',...queueTransportFailure(error)}));process.exitCode=1;
  }
}
