// 추가 테이블만 생성하므로 기존 D1 데이터와 JSON 백업 형식은 그대로 유지된다.
export const fundamentalSchema = [
  `CREATE TABLE IF NOT EXISTS fundamental_locks (
    ticker TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS fundamental_jobs (
    ticker TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    checked_at TEXT, next_run_at TEXT, lease_until TEXT, lease_token TEXT,
    details TEXT, error TEXT, PRIMARY KEY(ticker, kind)
  )`,
  `CREATE TABLE IF NOT EXISTS sec_filing_checks (
    ticker TEXT PRIMARY KEY, accession TEXT, checked_at TEXT, report_date TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS dividend_periods (
    ticker TEXT NOT NULL, period_type TEXT NOT NULL, period_end TEXT NOT NULL,
    amount REAL NOT NULL, source TEXT NOT NULL, reported_date TEXT,
    PRIMARY KEY(ticker, period_type, period_end)
  )`,
  `CREATE TABLE IF NOT EXISTS fundamental_api_budget (
    day TEXT PRIMARY KEY, calls INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS fundamental_api_blocks (
    resource TEXT PRIMARY KEY, retry_at TEXT NOT NULL, reason TEXT NOT NULL
  )`
];

export async function ensureFundamentalStore(environment) {
  // 요청 안에서만 준비 상태를 공유한다. 배포/DB 바인딩 변경 때 오래된 전역 상태를 재사용하지 않는다.
  if (!environment.fundamentalStoreReady) {
    await environment.DB.batch(fundamentalSchema.map(sql => environment.DB.prepare(sql)));
    environment.fundamentalStoreReady = true;
  }
}

/** 재무 외 부가 API 호출도 일일 예산을 원자적으로 예약해 동시 실행 시 초과를 막는다. */
export async function reserveFundamentalCall(environment, path, ticker) {
  await ensureFundamentalStore(environment);
  const resource = `${path}:${ticker}`;
  const block = await environment.DB.prepare(`SELECT reason FROM fundamental_api_blocks
    WHERE resource IN (?, '*') AND retry_at > ? LIMIT 1`).bind(resource, new Date().toISOString()).first();
  if (block) throw new Error(block.reason);
  const result = await environment.DB.prepare(`INSERT INTO fundamental_api_budget(day, calls) VALUES (?, 1)
    ON CONFLICT(day) DO UPDATE SET calls=calls+1 WHERE calls < 150 RETURNING calls`)
    .bind(new Date().toISOString().slice(0, 10)).first();
  if (!result) throw new Error('FMP 부가 데이터 일일 예산 소진: 다음날 재시도');
}

export async function blockFundamentalCall(environment, path, ticker, status) {
  if (![402, 429].includes(status)) return;
  const hours = status === 402 ? 24 * 30 : 24;
  await environment.DB.prepare(`INSERT INTO fundamental_api_blocks(resource, retry_at, reason) VALUES (?, ?, ?)
    ON CONFLICT(resource) DO UPDATE SET retry_at=excluded.retry_at, reason=excluded.reason`)
    .bind(status === 429 ? '*' : `${path}:${ticker}`, new Date(Date.now() + hours * 3600000).toISOString(),
      `FMP HTTP ${status}: ${status === 402 ? '이 종목/API 접근 제한, FMP 전용 항목은 미확보' : '호출 제한, 24시간 대기'}`).run();
}
