import { detectDocumentFormat, FORMATS } from './realty-income-document-formats.js';
import { parseRealtyIncomePdfText } from './realty-income-pdf-parser.js';
import { parseRealtyIncomeHtml } from './realty-income-parser.js';

// offline 검증 전용 진입점이다. 수집 큐/Worker 라우트/운영 DB에 연결하지 않는다.
export async function parseRealtyIncomeDocument(document) {
  const detection = await detectDocumentFormat(document);
  if (detection.status !== 'detected') return detection;
  // P3 결과/문서 기반 정의 버전을 그대로 보존한다. 현대 파서를 재작성하지 않는다.
  if (detection.format === FORMATS.modern) return parseRealtyIncomeHtml(document);
  return parseRealtyIncomePdfText(document, detection);
}
