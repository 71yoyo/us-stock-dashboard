import assert from 'node:assert/strict';
import { Miniflare,convertV4MiniflareOptions } from 'miniflare';
import { readFileSync,mkdirSync,writeFileSync,existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { saveSpecializedMetrics } from '../worker/src/specialized-metric-store.js';
import { readApprovedArtifact } from './p75-artifact-check.mjs';
import { querySpecializedMetrics } from '../worker/src/specialized-metric-query.js';
import { createHistoricalDatabase } from './specialized-disposable-db.mjs';

async function inspector() {
  const targets=await (await fetch('http://127.0.0.1:9336/json/list')).json();
  // entry/proxy worker가 아니라 실제 query isolate를 선택한다. 다른 target의 CPU를 query 값으로 오인하지 않는다.
  const target=targets.find(row=>row.webSocketDebuggerUrl && String(row.title||row.id).includes('p76-local-query-only'));
  assert.ok(target,'local query isolate inspector 미확보');
  const socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((done,reject)=>{socket.addEventListener('open',done,{once:true});socket.addEventListener('error',reject,{once:true});});
  let id=0;const waiting=new Map();socket.addEventListener('message',event=>{const row=JSON.parse(event.data);if(!row.id)return;
    const entry=waiting.get(row.id);waiting.delete(row.id);if(row.error)entry.reject(new Error('inspector 요청 실패'));else entry.done(row.result);});
  return {send(method,params={}) {return new Promise((done,reject)=>{const next=++id;waiting.set(next,{done,reject});socket.send(JSON.stringify({id:next,method,params}));});},close:()=>socket.close()};
}
export async function queryPreview() {
  const database=await createHistoricalDatabase();const {sqlite,DB}=database;
  for(const document of readApprovedArtifact().documents) await saveSpecializedMetrics(DB,{...document,status:'parsed'});
  const mf=new Miniflare(convertV4MiniflareOptions({name:'p76-local-query-only',modulesRoot:resolve('.'),modules:
    ['scripts/p76-query-worker.js','worker/src/specialized-metric-query.js','worker/src/specialized-metrics.js']
      .map(path=>({type:'ESModule',path:resolve(path),contents:readFileSync(path,'utf8')})),
    compatibilityDate:'2026-09-21',bindings:{P76_LOCAL_ONLY:'YES'},serviceBindings:{SQL_READ_ONLY:async request=>{
      const {sql,params}=await request.json();if(!/^SELECT\b/i.test(sql.trim()))return new Response('write forbidden',{status:403});
      return Response.json({results:sqlite.prepare(sql).all(...params)});
    }},host:'127.0.0.1',port:0,inspectorPort:9336}));
  let debug;
  try {
    console.log('P7.6 local workerd 시작');
    await mf.ready;
    const results=[];
    try {debug=await inspector();await debug.send('Profiler.enable');await debug.send('Profiler.setSamplingInterval',{interval:100});}
    catch {console.log('local inspector 미확보: CPU를 측정값으로 보고하지 않습니다.');}
    for(const scope of ['quarterly','annual','ytd']) for(const metric of ['FFO','AFFO','NORMALIZED_FFO']) {
      const input={ticker:'O',metricCode:metric,periodScope:scope,valueBasis:'per_share',shareBasis:'diluted'};
      const probe=()=>mf.dispatchFetch('http://localhost/__p76_query_probe',{method:'POST',body:JSON.stringify(input)});
      await probe();if(debug)await debug.send('Profiler.start');const start=performance.now();
      const repeats=10;let sample;
      for(let index=0;index<repeats;index++){const response=await probe();assert.equal(response.status,200);sample=await response.json();}
      const wallMs=(performance.now()-start)/repeats;let activeUs=null;
      if(debug){const {profile}=await debug.send('Profiler.stop');const nodes=new Map(profile.nodes.map(row=>[row.id,row.callFrame.functionName]));
        activeUs=0;for(let index=0;index<(profile.samples||[]).length;index++) if(!['(idle)','(program)'].includes(nodes.get(profile.samples[index]))) activeUs+=profile.timeDeltas[index]||0;}
      assert.deepEqual(sample.data,await querySpecializedMetrics(DB,input));assert.equal(sample.sqlReads,2);assert.equal(sample.sqlWrites,0);
      results.push({scope,metric,count:sample.data.data.length,sqlReads:sample.sqlReads,sqlWrites:0,wallMs,
        localProfileActiveEstimateMs:activeUs===null?null:activeUs/1000/repeats,productionBillingCpuMs:null});
      console.log(`P7.6 local ${scope}/${metric} PASS`);
    }
    assert.equal((await mf.dispatchFetch('http://localhost/api/specialized')).status,403);
    const result={runtime:'local workerd / Miniflare, Node SQLite read-only bridge',requests:90,results,remoteCpuMeasured:false,
      productionRouteOpened:false,publicRoute:false,interpretation:'local sampling estimate는 production 10ms CPU 통과 증거가 아닙니다.'};
    mkdirSync('backups/p76',{recursive:true});
    if(existsSync('backups/p76/query-preview.json')&&!existsSync('backups/p76/query-preview-before.json'))
      writeFileSync('backups/p76/query-preview-before.json',readFileSync('backups/p76/query-preview.json'));
    writeFileSync('backups/p76/query-preview.json',JSON.stringify(result,null,2));return result;
  } finally {debug?.close();await mf.dispose();sqlite.close();}
}
if(process.argv[1]===resolve('scripts/p76-query-preview.mjs')) console.log(JSON.stringify(await queryPreview(),null,2));
