import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import dc from 'node:diagnostics_channel';
import { syncFinancialsFromSec } from '../worker/src/fmp-sync.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const productionEndpoint = 'https://us-stock-dashboard-api.771yoyo.workers.dev/api/companies/NVDA';
const metrics = ['revenue', 'operating_income', 'net_income', 'eps', 'free_cash_flow', 'roe', 'gross_margin', 'operating_margin'];
const aliases = {
  revenue: ['revenue'], operating_income: ['operating income'], net_income: ['net income'],
  eps: ['diluted eps', 'eps diluted', 'earnings per share diluted', 'diluted earnings per share'],
  gross_profit: ['gross profit'], free_cash_flow: ['free cash flow'],
  operating_cash_flow: ['operating cash flow', 'cash from operations', 'cash from operating activities', 'net cash from operating activities'],
  capital_expenditure: ['capital expenditure', 'capital expenditures', 'capex']
};

/** 설정값은 메모리에만 읽는다. 반환 상태에는 키·연락처·토큰 값을 포함하지 않는다. */
export function loadAuditSettings() {
  const settings = {};
  for (const name of ['.dev.vars', '.dev.vars.businessquant']) {
    const path = resolve(root, 'worker', name);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
      if (match) settings[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  for (const name of ['SEC_USER_AGENT', 'MARKET_DATA_API_KEY', 'FMP_API_KEY', 'BUSINESS_QUANT_API_KEY']) {
    if (process.env[name]) settings[name] = process.env[name];
  }
  return settings;
}

export function difference(reference, candidate) {
  if (!Number.isFinite(reference) || !Number.isFinite(candidate)) return { status: 'MISSING', difference: null, percent: null };
  const delta = candidate - reference;
  const percent = reference === 0 ? null : delta / Math.abs(reference) * 100;
  const status = delta === 0 ? 'MATCH' : Math.abs(delta) <= Math.max(1e-10, Math.abs(reference) * 1e-9)
    ? 'ROUNDING' : percent !== null && Math.abs(percent) < 1 ? 'SMALL DIFFERENCE' : 'MATERIAL DIFFERENCE';
  return { status, difference: delta, percent };
}

/** 실제 응답 필드와 지연 공시 후보만 요약한다. 기간 판정 정책을 재작성하거나 변경하지 않는다. */
export function inspectRawSec(payload) {
  const entries = Object.entries(payload.facts?.['us-gaap'] || {}).flatMap(([tag, fact]) =>
    Object.entries(fact.units || {}).flatMap(([unit, values]) => values.map(entry => ({ ...entry, tag, unit }))));
  const fields = Object.fromEntries(['fy', 'fp', 'form', 'filed', 'accn', 'frame', 'start', 'end', 'val', 'unit']
    .map(field => [field, entries.filter(entry => entry[field] !== undefined && entry[field] !== null).length]));
  const groups = new Map();
  for (const entry of entries) {
    const duration = (new Date(entry.end) - new Date(entry.start)) / 86400000;
    if (!entry.accn || !entry.start || duration < 60 || duration > 380 || !['10-K', '10-K/A', '10-Q', '10-Q/A'].includes(entry.form)) continue;
    const group = groups.get(entry.accn) || [];
    group.push(entry); groups.set(entry.accn, group);
  }
  const delayed = [];
  for (const [accession, rows] of groups) {
    const annual = rows[0].fp === 'FY';
    const candidates = rows.filter(row => {
      const days = (new Date(row.end) - new Date(row.start)) / 86400000;
      return annual ? days >= 330 && days <= 380 : days >= 60 && days <= 310;
    });
    const end = candidates.map(row => row.end).sort().at(-1);
    const filed = rows.map(row => row.filed).filter(Boolean).sort()[0];
    if (!end || !filed) continue;
    const days = (new Date(filed) - new Date(end)) / 86400000;
    if (days > (annual ? 180 : 60)) delayed.push({ accession, form: rows[0].form, fy: rows[0].fy,
      fp: rows[0].fp, filed, end, days });
  }
  return { factCount: entries.length, populatedFields: fields, units: [...new Set(entries.map(row => row.unit))],
    delayedFilings: delayed, unitNote: 'unit은 원본 units 키에서 가져옴. 개별 fact 내부 필드가 아님' };
}

const normalizedName = value => String(value || '').toLowerCase().replace(/\((annual|quarter|qtr|yr)\)/g, '')
  .replace(/[()]/g, '').replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();

/** BQ는 실제 date로만 매칭한다. normalizedDate나 날짜의 월로 FY/Q를 추정하지 않는다. */
export function normalizeBusinessQuant(payload) {
  const periods = new Map();
  const available = [];
  for (const category of Object.values(payload?.data || {})) {
    for (const [label, section] of Object.entries(category.sections || {})) {
      const names = [label, section.metadata?.name, section.metadata?.name_short, section.metadata?.slug].map(normalizedName);
      available.push({ label, slug: section.metadata?.slug || null, count: section.values?.length || 0 });
      const metric = Object.entries(aliases).find(([, options]) => options.some(option => names.includes(option)))?.[0];
      if (!metric) continue;
      for (const item of section.values || []) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(item.date) || !Number.isFinite(item.reportedValue?.raw)) continue;
        const row = periods.get(item.date) || { end: item.date, normalizedDate: item.normalizedDate || null,
          fiscalYear: null, fiscalPeriod: null, periodType: item.periodType || null, fields: Object.keys(item), definitions: {} };
        row[metric] = item.reportedValue.raw;
        row.definitions[metric] = section.metadata?.name || label;
        periods.set(item.date, row);
      }
    }
  }
  for (const row of periods.values()) {
    row.gross_margin = Number.isFinite(row.gross_profit) && row.revenue ? row.gross_profit / row.revenue * 100 : null;
    row.net_margin = Number.isFinite(row.net_income) && row.revenue ? row.net_income / row.revenue * 100 : null;
  }
  return { periods: [...periods.values()].sort((a, b) => b.end.localeCompare(a.end)), available };
}

/** 비교 전용이다. CF 응답의 순이익으로 IS 순이익을 덮어쓰지 않고 EPS는 표시 정밀도도 구분한다. */
export function compareBusinessQuant(secRows, responses) {
  const comparisons = [];
  for (const frequency of ['Annual', 'Quarter']) {
    const income = responses.find(item => item.frequency === frequency && item.statement === 'IS')?.periods || [];
    const cashFlows = responses.find(item => item.frequency === frequency && item.statement === 'CF')?.periods || [];
    for (const external of income) {
      const periodType = frequency === 'Annual' ? 'annual' : 'quarterly';
      const source = secRows.find(row => row.period_type === periodType && row.fiscal_period_end === external.end);
      const cash = cashFlows.find(row => row.end === external.end);
      for (const metric of ['revenue', 'operating_income', 'net_income', 'eps', 'gross_margin', 'free_cash_flow']) {
        const candidate = metric === 'free_cash_flow' ? cash?.[metric] : external[metric];
        const result = difference(source?.[metric], candidate);
        if (metric === 'eps' && result.status !== 'MATCH' && result.status !== 'MISSING'
          && Math.abs(Math.round(candidate * 100) / 100 - source[metric]) < 1e-10) result.status = 'ROUNDING';
        comparisons.push({ type: periodType, end: external.end, fiscalYear: source?.fiscal_year ?? null,
          fiscalPeriod: source?.fiscal_period ?? null, metric, sec: source?.[metric] ?? null,
          businessquant: candidate ?? null, fmp: null, ...result });
      }
    }
  }
  return comparisons;
}

/** 공식 SEC 원본만 처리하는 폐기 가능한 검증 DB다. 외부 비교값은 이 DB에도 저장하지 않는다. */
export async function reprocessSec(payload, ticker = 'NVDA') {
  if (!payload?.facts?.['us-gaap']) throw new Error('SEC 원본에 US-GAAP 자료가 없습니다.');
  const sqlite = new DatabaseSync(':memory:');
  try {
    for (const name of readdirSync(resolve(root, 'worker/migrations')).filter(name => name.endsWith('.sql')).sort()) {
      sqlite.exec(readFileSync(resolve(root, 'worker/migrations', name), 'utf8'));
    }
    sqlite.prepare('INSERT INTO companies(ticker,name,cik) VALUES (?,?,?)').run(ticker, ticker, String(payload.cik));
    const prepare = sql => ({ sql, values: [], bind(...values) { this.values = values; return this; },
      async first() { return sqlite.prepare(sql).get(...this.values) || null; },
      async all() { return { results: sqlite.prepare(sql).all(...this.values) }; },
      async run() { return sqlite.prepare(sql).run(...this.values); } });
    const DB = { prepare, async batch(statements) {
      sqlite.exec('BEGIN');
      try { const result = statements.map(item => ({ results: sqlite.prepare(item.sql).all(...item.values) }));
        sqlite.exec('COMMIT'); return result;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    } };
    const result = await syncFinancialsFromSec({ DB, secFacts: new Map([[ticker, payload.facts]]) }, ticker);
    const rows = sqlite.prepare(`SELECT * FROM financial_metrics WHERE ticker=? ORDER BY period_type,fiscal_period_end DESC`).all(ticker);
    const coverage = sqlite.prepare(`SELECT period_type,COUNT(*) AS total,
      SUM(fiscal_year IS NOT NULL) AS fiscalYear,SUM(fiscal_period IS NOT NULL) AS fiscalPeriod,
      SUM(period_start IS NOT NULL) AS periodStart FROM financial_metrics WHERE ticker=? GROUP BY period_type`).all(ticker);
    const provenance = sqlite.prepare(`SELECT * FROM financial_metric_provenance WHERE ticker=? ORDER BY fiscal_period_end DESC,metric_name`).all(ticker);
    const samples = ['direct', 'ytd_difference', 'fy_minus_9m', 'derived'].map(kind => {
      const row = provenance.find(item => item.calculation_type === kind);
      return row ? { ...row, source_refs_json: JSON.parse(row.source_refs_json),
        calculation_details_json: row.calculation_details_json ? JSON.parse(row.calculation_details_json) : null } : { calculation_type: kind, missing: true };
    });
    const latestQuarter = rows.find(row => row.period_type === 'quarterly')?.fiscal_period_end;
    const metricSamples = provenance.filter(row => row.period_type === 'quarterly'
      && row.fiscal_period_end === latestQuarter && metrics.includes(row.metric_name)).map(row => ({ ...row,
        source_refs_json: JSON.parse(row.source_refs_json),
        calculation_details_json: row.calculation_details_json ? JSON.parse(row.calculation_details_json) : null }));
    return { result, coverage, rows, provenanceCount: provenance.length, samples, metricSamples,
      provenanceTypes: provenance.reduce((counts, row) => { counts[row.calculation_type] = (counts[row.calculation_type] || 0) + 1; return counts; }, {}) };
  } finally { sqlite.close(); }
}

/** 추가 종목도 공식 endpoint를 한 번만 읽고 메모리 DB에서만 처리한다. */
export async function smokeSec(ticker, cik) {
  if (!['AAPL', 'MSFT', 'JPM', 'O'].includes(ticker) || !/^\d{1,10}$/.test(String(cik))) {
    throw new Error('승인된 추가 검증 종목 또는 CIK가 아닙니다.');
  }
  const settings = loadAuditSettings();
  if (!settings.SEC_USER_AGENT) return { ticker, blocker: 'SEC_USER_AGENT 없음' };
  const response = await getOnce(new URL(`https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10, '0')}.json`),
    { 'User-Agent': settings.SEC_USER_AGENT, Accept: 'application/json' }, true);
  if (!response.payload) return { ticker, diagnostic: response.diagnostic, blocker: '공식 SEC 접근 실패. 재시도하지 않음' };
  const result = await reprocessSec(response.payload, ticker);
  return { ticker, diagnostic: response.diagnostic, coverage: result.coverage,
    recent: ['annual', 'quarterly'].flatMap(type => result.rows.filter(row => row.period_type === type).slice(0, type === 'annual' ? 2 : 4)
      .map(row => ({ type, fiscalYear: row.fiscal_year, fiscalPeriod: row.fiscal_period, start: row.period_start,
        end: row.fiscal_period_end, reportedDate: row.reported_date }))),
    missing: result.rows.filter(row => row.fiscal_year === null || row.fiscal_period === null || row.period_start === null)
      .map(row => ({ type: row.period_type, end: row.fiscal_period_end, fiscalYear: row.fiscal_year,
        fiscalPeriod: row.fiscal_period, start: row.period_start })),
    rawInspection: inspectRawSec(response.payload) };
}

/** 명시한 공급원만 한 번 조회한다. 403/429도 재시도하지 않고 비밀값이 포함될 수 있는 예외는 숨긴다. */
async function getOnce(url, headers = { Accept: 'application/json' }, captureSec = false) {
  let sentHeaders = null;
  const observe = ({ headers: wire }) => {
    if (!captureSec) return;
    const text = String(wire);
    sentHeaders = Object.fromEntries(['host', 'accept', 'accept-encoding', 'connection'].map(name =>
      [name, text.match(new RegExp(`^${name}:\\s*([^\\r\\n]*)`, 'im'))?.[1] || null]));
    sentHeaders.userAgentDeclared = /^user-agent:/im.test(text);
    sentHeaders.userAgentHasEmail = /[^\s@]+@[^\s@]+\.[^\s@]+/.test(text.match(/^user-agent:\s*([^\r\n]*)/im)?.[1] || '');
  };
  if (captureSec) dc.channel('undici:client:sendHeaders').subscribe(observe);
  try {
    const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(20000) });
    const text = await response.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch { /* SEC 차단 화면 등 비 JSON도 상태만 기록한다. */ }
    return { diagnostic: { httpStatus: response.status, contentType: response.headers.get('content-type'),
      server: response.headers.get('server'), redirected: response.redirected, bodyLength: text.length,
      topFields: payload && typeof payload === 'object' ? Object.keys(payload).filter(name => !/key|token|secret/i.test(name)) : [],
      undeclaredAutomatedTool: /undeclared automated tool/i.test(text), sentHeaders }, payload: response.ok ? payload : null };
  } catch (error) {
    return { diagnostic: { httpStatus: null, errorType: error.name, errorCode: error.cause?.code || null, sentHeaders }, payload: null };
  } finally { if (captureSec) dc.channel('undici:client:sendHeaders').unsubscribe(observe); }
}

export async function runAudit(flags) {
  const settings = loadAuditSettings();
  const output = { recordedAt: new Date().toISOString(), productionWrite: false, calls: [], credentials:
    Object.fromEntries(['SEC_USER_AGENT', 'MARKET_DATA_API_KEY', 'FMP_API_KEY', 'BUSINESS_QUANT_API_KEY']
      .map(name => [name, settings[name] ? 'configured' : 'missing'])) };
  if (flags.has('--sec')) {
    if (!settings.SEC_USER_AGENT || !/[^\s@]+@[^\s@]+\.[^\s@]+/.test(settings.SEC_USER_AGENT)
      || /example\.(com|org)|YOUR_EMAIL/i.test(settings.SEC_USER_AGENT)) output.sec = { blocker: 'SEC_USER_AGENT에 실제 연락 이메일 설정 필요' };
    else {
      const response = await getOnce(new URL('https://data.sec.gov/api/xbrl/companyfacts/CIK0001045810.json'),
        { 'User-Agent': settings.SEC_USER_AGENT, Accept: 'application/json' }, true);
      output.calls.push({ source: 'SEC', endpoint: '/api/xbrl/companyfacts/CIK0001045810.json', ...response.diagnostic });
      if (response.payload) output.sec = { ...await reprocessSec(response.payload), rawInspection: inspectRawSec(response.payload) };
      else output.sec = { blocker: 'SEC 공식 원본 접근 실패. 재시도하지 않음' };
    }
  }
  if (flags.has('--production')) {
    const response = await getOnce(new URL(productionEndpoint));
    output.calls.push({ source: '기존 운영 API 읽기 전용', ...response.diagnostic });
    output.productionRows = response.payload?.company?.financials || [];
  }
  if (flags.has('--businessquant')) {
    if (!settings.BUSINESS_QUANT_API_KEY) output.businessquant = { blocker: 'BUSINESS_QUANT_API_KEY 없음' };
    else {
      output.businessquant = [];
      for (const frequency of ['Annual', 'Quarter']) {
        for (const statement of ['IS', 'CF']) {
          const url = new URL('https://data.businessquant.com/statements');
          for (const [name, value] of Object.entries({ ticker: 'NVDA', frequency, statement,
            period: frequency === 'Annual' ? '10y' : '3y', api_key: settings.BUSINESS_QUANT_API_KEY })) url.searchParams.set(name, value);
          const response = await getOnce(url);
          output.calls.push({ source: 'BusinessQuant', endpoint: '/statements', frequency, statement, ...response.diagnostic });
          if (!response.payload?.data) { output.businessquant.push({ frequency, statement, blocker: '재무 응답 없음' }); break; }
          output.businessquant.push({ frequency, statement, ...normalizeBusinessQuant(response.payload) });
          // 공급원 호출은 직렬 실행하고 최소 1초를 띄운다. 실패한 요청을 반복하지 않는다.
          await new Promise(done => setTimeout(done, 1000));
        }
        if (output.businessquant.some(item => item.blocker)) break;
      }
    }
  }
  if (flags.has('--fmp')) {
    const key = settings.MARKET_DATA_API_KEY || settings.FMP_API_KEY;
    if (!key) output.fmp = { blocker: 'FMP 로컬 키 없음' };
    else {
      output.fmp = [];
      for (const period of ['annual', 'quarter']) {
        for (const endpoint of ['income-statement', 'cash-flow-statement']) {
          const url = new URL(`https://financialmodelingprep.com/stable/${endpoint}`);
          for (const [name, value] of Object.entries({ symbol: 'NVDA', period, limit: period === 'annual' ? '10' : '12', apikey: key })) url.searchParams.set(name, value);
          const response = await getOnce(url);
          output.calls.push({ source: 'FMP', endpoint, period, ...response.diagnostic });
          const rows = Array.isArray(response.payload) ? response.payload : [];
          output.fmp.push({ endpoint, period, rows: rows.map(row => ({ date: row.date, fiscalYear: row.fiscalYear,
            period: row.period, filingDate: row.filingDate, revenue: row.revenue, operatingIncome: row.operatingIncome,
            netIncome: row.netIncome, eps: row.eps, epsDiluted: row.epsDiluted, grossProfit: row.grossProfit,
            operatingCashFlow: row.operatingCashFlow, capitalExpenditure: row.capitalExpenditure, freeCashFlow: row.freeCashFlow })) });
          if (!rows.length) break;
          await new Promise(done => setTimeout(done, 1000));
        }
        if (!output.fmp.at(-1).rows.length) break;
      }
    }
  }
  if (output.sec?.rows && output.productionRows) {
    const rename = { operating_income: 'operatingIncome', net_income: 'netIncome', free_cash_flow: 'freeCashFlow',
      gross_margin: 'grossMargin', operating_margin: 'operatingMargin' };
    output.regression = [];
    for (const type of ['annual', 'quarterly']) {
      for (const row of output.productionRows.filter(item => item.periodType === type).slice(0, type === 'annual' ? 2 : 4)) {
        const reprocessed = output.sec.rows.find(item => item.period_type === type && item.fiscal_period_end === row.fiscalPeriodEnd);
        for (const metric of metrics) output.regression.push({ type, end: row.fiscalPeriodEnd, metric,
          production: row[rename[metric] || metric] ?? null, reprocessed: reprocessed?.[metric] ?? null,
          ...difference(row[rename[metric] || metric], reprocessed?.[metric]) });
      }
    }
  }
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flags = new Set(process.argv.slice(2));
  if (![...flags].every(flag => ['--sec', '--production', '--businessquant', '--fmp'].includes(flag)) || flags.size === 0) {
    console.log('검증할 공급원을 --sec / --production / --businessquant / --fmp로 명시해 주세요.');
    process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(await runAudit(flags), null, 2)); }
    catch { console.log('검증 중 오류 발생. 비밀값 보호를 위해 원본 예외는 출력하지 않습니다.'); process.exitCode = 1; }
  }
}
