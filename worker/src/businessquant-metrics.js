const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function dateValue(value) {
  if (!ISO_DATE.test(String(value || ''))) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? value : null;
}

function amountValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

/** 공급원 응답의 일부 필드만 우연히 일치해도 정상 이력으로 오인하지 않는다. */
export function parseBusinessQuantResponse(payload, ticker) {
  if (!payload || !Array.isArray(payload.data) || !payload.metadata
    || String(payload.metadata.ticker || '').toUpperCase() !== ticker) {
    throw new Error(`${ticker}: Business Quant 응답 형식이 올바르지 않아 기존 이력을 유지합니다.`);
  }
  if (!payload.data.length) throw new Error(`${ticker}: Business Quant 이력이 비어 있어 기존 이력을 유지합니다.`);
  const events = payload.data.map((row, index) => {
    const exDate = dateValue(row.ex_date);
    const dividend = amountValue(row.dividend);
    const paymentDate = row.payment_date ? dateValue(row.payment_date) : null;
    if (!exDate || !dividend || (row.payment_date && !paymentDate)) {
      throw new Error(`${ticker}: ${index + 1}번째 배당 기록이 잘못되어 기존 이력을 유지합니다.`);
    }
    return { exDate, paymentDate, dividend };
  }).sort((a, b) => a.exDate.localeCompare(b.exDate));
  // 같은 배당락일에 여러 지급 이벤트가 있으면 기본 키로 구별할 수 없다. 조용히 합치지 않는다.
  if (new Set(events.map(row => row.exDate)).size !== events.length) {
    throw new Error(`${ticker}: 동일 배당락일의 복수 이벤트를 구별할 수 없어 기존 이력을 유지합니다.`);
  }
  return { events, metadata: payload.metadata };
}

function median(values) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered.length ? ordered[Math.floor(ordered.length / 2)] : null;
}

function gapsOf(events) {
  const dates = events.map(row => row.exDate).sort();
  return dates.slice(1).map((date, index) =>
    (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${dates[index]}T00:00:00Z`)) / DAY_MS)
    .filter(gap => gap > 0 && gap < 500);
}

/** 최근 여러 간격의 중앙값으로 주기를 판단해 휴장일과 한 번의 일정 변동에 흔들리지 않게 한다. */
export function inferDividendFrequency(events) {
  if (events.length < 6) return { label: null, medianDays: null };
  const gaps = gapsOf(events.slice(-13));
  if (gaps.length < 5) return { label: null, medianDays: null };
  const typical = median(gaps);
  const matching = (low, high) => gaps.filter(gap => gap >= low && gap <= high).length >= Math.ceil(gaps.length * 0.7);
  const label = matching(20, 40) ? '월' : matching(70, 110) ? '분기'
    : matching(150, 210) ? '반기' : matching(330, 400) ? '연' : '비정기';
  return { label, medianDays: typical };
}

export function estimateNextExDate(events, today) {
  const past = events.filter(row => row.exDate <= today);
  const { label, medianDays } = inferDividendFrequency(past);
  if (!medianDays || label === '비정기') return null;
  let time = Date.parse(`${past.at(-1).exDate}T00:00:00Z`);
  const current = Date.parse(`${today}T00:00:00Z`);
  for (let count = 0; count < 24 && time <= current; count += 1) time += medianDays * DAY_MS;
  return new Date(time).toISOString().slice(0, 10);
}

const PAYOUTS_PER_YEAR = { '월': 12, '분기': 4, '반기': 2, '연': 1 };

function yearlyPaidTotals(events, completedYear) {
  const years = new Map();
  for (const event of events) {
    // 배당락일이 연말을 넘나들어도 실제 지급 연도의 횟수와 금액을 비교한다.
    if (!event.paymentDate || event.isSpecial) continue;
    const year = Number(event.paymentDate.slice(0, 4));
    if (year > completedYear) continue;
    const prior = years.get(year) || { total: 0, count: 0 };
    years.set(year, { total: prior.total + event.dividend, count: prior.count + 1 });
  }
  return years;
}

/** BQ 원본과 Massive가 확인한 날짜만 교차해 특별·추가 배당을 제외한다. 오래된 미분류는 추측하지 않는다. */
export function calculateBusinessQuantMetrics(events, massiveEvents = [], today = new Date().toISOString().slice(0, 10)) {
  if (!dateValue(today)) throw new Error('배당 계산 기준일이 올바르지 않습니다.');
  const specialDates = new Set(massiveEvents.filter(row => ['special', 'supplemental'].includes(row.distributionType))
    .map(row => row.exDividendDate));
  const classified = events.map(row => ({ ...row, isSpecial: specialDates.has(row.exDate) }));
  const regular = classified.filter(row => !row.isSpecial);
  // 원본 DPS에 분할 보정 필드가 없다. 극단적인 급변 구간은 분할/특별배당 가능성이 있어 비교값을 숨긴다.
  const abruptDates = regular.slice(1).flatMap((row, index) => {
    const ratio = row.dividend / regular[index].dividend;
    return ratio >= 2.5 || ratio <= 0.4 ? [row.exDate] : [];
  });
  const abruptWithin = (start, end) => abruptDates.some(date => date >= start && date <= end);
  const paid = classified.filter(row => row.paymentDate && row.paymentDate <= today)
    .sort((a, b) => a.paymentDate.localeCompare(b.paymentDate));
  const yearAgo = new Date(Date.parse(`${today}T00:00:00Z`) - 365 * DAY_MS).toISOString().slice(0, 10);
  const recentPaid = paid.filter(row => row.paymentDate > yearAgo);
  const recentAmountsComparable = !abruptWithin(yearAgo, today);
  const future = classified.filter(row => row.exDate > today).sort((a, b) => a.exDate.localeCompare(b.exDate))[0] || null;
  const frequency = inferDividendFrequency(regular.filter(row => row.exDate <= today));
  const completedYear = Number(today.slice(0, 4)) - 1;
  const paidYears = yearlyPaidTotals(classified, completedYear);
  const expectedPayouts = PAYOUTS_PER_YEAR[frequency.label] || null;
  const lastCompletedYear = completedYear;
  // 주기를 모르면 연간 완전성을 판별할 수 없다. 횟수가 부족하거나 초과한 연도는 추정치로 채우지 않는다.
  const safeYear = year => expectedPayouts && paidYears.get(year)?.count === expectedPayouts
    && paidYears.get(year).total > 0;
  const completeSpan = years => Array.from({ length: years + 1 }, (_, index) =>
    safeYear(lastCompletedYear - index)).every(Boolean);
  const growth = years => completeSpan(years)
    && !abruptWithin(`${lastCompletedYear - years}-01-01`, `${lastCompletedYear}-12-31`)
    ? (Math.pow(paidYears.get(lastCompletedYear).total
      / paidYears.get(lastCompletedYear - years).total, 1 / years) - 1) * 100
    : null;
  let growthYears = 0;
  for (let year = lastCompletedYear; safeYear(year) && safeYear(year - 1); year -= 1) {
    if (abruptWithin(`${year - 1}-01-01`, `${year}-12-31`)) break;
    if (paidYears.get(year).total <= paidYears.get(year - 1).total) break;
    growthYears += 1;
  }
  const incompleteYear = [...paidYears].reverse().find(([year, value]) => year <= completedYear
    && year >= completedYear - 10 && expectedPayouts && value.count !== expectedPayouts);
  const coverageNote = !expectedPayouts ? ' · 정기 배당 주기 미확인으로 성장률 미표시'
    : incompleteYear ? ` · ${incompleteYear[0]}년 지급 ${incompleteYear[1].count}회/${expectedPayouts}회로 성장률 비교 시 제외` : '';
  return {
    historyStart: events[0].exDate, historyEnd: events.at(-1).exDate, historyCount: events.length,
    dividendFrequency: frequency.label, paidDividend1y: recentPaid.length && recentAmountsComparable
      ? recentPaid.reduce((sum, row) => sum + row.dividend, 0) : null,
    paidPayoutCount: recentPaid.length,
    lastPaidDividend: paid.at(-1)?.dividend ?? null,
    lastPaidExDate: paid.at(-1)?.exDate ?? null,
    lastPaidPaymentDate: paid.at(-1)?.paymentDate ?? null,
    nextDividend: future?.dividend ?? null,
    nextExDate: future?.exDate ?? null,
    nextPaymentDate: future?.paymentDate ?? null,
    growthRate1y: growth(1), growthRate5y: growth(5), growthRate10y: growth(10),
    growthYearsAvailableHistory: safeYear(lastCompletedYear) ? growthYears : null,
    estimatedNextExDate: future ? null : estimateNextExDate(regular, today),
    specialFilterNote: `${specialDates.size ? 'Massive에서 확인된 특별·추가 배당 제외' : '과거 특별배당 미분류 가능'} · 성장률은 지급연도별 정기배당 횟수 기준${abruptDates.length ? ' · DPS 급변 구간은 분할 여부 미확인으로 성장률/수익률 일부 미표시' : ''}${coverageNote}`
  };
}
