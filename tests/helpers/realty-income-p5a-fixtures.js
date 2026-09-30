import { readFileSync } from 'node:fs';
import { parseRealtyIncomeDocument } from '../../worker/src/reit/realty-income-document-adapter.js';
import { validateAgainstOfficialExpected } from '../../worker/src/specialized-metrics.js';
import { fixtureHash } from './realty-income-fixtures.js';

export const p5aIds = ['2017-q1', '2018-q3', '2020-q3', '2022-q3', '2023-q3'];
export const readP5a = name => readFileSync(new URL(`../fixtures/realty-income-p5a/${name}`, import.meta.url), 'utf8');
export const p5aDocument = id => {
  if (!p5aIds.includes(id)) throw new Error('P5A는 다섯 대표 표본만 파싱합니다.');
  return JSON.parse(readP5a(`${id}.json`));
};
export const inventoryFixture = () => JSON.parse(readP5a('inventory.json'));

// 수동 전사한 배열의 단위/basis를 expected 계약으로 펼친다. parser 결과를 expected로 복사하지 않는다.
export function p5aExpected(id) {
  const text = readP5a('official-expected.json');
  const metrics = JSON.parse(text).samples[id];
  const [yearText, qText] = id.split('-q'), year = Number(yearText), quarter = Number(qText);
  const diluted = year !== 2017, normalized = year >= 2022;
  const versions = {
    FFO: year === 2017 ? 'FFO-REAL-ESTATE-V1' : 'FFO-DEPRECIABLE-V1',
    NORMALIZED_FFO: 'NFFO-MERGER-INTEGRATION-V1',
    AFFO: normalized ? 'AFFO-NFFO-INTEGRATION-V1' : year === 2017 ? 'AFFO-FFO-REAL-ESTATE-V1' : 'AFFO-FFO-DEPRECIABLE-V1'
  };
  const records = [];
  for (const [metric, scopes] of Object.entries(metrics)) for (const [scope, values] of Object.entries(scopes)) {
    for (const [index, value] of values.entries()) {
      if (value === null) continue;
      const perShare = index >= 2, shareBasis = ['not_applicable', 'diluted', 'basic', 'diluted'][index];
      const multiplier = perShare ? 1 : 1000;
      records.push({ ticker: 'O', metric_code: metric, definition_owner: 'CIK0000726728', definition_version: versions[metric],
        period_scope: scope, period_start: `${year}-${scope === 'ytd' || quarter === 1 ? '01' : '07'}-01`,
        period_end: `${year}-${quarter === 1 ? '03-31' : '09-30'}`, period_label: `Q${quarter} FY${year}${scope === 'ytd' ? ' YTD' : ''}`,
        fiscal_year: year, fiscal_period: `Q${quarter}`, value_basis: perShare ? 'per_share' : 'total', share_basis: shareBasis,
        attribution_basis: (index === 1 || index === 3 && diluted) ? 'common_and_dilutive_noncontrolling_interests' : 'common_stockholders',
        raw_value: value, raw_unit: perShare ? 'USD/share' : 'USD thousand', raw_unit_multiplier: multiplier,
        canonical_value: value * multiplier, canonical_unit: perShare ? 'USD/share' : 'USD' });
    }
  }
  return { fixture: { records }, hash: fixtureHash(text) };
}

export async function p5aResults() {
  return Promise.all(p5aIds.map(async id => {
    const result = await parseRealtyIncomeDocument(p5aDocument(id));
    if (result.status !== 'parsed') throw new Error(JSON.stringify(result.errors));
    const { fixture, hash } = p5aExpected(id);
    return { ...result, records: validateAgainstOfficialExpected(result.records, fixture, hash) };
  }));
}
