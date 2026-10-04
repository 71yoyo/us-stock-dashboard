import { readFileSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { extractStandardRawMetrics } from '../worker/src/sec-standard-raw.js';
import { latestRawAccession,assertRawRuntimeSchema,recordRawDiscoveryFailure } from '../worker/src/sec-standard-raw-runtime.js';
import { runRawRecordRuntime } from '../worker/src/sec-standard-raw-incremental.js';
import { validateStandardRawRecords } from '../worker/src/sec-standard-raw-store.js';
import { rawSourceIdentity } from '../worker/src/sec-raw-message.js';
import { createAdminDatabase } from './specialized-d1-admin.mjs';

const uuid = value => /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value || '');
const tickerValid = value => /^[A-Z][A-Z0-9.-]{0,14}$/.test(value || '');
export const standardRawHistoricalImportEnabled = env => env.SEC_STANDARD_RAW_HISTORICAL_IMPORT_ENABLED === 'true';

/** target을 기본 운영 DB로 추정하지 않는다. production 연결은 R7에서 절대 허용하지 않는다. */
export async function assertHistoricalTarget(DB,target) {
  const production = JSON.parse(readFileSync(new URL('../worker/wrangler.jsonc',import.meta.url),'utf8'));
  if (!uuid(target?.databaseId) || typeof target.name !== 'string'
    || target.databaseId !== target.allowedDatabaseId
    || production.d1_databases.some(row => row.database_id === target.databaseId || row.database_name === target.name)) {
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
  enabled=false,resume=false,retryFailedOnly=false,onProgress=()=>{} }) {
  if (!Array.isArray(tickers) || !tickers.length || new Set(tickers).size !== tickers.length
    || tickers.some(ticker => !tickerValid(ticker)) || typeof loadCompanyFacts !== 'function') {
    throw new Error('SEC raw importer 종목 목록/원문 loader를 확인해 주세요.');
  }
  if (apply) {
    if (!enabled || !DB) throw new Error('명시적인 historical import 활성화와 DB가 있어야 write할 수 있습니다.');
    await assertHistoricalTarget(DB,target);
  }
  const results = [];
  for (const ticker of tickers) {
    try {
      if (apply && retryFailedOnly) {
        const state = await DB.prepare('SELECT raw_status FROM sec_raw_runtime WHERE ticker=?').bind(ticker).first();
        if (state?.raw_status !== 'error') { results.push({ticker,status:'skipped-not-failed'});continue; }
      }
      const input = await loadCompanyFacts(ticker);
      const companyFacts = input.companyFacts;
      // CLI에서도 기존 legacy 기간을 보호한다. 원문/API 재호출로 기간을 추측하지 않는다.
      const financialPeriods = input.financialPeriods ?? (apply
        ? (await DB.prepare(`SELECT period_type,fiscal_period_end FROM financial_metrics
          WHERE ticker=? AND source='SEC EDGAR' ORDER BY period_type,fiscal_period_end`).bind(ticker).all()).results : []);
      const facts = companyFacts?.facts;
      const accession = latestRawAccession(facts);
      if (!/^\d{10}-\d{2}-\d{6}$/.test(accession || '') || !/^\d{1,10}$/.test(String(companyFacts?.cik || ''))) {
        throw new Error('입력 공시/회사 identity가 유효하지 않습니다.');
      }
      if (apply) {
        const company = await DB.prepare('SELECT cik FROM companies WHERE ticker=?').bind(ticker).first();
        if (company?.cik && Number(company.cik) !== Number(companyFacts.cik)) throw new Error('회사 CIK와 원문이 일치하지 않습니다.');
      }
      const records = extractStandardRawMetrics(facts,{financialPeriods});
      validateStandardRawRecords(records);
      const sourceIdentity = await rawSourceIdentity({version:1,ticker,accession,cik:String(companyFacts.cik),facts,financialPeriods});
      const counts = { raw:records.length,available:records.filter(row=>row.availability==='available').length,
        missing:records.filter(row=>row.availability==='missing').length,
        needsReview:records.filter(row=>row.availability==='needs_review').length,
        provenance:records.filter(row=>row.provenance).length };
      const result = apply ? await runRawRecordRuntime({DB,SEC_STANDARD_RAW_FIELDS_ENABLED:'true'},ticker,accession,
        async()=>records,{sourceIdentity,channel:'historical',strictReview:true,retryNow:retryFailedOnly}) : {status:'dry-run'};
      const progress = {ticker,accession,...counts,...result};
      results.push(progress);await onProgress(progress);
    } catch {
      // 입력 원문/서버 URL/인증 자료가 예외에 들어갈 수 있어 고정 안내만 반환한다.
      const failure = {ticker,status:'error',code:'HISTORICAL_IMPORT_FAILED'};
      if (apply) await recordRawDiscoveryFailure({DB},ticker);
      results.push(failure);await onProgress(failure);
    }
  }
  // resume는 파일 cursor가 아니라 D1의 원자 completed identity를 기준으로 한다.
  return { mode:apply?'apply':'dry-run',resume,retryFailedOnly,results };
}

export function parseHistoricalArguments(args) {
  const options = {apply:false,enabled:false,resume:false,retryFailedOnly:false};
  const values = {'--ticker':'ticker','--tickers':'tickerList','--cache-dir':'cacheDir',
    '--account-id':'accountId','--database-id':'databaseId','--database-name':'name',
    '--allow-database-id':'allowedDatabaseId','--credential-file':'credentialFile'};
  const flags = {'--apply':'apply','--enable-historical-import':'enabled','--resume':'resume','--retry-failed-only':'retryFailedOnly'};
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
    if (options.apply) {
      if (!process.execArgv.includes('--use-system-ca') || !options.enabled || !options.credentialFile
        || !uuid(options.databaseId) || options.databaseId !== options.allowedDatabaseId || !options.name) {
        throw new Error('명시적 write/target/system CA/로컬 credential 파일 설정이 필요합니다.');
      }
      const production = JSON.parse(readFileSync(new URL('../worker/wrangler.jsonc',import.meta.url),'utf8'));
      if (production.d1_databases.some(row=>row.database_id===options.databaseId || row.database_name===options.name)) throw new Error('R7 Production target 금지');
      const { execFileSync } = await import('node:child_process');
      execFileSync('git',['check-ignore','--quiet',options.credentialFile]);
      if (execFileSync('git',['ls-files',options.credentialFile],{encoding:'utf8'}).trim()) throw new Error('credential 파일이 추적 대상입니다.');
      const vars = readFileSync(options.credentialFile,'utf8');
      const token = vars.match(/^CLOUDFLARE_API_TOKEN=(.+)$/m)?.[1]?.trim();
      DB = createAdminDatabase({accountId:options.accountId,dbId:options.databaseId,token,allowWrite:true});
    }
    const result = await importHistoricalSecRaw({...options,DB,target:options,
      loadCompanyFacts:async ticker=>({companyFacts:JSON.parse(readFileSync(join(options.cacheDir,`${ticker}.json`),'utf8'))})});
    console.log(JSON.stringify(result,null,2));
    if (result.results.some(row=>row.status==='error')) process.exitCode=1;
  } catch { console.error('SEC raw historical importer 중단. 옵션/비운영 대상/인증/입력 cache를 확인해 주세요.');process.exitCode=1; }
}
