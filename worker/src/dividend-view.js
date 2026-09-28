/** Alpha Vantage 배당 이력과 저장 주가만 결합한다. 미수집 종목은 미확보로 둔다. */
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

/** Alpha Vantage는 지급 빈도를 제공하지 않으므로 최근 배당락일 간격의 중앙값만 추정치로 사용한다. */
function inferredFrequency(events) {
  const dates = [...new Set(events.map(row => row.exDividendDate))].sort().slice(-7);
  if (dates.length < 3) return null;
  const gaps = dates.slice(1).map((date, index) => daysBetween(dates[index], date))
    .filter(gap => gap > 0 && gap < 500).sort((left, right) => left - right);
  const median = gaps[Math.floor(gaps.length / 2)];
  if (median >= 5 && median <= 10) return 52;
  if (median >= 20 && median <= 40) return 12;
  if (median >= 65 && median <= 115) return 4;
  if (median >= 150 && median <= 215) return 2;
  if (median >= 315 && median <= 405) return 1;
  return null;
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

export function combineDividendData(sourceMetrics, rawEvents, currentPrice,
  today = new Date().toISOString().slice(0, 10), yieldPriceSource = '저장 현재가') {
  // 과거 공급원의 요약이 우연히 전달되더라도 성장률과 지급액에 섞이지 않게 한다.
  const alphaMetrics = sourceMetrics?.source === 'ALPHA_VANTAGE' ? sourceMetrics : null;
  const events = (Array.isArray(rawEvents) ? rawEvents : [])
    .filter(row => row.source === 'ALPHA_VANTAGE')
    .map(row => ({ ...row, amount: validAmount(row.amount), exDividendDate: validDate(row.exDividendDate),
      adjustedAmount: validAmount(row.adjustedAmount), paymentDate: validDate(row.paymentDate),
      declarationDate: validDate(row.declarationDate), recordDate: validDate(row.recordDate),
      frequency: row.frequency !== null && row.frequency !== undefined
        && Number.isInteger(Number(row.frequency)) ? Number(row.frequency) : null }))
    .filter(row => row.amount !== null && row.exDividendDate)
    .sort((left, right) => left.exDividendDate.localeCompare(right.exDividendDate));
  const eventSource = events[0]?.source || null;
  const frequency = inferredFrequency(events);
  for (const event of events) if (event.frequency == null) event.frequency = frequency;
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
  // 이 API에는 배당 종류 구분이 없으므로 모든 과거 배당락일을 추정 입력으로 사용한다.
  const recurringPast = events.filter(row => row.exDividendDate < today);
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
    ...(alphaMetrics || {}),
    dividendGrowthYears: alphaMetrics?.dividendGrowthYears ?? null,
    dividendGrowth1y: alphaMetrics?.dividendGrowth1y ?? null,
    dividendGrowthCagr5y: alphaMetrics?.dividendGrowthCagr5y ?? null,
    dividendGrowthCagr10y: alphaMetrics?.dividendGrowthCagr10y ?? null,
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
    lastDistributionType: null,
    frequency,
    frequencySource: events.length ? '배당락일 간격 추정' : null,
    specialPayoutCount: null,
    nextExDividendDate: upcoming?.exDividendDate || estimatedDate || null,
    nextPaymentDate: futurePayment?.paymentDate || null,
    // 이미 배당락일이 지난 건의 선언일을 '다음' 선언일로 다시 표시하지 않는다.
    nextDeclarationDate: upcoming?.declarationDate || null,
    nextExDateStatus,
    nextPaymentDateStatus,
    nextDateStatus: futurePayment ? nextPaymentDateStatus : nextExDateStatus,
    nextDateSource: upcoming ? 'Alpha Vantage 발표 일정'
      : estimatedDate ? 'Alpha Vantage 과거 이력 추정' : null,
    eventSource,
    eventCount: alphaMetrics?.eventCount ?? events.length,
    yieldSource: dividendYield === null ? null : 'Alpha Vantage 지급 이벤트 + 저장 현재가'
  };
}
