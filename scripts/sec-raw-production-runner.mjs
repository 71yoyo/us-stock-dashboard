import { readFileSync,statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { validateAutomationPolicy,safeError,errorCategory } from './sec-raw-automation-policy.mjs';
import { createProductionD1Adapter } from './sec-raw-production-d1.mjs';
import { createD1ProducerReader,establishReadiness } from './sec-raw-automation-readiness.mjs';
import { createGithubJournalBackend } from './sec-raw-github-journal.mjs';
import { createMemoryJournalBackend,createProducerJournal } from './sec-raw-producer-journal.mjs';
import { createAutomationQueueTransport } from './sec-raw-automation-transport.mjs';
import { runScheduledSecRawProducer } from './sec-raw-scheduled-producer.mjs';

export const producerSecretNames=Object.freeze(['CF_QUEUE_API_TOKEN','CF_D1_READ_API_TOKEN','PRODUCER_STATE_TOKEN','SEC_USER_AGENT']);
export const producerVariableNames=Object.freeze(['CF_ACCOUNT_ID','CF_QUEUE_ID','CF_QUEUE_NAME','CF_D1_DATABASE_ID','CF_D1_DATABASE_NAME',
  'PRODUCER_STATE_REPOSITORY','PRODUCER_STATE_BRANCH','PRODUCER_STATE_PATH','PRODUCER_POLICY_PATH']);
const value=(env,key)=>{
  const text=env[key];
  if (typeof text!=='string' || !text.trim() || /[\r\n]/.test(text) || /^(?:<.*>|placeholder|changeme|todo)$/i.test(text.trim())) throw safeError('POLICY_INVALID');
  return text;
};
function loadJson(path) {
  try {if (statSync(path).size>1024*1024) throw Error();return JSON.parse(readFileSync(path,'utf8'));}
  catch {throw safeError('POLICY_INVALID');}
}

/** env는 전용 이름만 읽는다. .dev.vars/OAuth/범용 token/backup credential을 탐색하거나 병합하지 않는다. */
export function loadProductionProducerConfig({env,release,now=Date.now(),loadPolicy=loadJson}) {
  const settings=Object.fromEntries(producerVariableNames.map(key=>[key,value(env,key)]));
  const secrets=Object.fromEntries(producerSecretNames.map(key=>[key,value(env,key)]));
  if (new Set(producerSecretNames.slice(0,3).map(key=>secrets[key])).size!==3 ||
      !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(settings.PRODUCER_STATE_REPOSITORY) ||
      /(?:checkpoint-backup|stock-project)$/i.test(settings.PRODUCER_STATE_REPOSITORY) ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(settings.PRODUCER_STATE_BRANCH) ||
      !/^state\/[a-zA-Z0-9_-]+\.json$/.test(settings.PRODUCER_STATE_PATH)) throw safeError('POLICY_INVALID');
  if (env.PRODUCER_RELEASE!==undefined && env.PRODUCER_RELEASE!==release) throw safeError('RELEASE_MISMATCH');
  const target={accountId:settings.CF_ACCOUNT_ID,queueId:settings.CF_QUEUE_ID,queueName:settings.CF_QUEUE_NAME,
    databaseId:settings.CF_D1_DATABASE_ID,databaseName:settings.CF_D1_DATABASE_NAME};
  let input;try {input=loadPolicy(settings.PRODUCER_POLICY_PATH);} catch {throw safeError('POLICY_INVALID');}
  // 운영 runner는 legacy default를 쓰지 않고 algorithm version 명시를 요구한다.
  if (input?.identityAlgorithmVersion!==2) throw safeError('POLICY_INVALID');
  const policy=validateAutomationPolicy(input,{release,target,now});
  if (!policy.secFetchEnabled) throw safeError('POLICY_INVALID');
  return {settings,secrets,target,policy,release};
}

/** 후속 provisioning gate에서 발급한 연결 차단 증거만 소비한다. 이 함수가 승인서를 발급/보정하지 않는다. */
export function createDisconnectEvidenceVerifier({evidence,release,now=Date.now}) {
  return async({repository,stateBranch,statePath})=>{
    const keys=['version','release','repository','stateBranch','statePath','validFrom','expiresAt','workflows','webhooks','deployments','cloudflareConnections'];
    if (!evidence || Object.keys(evidence).sort().join('|')!==keys.sort().join('|') || evidence.version!==1 || evidence.release!==release ||
        evidence.repository!==repository || evidence.stateBranch!==stateBranch || evidence.statePath!==statePath) return false;
    const from=Date.parse(evidence.validFrom),until=Date.parse(evidence.expiresAt);
    return Number.isFinite(from) && Number.isFinite(until) && from<=now() && now()<until && until-from<=7*86400000 &&
      ['workflows','webhooks','deployments','cloudflareConnections'].every(key=>evidence[key]===0);
  };
}

/** orchestration만 담당한다. 실제 source 발견/INTENT/중복 억제/발행 예산은 기존 core를 그대로 쓴다. */
async function executeProductionSecRawProducer({env=process.env,args=[],release,loadPolicy,verifyDisconnected,
  fetchImpl=globalThis.fetch,now=Date.now,sleep,random,runId=randomUUID(),owner=randomUUID()}={}) {
  if (!Array.isArray(args) || !(args.length===0 || args.length===1 && args[0]==='--enqueue')) throw safeError('POLICY_INVALID');
  const enqueue=args.length===1;
  const currentRelease=release??execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim();
  const config=loadProductionProducerConfig({env,release:currentRelease,now:now(),loadPolicy});
  if (enqueue && !config.policy.productionEnqueueEnabled) throw safeError('POLICY_INVALID');
  let verifier=verifyDisconnected;
  if (!verifier) {
    const evidence=loadJson(value(env,'PRODUCER_DISCONNECT_EVIDENCE_PATH'));
    verifier=createDisconnectEvidenceVerifier({evidence,release:currentRelease,now});
  }
  const stateTarget={repository:config.settings.PRODUCER_STATE_REPOSITORY,stateBranch:config.settings.PRODUCER_STATE_BRANCH,
    statePath:config.settings.PRODUCER_STATE_PATH};
  if (typeof verifier!=='function' || await verifier(stateTarget)!==true) throw safeError('POLICY_INVALID');
  const DB=createProductionD1Adapter({fetchImpl,credential:config.secrets.CF_D1_READ_API_TOKEN,target:config.target,
    maxQueries:1+3*config.policy.scope.length});
  const reader=createD1ProducerReader(DB),states=new Map();
  // D1 identity/readiness가 어긋나면 SEC/Queue/journal write 전에 중단한다. network readiness는 run당 한 번이다.
  const identity=await reader.identity(),rows=await reader.readiness(config.policy.scope);
  const cachedReader={identity:async()=>identity,readiness:async()=>rows,ticker:async ticker=>{
    const state=await reader.ticker(ticker);
    const cp=state.checkpoint,rt=state.runtime;
    if (cp && rt?.raw_status==='pending' && rt.attempt_accession===cp.accession && rt.raw_schema_version===1 && rt.raw_data_version===2) {
      state.reviewEvidence={...cp,status:'pending_review'};state.checkpoint=null;
    }
    states.set(ticker,state);return state;
  }};
  await establishReadiness({policy:config.policy,reader:cachedReader,runId,now});
  const backend=createGithubJournalBackend({...stateTarget,credential:config.secrets.PRODUCER_STATE_TOKEN,fetchImpl,
    verifyDisconnected:verifier});
  const snapshot=await backend.load();
  // detect-only도 기존 lock/review 상태를 검사하지만 reconcile/lock/defer는 메모리 shadow에만 적용한다.
  const journal=createProducerJournal(enqueue?backend:createMemoryJournalBackend(snapshot),{now});
  let publishAttempts=0;
  const queue=enqueue?createAutomationQueueTransport({credential:config.secrets.CF_QUEUE_API_TOKEN,fetchImpl,now}):undefined;
  const transport=queue?{kind:queue.kind,send:(message,options)=>{publishAttempts++;return queue.send(message,options);}}:undefined;
  const summary=await runScheduledSecRawProducer({policy:config.policy,release:currentRelease,target:config.target,
    reader:cachedReader,journal,transport,fetchImpl,userAgent:config.secrets.SEC_USER_AGENT,enqueue,dryRun:!enqueue,
    now,sleep,random,runId,owner,reviewReader:async ticker=>states.get(ticker)?.reviewEvidence});
  // core의 상세 identity decision/raw/provider body는 stdout에 넣지 않는다.
  return {runId:summary.runId,release:summary.release,policyHash:summary.policyHash,mode:enqueue?'enqueue':'detect-only',
    scopeCount:summary.scopeCount,checked:summary.checked,unchanged:summary.unchanged,unchangedCompat:summary.unchangedCompat,
    detected:summary.detected,sourceNotIndexed:summary.sourceNotIndexed,accepted:summary.queued,ambiguous:summary.ambiguous,
    reviewBlocked:summary.reviewBlocked,failed:summary.failed,budgetSkipped:summary.budgetSkipped,publishCount:publishAttempts,
    stopped:summary.stopped,errorCategories:summary.errorCategories};
}

/** 주입 verifier/로컬 filesystem/git의 예외도 공개 범주로만 반환한다. credential이나 provider 원문은 전파하지 않는다. */
export async function runProductionSecRawProducer(options={}) {
  try {return await executeProductionSecRawProducer(options);}
  catch(error) {throw safeError(errorCategory(error));}
}

if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {console.log(JSON.stringify(await runProductionSecRawProducer({args:process.argv.slice(2)})));}
  catch(error) {console.log(JSON.stringify({status:'STOP',errorCategory:errorCategory(error)}));process.exitCode=1;}
}
