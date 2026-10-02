import { readFileSync } from 'node:fs';
import { STANDARD_RAW_METRICS } from '../../worker/src/sec-standard-raw.js';

export const oR2 = JSON.parse(readFileSync(new URL('../fixtures/sec-standard-raw-o-r2.json', import.meta.url), 'utf8'));
export const companies = JSON.parse(readFileSync(new URL('../fixtures/company-classification-metadata.json', import.meta.url), 'utf8')).companies;

export function addFact(facts, tag, entry, unit = 'USD', taxonomy = 'us-gaap') {
  const namespace = facts[taxonomy] ||= {};
  const fact = namespace[tag] ||= { units: {} };
  (fact.units[unit] ||= []).push(entry);
  return facts;
}

export function secFact(start = '2025-01-01', end = '2025-12-31', val = 100, extra = {}) {
  return { ...(start ? { start } : {}), end, val, form: '10-K', fp: 'FY', fy: 2025,
    filed: '2026-02-25', accn: 'synthetic-fy', ...extra };
}

export function oR2Facts() {
  const facts = {};
  for (const period of [oR2.annual, oR2.ytd]) {
    const { values, ...context } = period;
    for (const [tag, val] of Object.entries(values)) {
      const definition = Object.values(STANDARD_RAW_METRICS).find(item => item.tags.includes(tag));
      const entry = { ...context, val };
      if (definition?.kind === 'point_in_time') delete entry.start;
      addFact(facts, tag, entry, definition?.unit || 'USD');
    }
  }
  return facts;
}

/** 합성 10년/40분기 자료다. 실제 10종목의 SEC 수치·coverage라고 표시하지 않는다. */
export function syntheticCompanyFacts({ missingMetrics = [], negative = false } = {}) {
  const facts = {}, missing = new Set(missingMetrics);
  const addPeriod = (year, quarter) => {
    const end = `${year}-${quarter ? ['03-31','06-30','09-30','12-31'][quarter - 1] : '12-31'}`;
    const start = `${year}-${quarter ? ['01-01','04-01','07-01','10-01'][quarter - 1] : '01-01'}`;
    const annual = !quarter;
    const filingQuarter = quarter === 4 || annual ? 'FY' : `Q${quarter}`;
    const extra = { form: filingQuarter === 'FY' ? '10-K' : '10-Q', fp: filingQuarter, fy: year,
      filed: nextFilingDate(year, quarter), accn: `synthetic-${year}-${filingQuarter}` };
    const core = annual ? 4000 : 1000;
    for (const [tag, value, unit] of [['Revenues',core,'USD'],['NetIncomeLoss',core / 10,'USD'],
      ['OperatingIncomeLoss',core / 5,'USD'],['GrossProfit',core / 2,'USD'],
      ['NetCashProvidedByUsedInOperatingActivities',core / 3,'USD'],
      ['PaymentsToAcquirePropertyPlantAndEquipment',core / 6,'USD'],['EarningsPerShareDiluted',1.25,'USD/shares']]) {
      addFact(facts, tag, secFact(start, end, value, extra), unit);
    }
    for (const [index, [name, definition]] of Object.entries(STANDARD_RAW_METRICS).entries()) {
      if (missing.has(name) || !definition.tags.length) continue;
      const point = definition.kind === 'point_in_time';
      if (point && annual) continue; // Q4와 같은 시점을 중복 생성하지 않고 단일 연도 말 fact를 사용한다.
      const value = definition.unit === 'shares' ? 1000000 + index * 10000
        : negative && name === 'consolidated_net_income' ? -core : core * (index + 1);
      addFact(facts, definition.tags[0], secFact(point ? null : start, end, value, extra), definition.unit);
    }
  };
  for (let year = 2016; year <= 2025; year++) {
    addPeriod(year, null);
    for (let quarter = 1; quarter <= 4; quarter++) addPeriod(year, quarter);
  }
  return facts;
}

function nextFilingDate(year, quarter) {
  if (!quarter || quarter === 4) return `${year + 1}-02-25`;
  return `${year}-${['05-05','08-05','11-05'][quarter - 1]}`;
}
