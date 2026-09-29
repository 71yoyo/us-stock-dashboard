import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { parseBusinessQuantResponse, calculateBusinessQuantMetrics } from '../worker/src/businessquant-metrics.js';
import { diffBusinessQuantRows } from '../worker/src/businessquant-sync.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const secretFile = join(root, 'worker', '.dev.vars.businessquant');
const secretLine = readFileSync(secretFile, 'utf8').split(/\r?\n/)
  .find(line => line.startsWith('BUSINESS_QUANT_API_KEY='));
const apiKey = secretLine?.slice('BUSINESS_QUANT_API_KEY='.length).trim();
if (!apiKey) throw new Error('로컬 Business Quant 키를 찾지 못했습니다.');

// 로컬 D1만 읽기 전용으로 연다. 운영 D1이나 홈페이지에는 연결하지 않는다.
const d1Directory = join(root, 'worker', '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject');
const databases = readdirSync(d1Directory).filter(name => name.endsWith('.sqlite') && name !== 'metadata.sqlite');
if (databases.length !== 1) throw new Error('로컬 D1 파일을 하나로 특정하지 못했습니다.');
const db = new DatabaseSync(join(d1Directory, databases[0]), { readOnly: true });
const tickers = ['JPM', 'O', 'ABBV', 'ABT', 'PG', 'JNJ'];
const today = new Date().toISOString().slice(0, 10);

for (const ticker of tickers) {
  const url = new URL('https://data.businessquant.com/dividends');
  url.searchParams.set('ticker', ticker);
  url.searchParams.set('mode', 'dps');
  url.searchParams.set('api_key', apiKey);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) {
      console.log(JSON.stringify({ ticker, httpStatus: response.status, error: '공급원 응답 실패' }));
      continue;
    }
    const { events, metadata } = parseBusinessQuantResponse(await response.json(), ticker);
    const massiveEvents = db.prepare(`SELECT ex_dividend_date AS exDividendDate,
      distribution_type AS distributionType, declaration_date AS declarationDate,
      payment_date AS paymentDate FROM massive_dividend_events WHERE ticker=?`).all(ticker);
    const existing = db.prepare(`SELECT ex_date AS exDate, payment_date AS paymentDate, dividend
      FROM bq_dividend_history WHERE ticker=?`).all(ticker);
    const quote = db.prepare(`SELECT current_price AS price, market_updated_at AS updatedAt
      FROM price_quotes WHERE ticker=?`).get(ticker);
    const metrics = calculateBusinessQuantMetrics(events, massiveEvents, today);
    const difference = diffBusinessQuantRows(existing, events);
    const latestMassive = massiveEvents.filter(row => row.distributionType && row.paymentDate
      && row.paymentDate <= today)
      .sort((a, b) => b.paymentDate.localeCompare(a.paymentDate))[0] || null;
    const nextDeclaration = massiveEvents.filter(row => row.declarationDate && row.declarationDate <= today
      && row.exDividendDate > today && row.exDividendDate === metrics.nextExDate)
      .sort((a, b) => a.exDividendDate.localeCompare(b.exDividendDate))[0] || null;
    // 공급원 원문과 요청 URL에는 키가 있으므로 출력하지 않고 필요한 통계만 내보낸다.
    console.log(JSON.stringify({ ticker, httpStatus: response.status, received: difference.received,
      existing: difference.existing, inserted: difference.inserted.length,
      updated: difference.updated.length, unchanged: difference.unchanged,
      historyStart: metrics.historyStart, historyEnd: metrics.historyEnd,
      frequency: metrics.dividendFrequency, paidDividend1y: metrics.paidDividend1y,
      paidPayoutCount: metrics.paidPayoutCount,
      paidYield1y: metrics.paidDividend1y != null && Number(quote?.price) > 0
        ? metrics.paidDividend1y / Number(quote.price) * 100 : null,
      priceDate: quote?.updatedAt || null,
      lastPaidDividend: metrics.lastPaidDividend,
      lastPaidExDate: metrics.lastPaidExDate,
      lastPaidPaymentDate: metrics.lastPaidPaymentDate,
      nextExDate: metrics.nextExDate, nextDividend: metrics.nextDividend,
      nextPaymentDate: metrics.nextPaymentDate,
      growthRate1y: metrics.growthRate1y, growthRate5y: metrics.growthRate5y,
      growthRate10y: metrics.growthRate10y,
      growthYearsAvailableHistory: metrics.growthYearsAvailableHistory,
      massiveType: latestMassive?.distributionType || null,
      massiveNextDeclaration: nextDeclaration?.declarationDate || null,
      massiveEventCount: massiveEvents.length,
      metadataDivyield: metadata.divyield ?? null,
      metadataTtmDividend: metadata.ttmdividend ?? null,
      specialFilterNote: metrics.specialFilterNote }));
  } catch (error) {
    // fetch 예외에 요청 URL이 포함될 수 있으므로 원본 메시지를 절대 출력하지 않는다.
    console.log(JSON.stringify({ ticker, httpStatus: null, error: '연결 또는 응답 처리 실패',
      errorType: error?.constructor?.name || null, errorCode: error?.cause?.code || null }));
  }
}
db.close();
