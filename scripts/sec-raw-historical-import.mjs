import { readFileSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { extractStandardRawMetrics } from '../worker/src/sec-standard-raw.js';
import { latestRawAccession,assertRawRuntimeSchema,recordRawDiscoveryFailure } from '../worker/src/sec-standard-raw-runtime.js';
import { validateStandardRawRecords } from '../worker/src/sec-standard-raw-store.js';
import { prepareHistoricalMutationPlan,executeHistoricalMutationPlan,summarizeHistoricalMutationPlans } from './sec-raw-historical-plan.mjs';
import { rawSourceIdentity } from '../worker/src/sec-raw-message.js';
import { createAdminDatabase } from './specialized-d1-admin.mjs';
import { isProductionTarget, verifyHistoricalPromotion, requirePromotionEvidence, currentCheckpoint,
  isVerifiedPromotionTarget,readOnlyDatabase } from './sec-raw-promotion.mjs';

const uuid = value => /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value || '');
const tickerValid = value => /^[A-Z][A-Z0-9.-]{0,14}$/.test(value || '');
export const standardRawHistoricalImportEnabled = env => env.SEC_STANDARD_RAW_HISTORICAL_IMPORT_ENABLED === 'true';

/** 기존 deny guard를 유지하고 검증된 promotion 경로에서만 명시적 예외를 허용한다. */
export async function assertHistoricalTarget(DB,target,{ productionApproval=false,verificationReceipt=null }={}) {
  if (!uuid(target?.databaseId) || typeof target.name !== 'string'
    || target.databaseId !== target.allowedDatabaseId
    || isProductionTarget(target) && !(productionApproval && isVerifiedPromotionTarget(verificationReceipt,target))) {
    throw new Error('SEC raw importer 대상 확인 실패. 명시적으로 승인한 비운영 DB를 지정해 주세요.');
  }
  const identity = await DB.identity();
  if (identity.uuid !== target.databaseId || identity.name !== target.name) throw new Error('SEC raw importer 실제 DB identity 불일치.');
  await assertRawRuntimeSchema(DB);
  const schema = await DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sec_raw_payload_checkpoint'").all();
  if (schema.results.length !== 1) throw new Error('SEC raw importer에는 migration 0022가 필요합니다.');
}

/** Node 전용 10FY/40Q importer다. Worker scheduler/consumer에는 이 파일을 import하지 않는다. */
export async function importHistoricalSecRaw({ tickers,loadCompanyFacts,DB,target,apply=false,
  enabled=false,resume=false,retryFailedOnly=false,onProgress=()=>{},verifyOnly=false,
  productionApproval=false,envelope=null,evidence=null,checkpoint=currentCheckpoint() }) {
  if (!Array.isArray(tickers) || !tickers.length || new Set(tickers).size !== tickers.length
    || tickers.some(ticker => !tickerValid(ticker)) || typeof loadCompanyFacts !== 'function') {
    throw new Error('SEC raw importer 종목 목록/원문 loader를 확인해 주세요.');
  }
  let verification;
  const promotion = productionApproval || isProductionTarget(target) || Boolean(envelope);
  // 운영 target에는 테스트용 checkpoint 주입을 허용하지 않고 실제 checkout HEAD를 다시 사용한다.
  if (isProductionTarget(target)) checkpoint = currentCheckpoint();
  if (apply && isProductionTarget(target)) {
    const { execFileSync } = await import('node:child_process');
    if (execFileSync('git',['status','--short'],{encoding:'utf8'}).trim()) throw new Error('Production apply에는 clean checkpoint가 필요합니다.');
  }
  if (verifyOnly && apply) throw new Error('verify-only와 apply를 함께 사용할 수 없습니다.');
  if (promotion) {
    if (apply && (!productionApproval || !enabled)) throw new Error('Production write는 기본 금지입니다. 명시적 승인과 활성화가 필요합니다.');
    if (!DB || !envelope) throw new Error('Production 대상 검증에는 승인 envelope와 read-only DB가 필요합니다.');
    verification = await verifyHistoricalPromotion({DB,target,tickers,loadCompanyFacts,envelope,checkpoint});
    if (apply) requirePromotionEvidence(evidence,verification.receipt);
    if (verifyOnly) {
      const mode = 'verify-only';
      return {mode,counts:verification.counts,estimatedWrites:verification.estimatedWrites,
        receipt:{...verification.receipt,mode},results:verification.observations.map(({ticker,accession})=>({ticker,accession,status:mode}))};
    }
    // 모든 입력을 먼저 검증한 고정 bytes/anchors로 저장한다. 검사 후 loader 교체/TOCTOU를 막는다.
    loadCompanyFacts = async ticker => verification.prepared.get(ticker);
  } else if (verifyOnly) {
    throw new Error('verify-only에는 scope envelope를 지정해 주세요.');
  }
  if (apply) {
    if (!enabled || !DB) throw new Error('명시적인 historical import 활성화와 DB가 있어야 write할 수 있습니다.');
    await assertHistoricalTarget(DB,target,{productionApproval,verificationReceipt:verification?.receipt});
  }
  const results = [],perTickerPlans = [];
  // 기존 offline dry-run은 DB 불필요 contract를 유지한다. 승인 envelope가 있는 공식 계획만 DB 상태를 읽는다.
  const read=DB && (apply || promotion) ? readOnlyDatabase(DB) : null;
  // 모든 계획을 먼저 검증한다. dry-run에는 mutation adapter 자체를 전달하지 않는다.
  for (const ticker of tickers) {
    try {
      if (read && retryFailedOnly) {
        const state = await read.prepare('SELECT raw_status FROM sec_raw_runtime WHERE ticker=?').bind(ticker).first();
        if (state?.raw_status !== 'error') { results.push({ticker,status:'skipped-not-failed'});continue; }
      }
      const input = await loadCompanyFacts(ticker);
      const companyFacts = input.companyFacts;
      // CLI에서도 기존 legacy 기간을 보호한다. 원문/API 재호출로 기간을 추측하지 않는다.
      const financialPeriods = input.financialPeriods ?? (read
        ? (await read.prepare(`SELECT period_type,fiscal_period_end FROM financial_metrics
          WHERE ticker=? AND source='SEC EDGAR' ORDER BY period_type,fiscal_period_end`).bind(ticker).all()).results : []);
      const facts = companyFacts?.facts;
      const accession = latestRawAccession(facts);
      if (!/^\d{10}-\d{2}-\d{6}$/.test(accession || '') || !/^\d{1,10}$/.test(String(companyFacts?.cik || ''))) {
        throw new Error('입력 공시/회사 identity가 유효하지 않습니다.');
      }
      if (read) {
        const company = await read.prepare('SELECT cik FROM companies WHERE ticker=?').bind(ticker).first();
        if (company?.cik && Number(company.cik) !== Number(companyFacts.cik)) throw new Error('회사 CIK와 원문이 일치하지 않습니다.');
      }
      const records = extractStandardRawMetrics(facts,{financialPeriods});
      validateStandardRawRecords(records);
      const sourceIdentity = await rawSourceIdentity({version:1,ticker,accession,cik:String(companyFacts.cik),facts,financialPeriods});
      const plan=await prepareHistoricalMutationPlan({DB:apply?DB:read,ticker,accession,sourceIdentity,records,retryNow:retryFailedOnly});
      perTickerPlans.push(plan);
    } catch {
      // 입력 원문/서버 URL/인증 자료가 예외에 들어갈 수 있어 고정 안내만 반환한다.
      const failure = {ticker,status:'error',code:'HISTORICAL_IMPORT_FAILED'};
      if (apply) await recordRawDiscoveryFailure({DB},ticker);
      results.push(failure);await onProgress(failure);
    }
  }
  // 실제 executor에는 write DB만 바꾸고 검증된 입력 계획을 다시 준비한다. 원문 loader는 재호출하지 않는다.
  // 공개 계획을 권한으로 취급하지 않으며 위의 기존 apply 승인 검사를 통과한 경우에만 여기 진입한다.
  if (!results.some(row=>row.status==='error')) {
    for(const plan of perTickerPlans) {
      let result={status:'dry-run'};
      if(apply) {
        try { result=await executeHistoricalMutationPlan(DB,plan); }
        catch { result={status:'error',code:'HISTORICAL_IMPORT_FAILED'};await recordRawDiscoveryFailure({DB},plan.ticker); }
      }
      const progress={ticker:plan.ticker,accession:plan.accession,...plan.counts,...result};
      results.push(progress);await onProgress(progress);
    }
  }
  // 실패한 scope에는 일부 정상 계획을 성공 계획처럼 공개하지 않는다.
  const validPlans=results.some(row=>row.status==='error') && !apply ? [] : perTickerPlans;
  const summary=validPlans.length ? summarizeHistoricalMutationPlans(validPlans) : null;
  return { mode:apply?'apply':'dry-run',resume,retryFailedOnly,results,summary,perTickerPlans:validPlans,
    ...(verification?{counts:verification.counts,estimatedWrites:verification.estimatedWrites,
      ...(apply || results.some(row=>row.status==='error')?{}:{receipt:{...verification.receipt,mode:'dry-run'}})}:{}) };
}

export function parseHistoricalArguments(args) {
  const options = {apply:false,enabled:false,resume:false,retryFailedOnly:false};
  const values = {'--ticker':'ticker','--tickers':'tickerList','--cache-dir':'cacheDir',
    '--account-id':'accountId','--database-id':'databaseId','--database-name':'name',
    '--allow-database-id':'allowedDatabaseId','--credential-file':'credentialFile',
    '--approval-file':'approvalFile','--evidence-file':'evidenceFile'};
  const flags = {'--apply':'apply','--enable-historical-import':'enabled','--resume':'resume','--retry-failed-only':'retryFailedOnly',
    '--verify-only':'verifyOnly','--production-approval':'productionApproval'};
  for (let i=0;i<args.length;i++) {
    if (flags[args[i]]) options[flags[args[i]]] = true;
    else if (args[i] === '--dry-run') options.apply = false;
    else if (values[args[i]] && args[i+1] && !args[i+1].startsWith('--')) options[values[args[i]]] = args[++i];
    else throw new Error('지원하지 않는 importer 옵션 또는 누락된 값입니다.');
  }
  if (!options.cacheDir || Boolean(options.ticker) === Boolean(options.tickerList)) throw new Error('cache 경로와 ticker 또는 tickers 중 하나를 지정해 주세요.');
  options.tickers = (options.ticker || options.tickerList).split(',').map(value=>value.trim().toUpperCase());
  if (options.tickers.some(ticker=>!tickerValid(ticker))) throw new Error('종목코드 형식 오류');
  return options;
}

if (process.argv[1] === resolve('scripts/sec-raw-historical-import.mjs')) {
  try {
    const options = parseHistoricalArguments(process.argv.slice(2));
    options.enabled = options.enabled || standardRawHistoricalImportEnabled(process.env);
    let DB;
    if (options.apply || options.verifyOnly || options.approvalFile) {
      if (!process.execArgv.includes('--use-system-ca') || options.apply && !options.enabled || !options.credentialFile
        || !uuid(options.databaseId) || options.databaseId !== options.allowedDatabaseId || !options.name) {
        throw new Error('명시적 write/target/system CA/로컬 credential 파일 설정이 필요합니다.');
      }
      if (isProductionTarget(options) && (!options.approvalFile || options.apply && !options.productionApproval)) throw new Error('Production 승인 artifact 미확보');
      const { execFileSync } = await import('node:child_process');
      execFileSync('git',['check-ignore','--quiet',options.credentialFile]);
      if (execFileSync('git',['ls-files',options.credentialFile],{encoding:'utf8'}).trim()) throw new Error('credential 파일이 추적 대상입니다.');
      const vars = readFileSync(options.credentialFile,'utf8');
      const token = vars.match(/^CLOUDFLARE_API_TOKEN=(.+)$/m)?.[1]?.trim();
      // 실제 승인/evidence는 Git ignored 파일로만 받는다. 이번 구현 단계에서는 생성하지 않는다.
      for (const file of [options.approvalFile,options.evidenceFile].filter(Boolean)) {
        execFileSync('git',['check-ignore','--quiet',file]);
        if (execFileSync('git',['ls-files',file],{encoding:'utf8'}).trim()) throw new Error('승인 artifact가 추적 대상입니다.');
      }
      options.envelope = options.approvalFile ? JSON.parse(readFileSync(options.approvalFile,'utf8')) : null;
      options.evidence = options.evidenceFile ? JSON.parse(readFileSync(options.evidenceFile,'utf8')) : null;
      if (options.envelope && options.accountId !== options.envelope.queue.accountId) throw new Error('승인 account 불일치');
      if (options.apply && options.envelope && execFileSync('git',['status','--short'],{encoding:'utf8'}).trim()) throw new Error('승인 apply에는 clean checkpoint가 필요합니다.');
      DB = createAdminDatabase({accountId:options.accountId,dbId:options.databaseId,token,allowWrite:options.apply});
    }
    const result = await importHistoricalSecRaw({...options,DB,target:options,
      loadCompanyFacts:async ticker=>{const sourceBytes=readFileSync(join(options.cacheDir,`${ticker}.json`));
        return {companyFacts:JSON.parse(sourceBytes),sourceBytes};}});
    console.log(JSON.stringify(result,null,2));
    if (result.results.some(row=>row.status==='error')) process.exitCode=1;
  } catch { console.error('SEC raw historical importer 중단. 옵션/승인 대상/로컬 인증/입력 cache를 확인해 주세요.');process.exitCode=1; }
}
