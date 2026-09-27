/** SEC 장기 성장 통계와 Massive 지급 이벤트를 항목별로 결합한다. */
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
  if (dates.length < 2 || daysBetween(dates.at(-1), today) > 120) return null;
  const frequency = pastEvents.at(-1)?.frequency;
  if (frequency === 52 || frequency === 104) {
    const gap = frequency === 52 ? 7 : 3.5;
    const elapsed = Math.max(1, Math.ceil(daysBetween(dates.at(-1), today) / gap));
    const date = new Date(`${dates.at(-1)}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + Math.round(elapsed * gap));
    return date.toISOString().slice(0, 10);
  }
  const recent = dates.slice(-3);
  const isMonthly = frequency === 12 || (recent.length === 3 && recent.slice(1).every((date, index) => {
    const gap = daysBetween(recent[index], date);
    return gap >= 20 && gap <= 40;
  }));
  if (isMonthly) {
    let candidate = dates.at(-1);
    for (let attempt = 0; attempt < 4 && candidate < today; attempt += 1) candidate = shiftMonths(candidate, 1);
    return candidate >= today ? candidate : null;
  }
  const candidates = dates.map(date => shiftMonths(date, 12))
    .filter(date => date >= today && daysBetween(today, date) <= 120).sort();
  return candidates[0] || null;
}

export function combineDividendData(secMetrics, rawEvents, currentPrice,
  today = new Date().toISOString().slice(0, 10), yieldPriceSource = '저장 현재가') {
  const events = (Array.isArray(rawEvents) ? rawEvents : [])
    .filter(row => row.source === 'MASSIVE')
    .map(row => ({ ...row, amount: validAmount(row.amount), exDividendDate: validDate(row.exDividendDate),
      adjustedAmount: validAmount(row.adjustedAmount), paymentDate: validDate(row.paymentDate),
      declarationDate: validDate(row.declarationDate), recordDate: validDate(row.recordDate),
      frequency: row.frequency !== null && row.frequency !== undefined
        && Number.isInteger(Number(row.frequency)) ? Number(row.frequency) : null }))
    .filter(row => row.amount !== null && row.exDividendDate)
    .sort((left, right) => left.exDividendDate.localeCompare(right.exDividendDate));
  const paid = events.filter(row => row.paymentDate && row.paymentDate <= today)
    .sort((left, right) => left.paymentDate.localeCompare(right.paymentDate));
  const lastPaid = paid.at(-1) || null;
  const yearStart = oneYearBefore(today);
  const payouts = paid.filter(row => row.paymentDate > yearStart);
  // 현재 주가와 비교할 때는 분할 전 배당을 현재 주식 수 기준으로 환산해야 한다.
  const trailingPaidAmount = payouts.length ? payouts.reduce((sum, row) => sum + (row.adjustedAmount ?? row.amount), 0) : null;
  const quarterStart = shiftMonths(today, -3);
  const quarterPayouts = paid.filter(row => row.paymentDate > quarterStart);
  const trailingQuarterAmount = quarterPayouts.length
    ? quarterPayouts.reduce((sum, row) => sum + (row.adjustedAmount ?? row.amount), 0) : null;
  const price = validAmount(currentPrice);
  // 지급일이 명시된 이벤트만 사용한다. 배당락일로 지급일을 대체하면 미래 지급분이 섞일 수 있다.
  const dividendYield = trailingPaidAmount !== null && price !== null
    ? trailingPaidAmount / price * 100 : null;
  const upcoming = events.find(row => row.exDividendDate >= today) || null;
  const recurringPast = events.filter(row => row.exDividendDate < today
    && !['special', 'supplemental', 'irregular'].includes(row.distributionType));
  const estimatedDate = upcoming ? null : estimateNextExDate(recurringPast, today);
  // 공급원에 미래 날짜가 있더라도 선언일이 확인되지 않으면 확정 공시로 표시하지 않는다.
  const confirmed = upcoming && upcoming.declarationDate && upcoming.declarationDate <= today;
  const futurePayment = events.filter(row => row.paymentDate && row.paymentDate >= today)
    .sort((left, right) => left.paymentDate.localeCompare(right.paymentDate))[0] || null;
  const nextExDateStatus = upcoming ? (confirmed ? 'confirmed' : 'estimated')
    : estimatedDate ? 'estimated' : 'unknown';
  const nextPaymentDateStatus = futurePayment
    ? (futurePayment.declarationDate && futurePayment.declarationDate <= today ? 'confirmed' : 'estimated')
    : 'unknown';
  return {
    ...(secMetrics || {}),
    dividendGrowthYears: secMetrics?.dividendGrowthYears ?? null,
    dividendGrowthCagr10y: secMetrics?.dividendGrowthCagr10y ?? null,
    secAnnualDividend: secMetrics?.annualDividend ?? null,
    secQuarterlyDividend: secMetrics?.quarterlyDividend ?? null,
    annualDividend: trailingPaidAmount,
    quarterlyDividend: trailingQuarterAmount,
    dividendYield,
    yieldPriceSource: dividendYield === null ? null : yieldPriceSource,
    trailingPaidAmount,
    trailingPayoutCount: payouts.length,
    lastPaidAmount: lastPaid?.amount ?? null,
    lastPaidAdjustedAmount: lastPaid?.adjustedAmount ?? null,
    lastPaymentDate: lastPaid?.paymentDate ?? null,
    lastRecordDate: lastPaid?.recordDate ?? null,
    lastDeclarationDate: lastPaid?.declarationDate ?? null,
    lastDistributionType: lastPaid?.distributionType || null,
    frequency: events.filter(row => row.distributionType === 'recurring').at(-1)?.frequency
      ?? lastPaid?.frequency ?? events.at(-1)?.frequency ?? null,
    specialPayoutCount: payouts.filter(row => row.distributionType === 'special').length,
    nextExDividendDate: upcoming?.exDividendDate || estimatedDate || null,
    nextPaymentDate: futurePayment?.paymentDate || null,
    nextDeclarationDate: upcoming?.declarationDate || futurePayment?.declarationDate || null,
    nextExDateStatus,
    nextPaymentDateStatus,
    nextDateStatus: futurePayment ? nextPaymentDateStatus : nextExDateStatus,
    nextDateSource: upcoming ? 'Massive 일정' : estimatedDate ? 'Massive 과거 이벤트 추정' : null,
    eventSource: events.length ? 'MASSIVE' : null,
    eventCount: events.length,
    yieldSource: dividendYield === null ? null : 'Massive 지급 이벤트 + 저장 현재가'
  };
}
