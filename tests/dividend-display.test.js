import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const appSource = readFileSync(new URL('../app.js', import.meta.url), 'utf8');

// 정적 앱을 통째로 실행하면 PIN·네트워크 초기화가 시작되므로 표시 함수만 분리해 검증한다.
function appFunctionSource(name, nextMarker) {
  const start = appSource.indexOf(`function ${name}(`);
  const end = appSource.indexOf(nextMarker, start);
  assert.ok(start >= 0 && end > start, `${name} 함수 위치를 찾을 수 없습니다.`);
  return appSource.slice(start, end);
}

test('종합 화면은 지급일이 아니라 배당락일과 그 D-day를 한 칸에 표시한다', () => {
  const context = {
    toNullableNumber: value => value == null ? null : Number(value),
    formatWeekdayCountdown: value => value === '2026-09-30' ? 'D-3' : '잘못된 날짜'
  };
  vm.createContext(context);
  vm.runInContext(appFunctionSource('formatExDividendMonthDay', '\n/** 종합 화면의 날짜와 D-day'), context);
  vm.runInContext(appFunctionSource('getStoredDividendInfo', '\n/** 사용자가 요청한 D-day'), context);

  const stock = { marketData: { dividendMetrics: {
    source: 'BUSINESS_QUANT',
    nextExDividendDate: '2026-09-30', nextExDateStatus: 'announced',
    nextPaymentDate: '2026-10-15', nextPaymentDateStatus: 'confirmed'
  } } };
  const result = context.getStoredDividendInfo(stock);
  assert.equal(result.nextDate, '09월 30일');
  assert.equal(result.daysLeft, 'D-3');
  assert.equal(result.statusLabel, '저장된 예정 배당락일');

  stock.marketData.dividendMetrics.nextExDateStatus = 'estimated';
  assert.equal(context.getStoredDividendInfo(stock).statusLabel, '추정 배당락일');
  stock.marketData.dividendMetrics.source = 'SEC EDGAR';
  assert.equal(context.getStoredDividendInfo(stock).nextDate, '미정');
  assert.match(appSource, /class="overview-ex-dividend-cell[^\n]+overview-ex-countdown/);
  assert.doesNotMatch(appSource, /overview-dividend-day-cell|overview-next-dividend-cell/);
});

test('모든 종목의 상세 배당은 요청한 세 카드와 지급일·날짜 상태를 숨기고 배당락일 상태를 표시한다', () => {
  const elements = Object.fromEntries(['detailFinancialMetrics', 'detailDividendMetrics', 'detailFinancialSource', 'detailDividendSource']
    .map(id => [id, { innerHTML: '', textContent: '' }]));
  const context = {
    document: { getElementById: id => elements[id] },
    toNullableNumber: value => value == null ? null : Number(value),
    formatDividendAmount: value => value == null ? '데이터 없음' : `$${value}`,
    formatMetricValue: value => value == null ? '데이터 없음' : String(value),
    formatWeekdayCountdown: () => 'D-3',
    escapeHtml: value => String(value)
  };
  vm.createContext(context);
  vm.runInContext(appFunctionSource('renderCompanyDetailData', '\n/**\n * [서브메뉴 4-2]'), context);

  const company = { financials: [], regularDividendFrequency: {
    source: 'MASSIVE', frequency: 12, exDividendDate: '2026-09-30'
  }, lastMassiveDividendType: { source: 'MASSIVE', distributionType: 'special',
    exDividendDate: '2026-10-01' }, dividendMetrics: {
    source: 'BUSINESS_QUANT', frequencyLabel: '월',
    nextExDividendDate: '2026-09-30', nextExDateStatus: 'announced',
    nextPaymentDate: '2026-10-15', nextPaymentDateStatus: 'confirmed',
    annualDividend: 3.24, quarterlyDividend: 0.81,
    nextDateSource: 'Business Quant 미래 배당 이벤트',
    dividendGrowth1y: 4.5, dividendGrowthCagr5y: 3.25, dividendGrowthCagr10y: null
  } };
  context.renderCompanyDetailData(company);
  const displayedLabels = [...elements.detailDividendMetrics.innerHTML.matchAll(/<div class="company-metric[^"]*"><span>([^<]+)<\/span>/g)]
    .map(match => match[1]);
  assert.deepEqual(displayedLabels.slice(0, 2), ['정기 배당 빈도', '마지막 배당 종류']);
  assert.match(elements.detailDividendMetrics.innerHTML,
    /정기 배당 빈도<\/span><strong>월<\/strong><small>Business Quant 최근/);
  assert.match(elements.detailDividendMetrics.innerHTML,
    /마지막 배당 종류<\/span><strong>특별<\/strong><small>Massive 저장 배당/);
  company.dividendMetrics.frequencyLabel = '분기';
  context.renderCompanyDetailData(company);
  assert.match(elements.detailDividendMetrics.innerHTML, /정기 배당 빈도<\/span><strong>분기<\/strong>/);
  company.dividendMetrics.frequencyLabel = '월';
  assert.match(elements.detailDividendMetrics.innerHTML, /다음 배당락일[\s\S]*저장된 미래 이벤트 · Business Quant 미래 배당 이벤트 · D-3/);
  assert.match(elements.detailDividendMetrics.innerHTML, /최근 1년 실제 지급액/);
  assert.match(elements.detailDividendMetrics.innerHTML, /<span>배당 성장률<\/span><strong>1년 4\.50% · 5년 3\.25% · 10년 미확보<\/strong>/);
  assert.equal((elements.detailDividendMetrics.innerHTML.match(/<span>배당 성장률<\/span>/g) || []).length, 1);
  assert.doesNotMatch(elements.detailDividendMetrics.innerHTML, /<span>10년 배당 성장률<\/span>/);
  assert.doesNotMatch(elements.detailDividendMetrics.innerHTML, /최근 3개월 실제 지급액|SEC 최근 연간 주당배당금|SEC 최근 분기 주당배당금/);
  assert.match(elements.detailDividendMetrics.innerHTML, /다음 지급일/);
  assert.doesNotMatch(elements.detailDividendMetrics.innerHTML, /날짜 상태/);
  assert.doesNotMatch(elements.detailDividendMetrics.innerHTML, /마지막 배당 선언일|마지막 배당 기록일/);

  // 새 배당 이력이 저장되어 같은 상세 창을 다시 그리면 날짜·성장률·수익률 모두 새 값으로 바뀐다.
  company.dividendMetrics.nextDeclarationDate = '2026-09-25';
  company.dividendMetrics.dividendYield = 5.84;
  company.dividendMetrics.dividendGrowth1y = 5.25;
  company.dividendMetrics.dividendGrowthCagr5y = 4.75;
  company.dividendMetrics.dividendGrowthCagr10y = 3.5;
  context.renderCompanyDetailData(company);
  assert.match(elements.detailDividendMetrics.innerHTML, /다음 배당 선언일<\/span><strong>2026-09-25<\/strong>/);
  assert.match(elements.detailDividendMetrics.innerHTML, /최근 실제 지급 1년 배당수익률<\/span><strong>5\.84%<\/strong>/);
  assert.match(elements.detailDividendMetrics.innerHTML, /1년 5\.25% · 5년 4\.75% · 10년 3\.50%/);

  company.dividendMetrics.nextExDateStatus = 'estimated';
  context.renderCompanyDetailData(company);
  assert.match(elements.detailDividendMetrics.innerHTML, /다음 배당락일[\s\S]*상태 미확보 · Business Quant 미래 배당 이벤트 · D-3/);

  // Alpha 성장률이 없으면 옛 SEC 이력을 다시 계산하지 않고 미확보로 둔다.
  company.dividendMetrics.dividendGrowth1y = null;
  company.dividendMetrics.dividendGrowthCagr5y = null;
  company.dividendMetrics.dividendGrowthCagr10y = null;
  company.dividendHistory = [
    ['2015-12-31', 1], ['2020-12-31', 1.5], ['2024-12-31', 1.8], ['2025-12-31', 2]
  ].map(([periodEnd, amount]) => ({ periodType: 'annual', periodEnd, amount, source: 'SEC EDGAR' }));
  context.renderCompanyDetailData(company);
  assert.match(elements.detailDividendMetrics.innerHTML, /1년 미확보 · 5년 미확보 · 10년 미확보/);
  company.dividendMetrics.source = 'SEC EDGAR';
  context.renderCompanyDetailData(company);
  assert.match(elements.detailDividendSource.textContent, /Business Quant 배당 이력을 아직 저장하지 못했습니다/);
  assert.doesNotMatch(elements.detailDividendMetrics.innerHTML, /\$3\.24|\$0\.81/);
  company.regularDividendFrequency = null;
  company.dividendMetrics.source = 'BUSINESS_QUANT';
  company.dividendMetrics.frequencyLabel = null;
  company.dividendMetrics.frequency = 12;
  context.renderCompanyDetailData(company);
  assert.match(elements.detailDividendMetrics.innerHTML, /정기 배당 빈도<\/span><strong>미확보<\/strong>/);
});

test('Business Quant 상세 배당은 새 출처와 1·5·10년 성장률을 표시하고 SEC 이력을 다시 계산하지 않는다', () => {
  const elements = Object.fromEntries(['detailFinancialMetrics', 'detailDividendMetrics', 'detailFinancialSource', 'detailDividendSource']
    .map(id => [id, { innerHTML: '', textContent: '' }]));
  const context = {
    document: { getElementById: id => elements[id] },
    toNullableNumber: value => value == null ? null : Number(value),
    formatDividendAmount: value => value == null ? '데이터 없음' : `$${value}`,
    formatMetricValue: value => value == null ? '데이터 없음' : String(value),
    formatWeekdayCountdown: () => 'D-3',
    escapeHtml: value => String(value)
  };
  vm.createContext(context);
  vm.runInContext(appFunctionSource('renderCompanyDetailData', '\n/**\n * [서브메뉴 4-2]'), context);
  context.renderCompanyDetailData({ financials: [], dividendHistory: [
    { source: 'SEC EDGAR', periodType: 'annual', periodEnd: '2025-12-31', amount: 999 }
  ], dividendMetrics: {
    source: 'BUSINESS_QUANT', eventSource: 'BUSINESS_QUANT', eventCount: 120,
    frequency: 12, frequencySource: '배당락일 간격 추정', dividendGrowth1y: 2,
    dividendGrowthCagr5y: 3, dividendGrowthCagr10y: 4, skippedZeroCount: 1
  } });
  assert.match(elements.detailDividendMetrics.innerHTML, /1년 2\.00% · 5년 3\.00% · 10년 4\.00%/);
  assert.match(elements.detailDividendMetrics.innerHTML, /Massive 배당 종류 미확보/);
  assert.doesNotMatch(elements.detailDividendMetrics.innerHTML, /SEC 연간 주당배당금/);
  assert.match(elements.detailDividendSource.textContent, /Business Quant 120건/);
});

test('구형 Worker의 Massive 원본은 배당 종류에만 사용하고 BQ 배당 계산은 비워 둔다', () => {
  const elements = Object.fromEntries(['detailFinancialMetrics', 'detailDividendMetrics', 'detailFinancialSource', 'detailDividendSource']
    .map(id => [id, { innerHTML: '', textContent: '' }]));
  const context = {
    document: { getElementById: id => elements[id] },
    toNullableNumber: value => value == null ? null : Number(value),
    formatDividendAmount: value => value == null ? '데이터 없음' : `$${value}`,
    formatMetricValue: value => value == null ? '데이터 없음' : String(value),
    formatWeekdayCountdown: () => 'D-3', escapeHtml: value => String(value)
  };
  vm.createContext(context);
  vm.runInContext(appFunctionSource('renderCompanyDetailData', '\n/**\n * [서브메뉴 4-2]'), context);
  context.renderCompanyDetailData({ financials: [], dividends: [
    { source: 'MASSIVE', distributionType: 'special', frequency: 0,
      exDividendDate: '2026-09-01', paymentDate: '2026-09-15' },
    { source: 'MASSIVE', distributionType: 'recurring', frequency: 12,
      exDividendDate: '2026-08-31', paymentDate: '2026-09-14' },
    { source: 'MASSIVE', distributionType: 'irregular', frequency: 0,
      exDividendDate: '2099-10-15', paymentDate: '2099-11-01' }
  ], dividendMetrics: { source: 'SEC EDGAR', eventSource: 'MASSIVE', annualDividend: 99,
    dividendYield: 99, dividendGrowth1y: 99 } });
  const html = elements.detailDividendMetrics.innerHTML;
  assert.match(html, /정기 배당 빈도<\/span><strong>미확보<\/strong>/);
  assert.match(html, /마지막 배당 종류<\/span><strong>특별<\/strong>/);
  assert.match(html, /최근 실제 지급 1년 배당수익률<\/span><strong>미확보<\/strong>/);
  assert.match(html, /1년 미확보 · 5년 미확보 · 10년 미확보/);
});

test('새 저장 배당 요약은 종합 화면과 열린 상세 분석에 다시 전달한다', async () => {
  const stock = { ticker: 'O', marketData: { dividendMetrics: { dividendYield: 1 } } };
  const summary = { ticker: 'O', dividendMetrics: { dividendYield: 5.84 } };
  const detail = { ticker: 'O', dividendMetrics: { dividendYield: 5.84,
    nextDeclarationDate: '2026-09-25', dividendGrowth1y: 2.1 } };
  const rendered = [];
  const context = {
    state: { watchlist: [stock], selectedTicker: 'O' },
    fetchDashboardSummaryFromCloudflare: async () => ({ stocks: [summary] }),
    fetchCompanyFromCloudflare: async () => detail,
    applyStoredCompanyToStock: (target, company) => { target.marketData = company; },
    renderWatchlist: () => rendered.push('list'),
    renderCompanyOverview: () => rendered.push('overview'),
    renderPortfolio: () => rendered.push('portfolio'),
    isCompanyDetailOpen: () => true,
    renderCompanyDetailData: company => rendered.push(company.dividendMetrics.nextDeclarationDate)
  };
  vm.createContext(context);
  const functionStart = appSource.indexOf('async function refreshStoredDashboardViews(');
  const functionEnd = appSource.indexOf('\nfunction applyStoredCompanyToStock', functionStart);
  assert.ok(functionStart >= 0 && functionEnd > functionStart);
  vm.runInContext(appSource.slice(functionStart, functionEnd), context);
  await context.refreshStoredDashboardViews();
  assert.equal(stock.marketData.dividendMetrics.dividendYield, 5.84);
  assert.deepEqual(rendered, ['list', 'overview', 'portfolio', '2026-09-25']);
});
