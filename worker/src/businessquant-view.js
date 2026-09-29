/** 저장된 BQ 요약과 기존 가격만 결합한다. 화면 요청에서는 외부 API를 호출하지 않는다. */
export function businessQuantDividendView(summary, currentPrice, priceSource = null) {
  if (!summary || summary.fetch_status !== 'ready') return null;
  const paidAmount = summary.paid_dividend_1y == null ? null : Number(summary.paid_dividend_1y);
  const price = currentPrice == null ? null : Number(currentPrice);
  const yieldRate = paidAmount !== null && Number.isFinite(price) && price > 0
    ? paidAmount / price * 100 : null;
  return {
    source: 'BUSINESS_QUANT', eventSource: 'BUSINESS_QUANT', eventCount: Number(summary.history_count || 0),
    dividendYield: yieldRate, yieldPriceSource: yieldRate === null ? null : priceSource,
    trailingPaidAmount: paidAmount, annualDividend: paidAmount,
    trailingPayoutCount: Number(summary.paid_payout_count || 0),
    lastPaidAmount: summary.last_paid_dividend, lastPaymentDate: summary.last_paid_payment_date,
    lastPaidExDate: summary.last_paid_ex_date, nextDividend: summary.next_dividend,
    nextExDividendDate: summary.next_ex_date, nextPaymentDate: summary.next_payment_date,
    // BQ의 미래 행은 일정 근거지만 선언 공시 자체를 증명하지는 않는다.
    nextExDateStatus: summary.next_ex_date ? 'announced' : 'unknown',
    nextDateSource: summary.next_ex_date ? 'Business Quant 미래 배당 이벤트' : null,
    dividendGrowth1y: summary.growth_rate_1y,
    dividendGrowthCagr5y: summary.growth_rate_5y,
    dividendGrowthCagr10y: summary.growth_rate_10y,
    dividendGrowthYears: summary.growth_years_available_history,
    frequencyLabel: summary.dividend_frequency,
    historyStart: summary.history_start, historyEnd: summary.history_end,
    specialFilterNote: summary.special_filter_note
  };
}
