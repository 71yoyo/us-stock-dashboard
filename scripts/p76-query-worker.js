import { querySpecializedMetrics } from '../worker/src/specialized-metric-query.js';

// 공개 route가 아닌 localhost workerd smoke harness다. 운영 binding/쓰기 API는 제공하지 않는다.
export default { async fetch(request, environment) {
  if (environment.DB || environment.P76_LOCAL_ONLY !== 'YES' || request.method !== 'POST'
    || new URL(request.url).pathname !== '/__p76_query_probe') return new Response('비공개 검증 경로만 허용합니다.', { status:403 });
  try {
    let reads = 0;
    const DB = { prepare(sql) {
      if (!/^SELECT\b/i.test(sql.trim())) throw new Error('읽기 검증에서 쓰기는 금지됩니다.');
      // localhost harness의 SQL service는 동일 fixture를 가진 Node SQLite에만 연결된다.
      // 실제 D1 원격 query는 별도 rehearsal에서 검증하며 이 bridge 결과를 D1 CPU로 해석하지 않는다.
      const make = params => ({ bind: (...values) => make(values), all: async () => {
        reads++;
        const response = await environment.SQL_READ_ONLY.fetch('http://local-sql/', {
          method:'POST',body:JSON.stringify({sql,params}) });
        if (!response.ok) throw new Error('local SQL bridge 오류');
        return response.json();
      } });
      return make([]);
    } };
    const data = await querySpecializedMetrics(DB, await request.json());
    return Response.json({data,sqlReads:reads,sqlWrites:0});
  } catch { return new Response('조회 조건/저장 데이터를 확인해 주세요.',{status:400}); }
} };
