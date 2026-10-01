import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createMetricTestDatabase, protectedDigest } from '../tests/helpers/specialized-metrics-db.js';
import { classificationStatement, classifyCompany } from '../worker/src/company-classification.js';

// 로컬 검증 전용이다. 기존 D1/파일 DB/환경설정을 받지 않으며 항상 독립 메모리 SQLite를 생성한다.
export async function createHistoricalDatabase() {
  const database = createMetricTestDatabase();
  const { sqlite, DB } = database;
  try {
    const company = { ticker: 'O', name: 'Realty Income Corporation — DISPOSABLE TEST ONLY',
      cik: '0000726728', sector: 'Real Estate', industry: 'REIT - Retail' };
    sqlite.prepare('INSERT INTO companies(ticker,name,cik,sector,industry) VALUES (?,?,?,?,?)')
      .run(company.ticker, company.name, company.cik, company.sector, company.industry);
    await classificationStatement(DB, company).run();
    const columns = sqlite.prepare('PRAGMA table_info(financial_metrics)').all()
      .filter(column => /REAL|INTEGER/i.test(column.type)).map(column => column.name);
    // 기존 재무값 보호 확인용 NULL/0/음수 sentinel이며 실제 회사 재무정보가 아니다.
    const values = columns.map((column, index) => column === 'fiscal_year' ? 2025
      : column === 'metadata_version' ? 1 : [null, 0, -12.5, 987654][index % 4]);
    sqlite.prepare(`INSERT INTO financial_metrics(ticker,period_type,fiscal_period_end,source,${columns.join(',')})
      VALUES (?,?,?,?,${values.map(() => '?').join(',')})`).run(company.ticker, 'annual', '2025-12-31', 'DISPOSABLE_SENTINEL', ...values);
    const migrations = readdirSync(new URL('../worker/migrations/', import.meta.url)).filter(name => name.endsWith('.sql')).sort();
    return { ...database, disposable: true, path: ':memory:', profile: classifyCompany(company),
      migrationNames: migrations, migrationHash: hash(migrations.map(name => [name,
        readFileSync(new URL(`../worker/migrations/${name}`, import.meta.url), 'utf8')])), protectedBefore: protectedDigest(sqlite) };
  } catch (error) { sqlite.close(); throw error; }
}

export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const volatileKeys = new Set(['retrieved_at', 'updated_at', 'created_at']);

// 열·JSON 키 순서와 조회 시각 차이를 정규화한다. source hash/정의/값/검증상태/페이지/section은 digest에 남긴다.
export function stableData(value) {
  if (Array.isArray(value)) return value.map(stableData);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).filter(key => !volatileKeys.has(key)).sort()
    .map(key => [key, stableData(value[key])]));
}

export function specializedSnapshot(sqlite) {
  const definitions = sqlite.prepare('SELECT * FROM company_metric_definitions ORDER BY metric_code,definition_owner,definition_version').all();
  const values = sqlite.prepare('SELECT * FROM company_metric_values ORDER BY record_key').all()
    .map(row => ({ ...row, validation_json: JSON.parse(row.validation_json) }));
  const sources = sqlite.prepare('SELECT * FROM company_metric_sources ORDER BY record_key,source_url,source_hash').all()
    .map(row => ({ ...row, source_metadata_json: JSON.parse(row.source_metadata_json) }));
  const digests = { definitions: hash(stableData(definitions)), values: hash(stableData(values)),
    provenance: hash(stableData(sources)) };
  return { counts: { definitions: definitions.length, values: values.length, provenance: sources.length },
    digests, digest: hash(digests) };
}

export function specializedStatistics(sqlite) {
  const group = columns => sqlite.prepare(`SELECT ${columns},COUNT(*) count FROM company_metric_values
    GROUP BY ${columns} ORDER BY ${columns}`).all();
  return { ...specializedSnapshot(sqlite), validationStatuses: group('validation_status'),
    metrics: group('metric_code'), scopes: group('period_scope'), metricScopes: group('metric_code,period_scope'),
    units: group('value_basis,share_basis,canonical_unit') };
}

export function logicalDuplicates(sqlite) {
  const count = (table, columns) => sqlite.prepare(`SELECT COUNT(*) count FROM
    (SELECT 1 FROM ${table} GROUP BY ${columns} HAVING COUNT(*)>1)`).get().count;
  return { value: count('company_metric_values', 'ticker,metric_code,definition_owner,definition_version,period_scope,period_start,period_end,value_basis,share_basis,attribution_basis'),
    provenance: count('company_metric_sources', 'record_key,source_url,source_hash'),
    definition: count('company_metric_definitions', 'metric_code,definition_owner,definition_version') };
}
