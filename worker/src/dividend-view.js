/** SEC 기간 집계와 FMP 개별 지급 이벤트를 항목별로 결합한다. 서로의 원본값은 덮어쓰지 않는다. */
function validAmount(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? value : null;
}

function oneYearBefore(date) {
  const year = Number(date.slice(0, 4)) - 1;
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${date.slice(5, 7)}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
}

function shiftMonths(date, months) {
  const year = Number(date.slice(0, 4));
  const monthIndex = Number(date.slice(5, 7)) - 1 + months;
  const targetYear = year + Math.floor(monthIndex / 12);
  const targetMonth = ((monthIndex % 12) + 12) % 12;
  const day = Number(date.slice(8, 10));
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
}

function daysBetween(left, right) {
  return (Date.parse(`${right}T00:00:00Z`) - Date.parse(`${left}T00:00:00Z`)) / 86_400_000;
}

/** 다음 일정이 없을 때만 전월(월배당) 또는 전년 같은 시기 이벤트로 보수적으로 예측한다. */
function estimateNextExDate(pastEvents, today) {
  const dates = [...new Set(pastEvents.map(row => row.exDividendDate))].sort();
  if (dates.length < 3 || daysBetween(dates.at(-1), today) > 120) return null;
  const recent = dates.slice(-3);
  const isMonthly = recent.slice(1).every((date, index) => {
    const gap = daysBetween(recent[index], date);
    return gap >= 20 && gap <= 40;
  });
  if (isMonthly) {
    let candidate = dates.at(-1);
    for (let attempt = 0; attempt < 4 && candidate < today; attempt += 1) candidate = shiftMonths(candidate, 1);
    return candidate >= today ? candidate : null;
  }
  const candidates = dates.map(date => shiftMonths(date, 12))
    .filter(date => date >= today && daysBetween(today, date) <= 120).sort();
  return candidates[0] || null;
}

export function combineDividendData(secMetrics, rawEvents, currentPrice, today = new Date().toISOString().slice(0, 10)) {
  const events = (Array.isArray(rawEvents) ? rawEvents : [])
    .filter(row => row.source === 'FMP')
    .map(row => ({ ...row, amount: validAmount(row.amount), exDividendDate: validDate(row.exDividendDate),
      paymentDate: validDate(row.paymentDate), declarationDate: validDate(row.declarationDate) }))
    .filter(row => row.amount !== null && row.exDividendDate)
    .sort((left, right) => left.exDividendDate.localeCompare(right.exDividendDate));
  const paid = events.filter(row => row.paymentDate && row.paymentDate <= today)
    .sort((left, right) => left.paymentDate.localeCompare(right.paymentDate));
  const lastPaid = paid.at(-1) || null;
  const yearStart = oneYearBefore(today);
  const payouts = paid.filter(row => row.paymentDate > yearStart);
  const trailingPaidAmount = payouts.length ? payouts.reduce((sum, row) => sum + row.amount, 0) : null;
  const price = validAmount(currentPrice);
  // 지급일이 명시된 이벤트만 사용한다. 배당락일로 지급일을 대체하면 미래 지급분이 섞일 수 있다.
  const dividendYield = trailingPaidAmount !== null && price !== null
    ? trailingPaidAmount / price * 100 : null;
  const upcoming = events.find(row => row.exDividendDate >= today) || null;
  const estimatedDate = upcoming ? null : estimateNextExDate(events.filter(row => row.exDividendDate < today), today);
  // FMP 일정이라도 공시일이 없으면 확정으로 오인하지 않는다.
  const confirmed = upcoming && upcoming.declarationDate && upcoming.declarationDate <= today;
  return {
    ...(secMetrics || {}),
    dividendYield,
    trailingPaidAmount,
    trailingPayoutCount: payouts.length,
    lastPaidAmount: lastPaid?.amount ?? null,
    lastPaymentDate: lastPaid?.paymentDate ?? null,
    nextExDividendDate: upcoming?.exDividendDate || estimatedDate || null,
    nextPaymentDate: upcoming?.paymentDate && upcoming.paymentDate >= today ? upcoming.paymentDate : null,
    nextDateStatus: upcoming ? (confirmed ? 'confirmed' : 'estimated') : estimatedDate ? 'estimated' : 'unknown',
    nextDateSource: upcoming ? 'FMP 일정' : estimatedDate ? 'FMP 과거 이벤트 추정' : null,
    eventSource: events.length ? 'FMP' : null,
    eventCount: events.length,
    yieldSource: dividendYield === null ? null : 'FMP 지급 이벤트 + 저장 현재가'
  };
}
