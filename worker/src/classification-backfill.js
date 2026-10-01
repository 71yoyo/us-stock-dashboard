import { classificationStatement } from './company-classification.js';

// metadata CAS를 실제 write transaction에서 강제한다. queue/시세/배당 pipeline은 멈추지 않는다.
export function metadataGuard(DB, company) {
  return DB.prepare(`INSERT INTO specialized_import_guard(id,ok) VALUES(1,CASE WHEN EXISTS
    (SELECT 1 FROM companies WHERE ticker=? AND sector IS ? AND industry IS ? AND cik IS ?)
    THEN 1 ELSE 0 END) ON CONFLICT(id) DO UPDATE SET ok=excluded.ok`)
    .bind(company.ticker, company.sector ?? null, company.industry ?? null, company.cik ?? null);
}
export async function backfillClassification(DB, ticker, { beforeWrite = async () => {}, maxAttempts = 3 } = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const company = await DB.prepare('SELECT ticker,sector,industry,cik FROM companies WHERE ticker=?').bind(ticker).first();
    if (!company) throw new Error('분류할 회사 metadata가 없습니다.');
    await beforeWrite(company, attempt);
    try {
      await DB.batch([metadataGuard(DB, company), classificationStatement(DB, company), metadataGuard(DB, company)]);
      return { ticker, attempts: attempt + 1, metadataCas: true };
    } catch (error) {
      // CHECK 오류만 재조회한다. 마지막 실패는 운영자에게 보고하며 무한 재시도하지 않는다.
      if (!/CHECK constraint failed/i.test(String(error.message)) || attempt + 1 >= maxAttempts) throw error;
    }
  }
  throw new Error('분류 CAS 재시도 한도 초과');
}
