import test from 'node:test';
import assert from 'node:assert/strict';
import { productionFixture } from './helpers/sec-raw-production-fixtures.js';
import { makeAutomationPolicy,fixtureRelease,fixtureTarget,fixtureTime } from './helpers/sec-raw-automation-fixtures.js';
import { readSyntheticIdentityFixtures,identityMessages,cacheProducerFixture } from './helpers/sec-raw-identity-fixtures.js';
import { createProductionD1Adapter,assertProducerReadSql } from '../scripts/sec-raw-production-d1.mjs';
import { createDisconnectEvidenceVerifier,producerSecretNames,producerVariableNames } from '../scripts/sec-raw-production-runner.mjs';
import { createStateProvisioningHelper,runSyntheticStateCasContract } from '../scripts/sec-raw-state-provisioning.mjs';
import { createGithubJournalBackend } from '../scripts/sec-raw-github-journal.mjs';
import { createProducerJournal } from '../scripts/sec-raw-producer-journal.mjs';

test('R10C-3A 기본 detect-only: fake SEC read만, GitHub write/Queue 0',async()=>{
  const f=productionFixture(),result=await f.run();assert.equal(result.mode,'detect-only');assert.equal(result.detected,1);
  assert.equal(result.publishCount,0);assert.equal(f.queueCalls,0);assert.equal(f.files.size,0);
  assert.ok(f.requests.filter(r=>r.host==='api.github.com').every(r=>r.method==='GET'));
});
test('R10C-3A explicit enqueue: single contract + durable INTENT, accepted suppress',async()=>{
  const f=productionFixture();const first=await f.run({args:['--enqueue']});assert.equal(first.accepted,1);assert.equal(f.queueCalls,1);
  const second=await f.run({args:['--enqueue']});assert.equal(second.publishCount,0);assert.equal(f.queueCalls,1);
  assert.ok(!JSON.stringify(f.files.get('state/journal.json')).includes('messageId'));
});
test('R10C-3A ambiguous POST 후 즉시/다음 run republish 0',async()=>{
  const f=productionFixture({queueResponse:()=>{throw Error('synthetic-reset-secret');}});
  assert.equal((await f.run({args:['--enqueue']})).ambiguous,1);
  assert.equal((await f.run({args:['--enqueue']})).publishCount,0);assert.equal(f.queueCalls,1);
});
test('R10C-3A pending review 정확한 CP/runtime evidence가 COMPLETED 대신 REVIEW_BLOCKED',async()=>{
  const f=productionFixture();await f.run({args:['--enqueue']});const entry=Object.values(f.files.get('state/journal.json').data.entries)[0];
  f.states.get('O').checkpoint={accession:entry.accession,sourceIdentity:entry.sourceIdentity,schemaVersion:1};
  f.states.get('O').runtime={raw_status:'pending',attempt_accession:entry.accession,raw_schema_version:1,raw_data_version:2};
  const result=await f.run({args:['--enqueue']});assert.equal(result.reviewBlocked,1);assert.equal(result.publishCount,0);
  assert.equal(Object.values(f.files.get('state/journal.json').data.entries)[0].state,'REVIEW_BLOCKED');
});
test('R10C-3A D1 mismatch는 SEC/Queue/GitHub 접근·mutation 전에 STOP',async()=>{
  const f=productionFixture({databaseId:'00000000-0000-0000-0000-000000000000'});
  await assert.rejects(f.run({args:['--enqueue']}),{code:'TARGET_MISMATCH'});
  assert.equal(f.requests.length,1);assert.equal(f.files.size,0);
});
for (const [label,options] of [['repo mismatch',{repository:'synthetic-owner/wrong'}],['public',{privateRepo:false}],
  ['default branch',{defaultBranch:'producer-state'}],['disconnected false',{disconnected:false}]]) {
  test(`R10C-3A GitHub ${label} → Queue/SEC/write 0`,async()=>{
    const f=productionFixture(options);await assert.rejects(f.run({args:['--enqueue']}),{code:'POLICY_INVALID'});
    assert.equal(f.queueCalls,0);assert.equal(f.files.size,0);assert.ok(!f.requests.some(r=>r.host==='data.sec.gov'));
  });
}
for (const key of [...producerSecretNames,...producerVariableNames]) test(`R10C-3A env ${key} 없으면 network 전 STOP`,async()=>{
  const f=productionFixture();delete f.env[key];
  await assert.rejects(f.run(),{code:'POLICY_INVALID'});assert.equal(f.requests.length,0);
});
test('R10C-3A 분리 token, fallback/OAuth/Observability 금지',async()=>{
  const f=productionFixture();f.env.CF_QUEUE_API_TOKEN=f.env.CF_D1_READ_API_TOKEN;
  await assert.rejects(f.run(),{code:'POLICY_INVALID'});assert.equal(f.requests.length,0);
  const g=productionFixture();delete g.env.PRODUCER_STATE_TOKEN;g.env.GITHUB_TOKEN='synthetic-backup';
  g.env.CLOUDFLARE_API_TOKEN='synthetic-oauth';g.env.CLOUDFLARE_OBSERVABILITY_API_TOKEN='synthetic-observe';
  await assert.rejects(g.run(),{code:'POLICY_INVALID'});assert.equal(g.requests.length,0);
});
for (const [label,changes,code] of [
  ['release',{release:'f'.repeat(40)},'RELEASE_MISMATCH'],['target',{target:{...fixtureTarget,queueName:'synthetic-other'}},'TARGET_MISMATCH'],
  ['expired',{expiresAt:new Date(fixtureTime-1).toISOString()},'POLICY_TIME'],
  ['future',{validFrom:new Date(fixtureTime+1).toISOString()},'POLICY_TIME'],
  ['identity',{identityAlgorithmVersion:1},'POLICY_INVALID'],['schema',{schemaVersion:2},'POLICY_INVALID'],
  ['LMT',{scope:[{ticker:'LMT',cik:'1'}]},'SCOPE_MISMATCH']]) test(`R10C-3A policy ${label} fail closed`,async()=>{
    const f=productionFixture({policy:makeAutomationPolicy({secFetchEnabled:true,...changes})});
    await assert.rejects(f.run(),{code});assert.equal(f.requests.length,0);
  });
test('R10C-3A policy loader 실패/placeholder/unknown flag/승인 없는 enqueue 모두 network 0',async()=>{
  const f=productionFixture();await assert.rejects(f.run({loadPolicy:()=>{throw Error('synthetic-private-marker');}}),{code:'POLICY_INVALID'});
  await assert.rejects(f.run({args:['--detect-only','--enqueue']}),{code:'POLICY_INVALID'});
  await assert.rejects(f.run({loadPolicy:()=>({placeholder:true})}),{code:'POLICY_INVALID'});
  const g=productionFixture({policyChanges:{productionEnqueueEnabled:false}});
  await assert.rejects(g.run({args:['--enqueue']}),{code:'POLICY_INVALID'});
  assert.equal(f.requests.length+g.requests.length,0);
});
test('R10C-3A preissued disconnect evidence는 exact target/release/time/연결 0 필요',async()=>{
  const f=productionFixture(),target={repository:f.env.PRODUCER_STATE_REPOSITORY,stateBranch:'producer-state',statePath:'state/journal.json'};
  const evidence={version:1,release:fixtureRelease,...target,validFrom:new Date(fixtureTime-1).toISOString(),
    expiresAt:new Date(fixtureTime+1000).toISOString(),workflows:0,webhooks:0,deployments:0,cloudflareConnections:0};
  assert.equal(await createDisconnectEvidenceVerifier({evidence,release:fixtureRelease,now:f.now})(target),true);
  for (const changes of [{workflows:1},{release:'f'.repeat(40)},{statePath:'state/other.json'},{expiresAt:new Date(fixtureTime).toISOString()}]) {
    assert.equal(await createDisconnectEvidenceVerifier({evidence:{...evidence,...changes},release:fixtureRelease,now:f.now})(target),false);
  }
});
test('R10C-3A synthetic 10종목 unchanged + legacy compat: Queue/state write 0',async context=>{
  // 합성 공시의 보존 창은 CI 실행 연도와 무관해야 한다.
  context.mock.timers.enable({apis:['Date'],now:new Date('2026-10-06T00:00:00Z')});
  const items=readSyntheticIdentityFixtures();const policy=makeAutomationPolicy({secFetchEnabled:true,scope:items.map(({ticker,cik})=>({ticker,cik}))});
  const f=productionFixture({policy});
  for (const item of items) {
    const {legacy,canonicalMessage}=await identityMessages(item),base=await cacheProducerFixture(item,null);
    f.sources.set(item.ticker,base.sources.get(item.ticker));f.states.set(item.ticker,base.states.get(item.ticker));
    const cp=item.ticker==='SYN2'?legacy:canonicalMessage;
    f.states.get(item.ticker).checkpoint={accession:cp.accession,sourceIdentity:cp.sourceIdentity,schemaVersion:1};
    Object.assign(f.readiness.find(row=>row.ticker===item.ticker),base.readiness[0]);
  }
  const result=await f.run();assert.equal(result.unchanged,10);assert.equal(result.unchangedCompat,1);
  assert.equal(result.failed,0);assert.equal(result.publishCount,0);assert.equal(f.files.size,0);
});
test('R10C-3A 100 ticker: run readiness 1 / indexed SQL 300 / journal GET constant / unchanged publish 0',async()=>{
  const scope=Array.from({length:100},(_,i)=>({ticker:`S${i}`,cik:String(700000+i)}));
  const f=productionFixture({policy:makeAutomationPolicy({scope,secFetchEnabled:true})});
  for (const {ticker} of scope) {const msg=await f.message(ticker);f.states.get(ticker).checkpoint={accession:msg.accession,sourceIdentity:msg.sourceIdentity,schemaVersion:1};}
  const result=await f.run();assert.equal(result.unchanged,100);assert.equal(result.failed,0);
  assert.equal(f.requests.filter(r=>r.path.endsWith('/query')).length,301);
  assert.equal(f.requests.filter(r=>r.host==='api.github.com').length,3);assert.equal(f.queueCalls,0);
});
test('R10C-3A secret/provider/raw leakage 0: summary는 fixed counters/category만',async()=>{
  const f=productionFixture({queueResponse:()=>Response.json({success:false,error:'synthetic-private-response-marker'})});
  const result=JSON.stringify(await f.run({args:['--enqueue']}));
  for (const marker of [...producerSecretNames.map(key=>f.env[key]),'Authorization','companyFacts','facts','synthetic-private-response-marker','messageId']) {
    assert.equal(result.includes(marker),false);
  }
  await assert.rejects(f.run({verifyDisconnected:async()=>{throw Error('synthetic-private-response-marker');}}),
    error=>error.code==='INTERNAL_SAFE'&&!error.stack.includes('synthetic-private-response-marker'));
});
for (const sql of ['INSERT INTO companies VALUES (?)','UPDATE companies SET cik=?','DELETE FROM companies','REPLACE INTO companies VALUES (?)',
  'CREATE TABLE x(a)','ALTER TABLE companies ADD x','DROP TABLE companies','PRAGMA user_version=1','SELECT 1; DELETE FROM companies',
  'SELECT 1 -- test','SELECT load_extension(?)','SELECT * FROM sec_standard_raw_metrics','SELECT * FROM companies']) {
  test(`R10C-3A unsafe SQL 거부: ${sql.split(' ')[0]} ${sql.length}`,()=>assert.throws(()=>assertProducerReadSql(sql),{code:'D1_READ'}));
}
test('R10C-3A D1 reader SELECT-only budget/metadata identity/no run/batch',async()=>{
  const f=productionFixture(),db=createProductionD1Adapter({fetchImpl:f.fetchImpl,credential:f.env.CF_D1_READ_API_TOKEN,target:fixtureTarget,maxQueries:1});
  assert.equal((await db.identity()).accountId,fixtureTarget.accountId);
  assert.deepEqual((await db.prepare('SELECT ticker FROM companies WHERE ticker=?').bind('O').all()).results,[]);
  await assert.rejects(db.prepare('SELECT ticker FROM companies WHERE ticker=?').bind('O').all(),{code:'D1_READ'});
  assert.equal(db.batch,undefined);assert.equal(db.prepare('SELECT 1').run,undefined);assert.equal(db.stats().queries,2);
});
test('R10C-3A provisioning bootstrap는 empty default/state branch + state 초기화, 재실행 overwrite 0',async()=>{
  const f=productionFixture({emptyRepo:true});
  const helper=createStateProvisioningHelper({fetchImpl:f.fetchImpl,credential:f.env.PRODUCER_STATE_TOKEN,
    repository:f.env.PRODUCER_STATE_REPOSITORY,verifyDisconnected:f.verifier});
  assert.equal((await helper.bootstrap()).createdState,true);assert.equal(f.branches.has('main'),true);assert.equal(f.branches.has('producer-state'),true);
  const first=f.files.get('state/journal.json').sha;assert.equal((await helper.bootstrap()).createdState,false);
  assert.equal(f.files.get('state/journal.json').sha,first);
  await assert.rejects(helper.cleanupSynthetic('state/journal.json'),{code:'POLICY_INVALID'});
});
test('R10C-3A scoped synthetic CAS/read-after-conflict/current SHA/cleanup residue 0',async()=>{
  const f=productionFixture();const result=await runSyntheticStateCasContract({fetchImpl:f.fetchImpl,credential:f.env.PRODUCER_STATE_TOKEN,
    repository:f.env.PRODUCER_STATE_REPOSITORY,verifyDisconnected:f.verifier,now:f.now});
  assert.equal(result.status,'PASS');assert.equal(result.residue,0);assert.equal(f.files.size,0);
});
for (const status of [409,422]) test(`R10C-3A GitHub ${status} CAS bounded 3 + safe STOP`,async()=>{
  const f=productionFixture({conflict:true,conflictStatus:status});
  const backend=createGithubJournalBackend({fetchImpl:f.fetchImpl,credential:f.env.PRODUCER_STATE_TOKEN,
    repository:f.env.PRODUCER_STATE_REPOSITORY,verifyDisconnected:f.verifier});
  await assert.rejects(createProducerJournal(backend).acquire({runId:'run',owner:'owner',target:fixtureTarget}),{code:'JOURNAL_CAS'});
  assert.equal(f.requests.filter(r=>r.method==='PUT').length,3);
});
test('R10C-3A journal INTENT/lock write ambiguity: no Queue / retry 0',async()=>{
  const f=productionFixture({failGithubWrite:true});const result=await f.run({args:['--enqueue']});
  assert.equal(result.stopped,true);assert.equal(f.queueCalls,0);assert.equal(f.requests.filter(r=>r.method==='PUT').length,1);
});
test('R10C-3A 100 ticker enqueue 예산은 1건만 허용, 추가 INTENT 없음',async()=>{
  const scope=Array.from({length:100},(_,i)=>({ticker:`S${i}`,cik:String(700000+i)}));
  const f=productionFixture({policy:makeAutomationPolicy({scope,secFetchEnabled:true,maxPublishesPerRun:1,maxPublishesPerDay:1})});
  const result=await f.run({args:['--enqueue']});assert.equal(result.accepted,1);assert.equal(result.budgetSkipped,99);
  assert.equal(f.queueCalls,1);assert.equal(Object.keys(f.files.get('state/journal.json').data.entries).length,1);
});
test('R10C-3A global fetch budget: 다음 ticker SEC 호출 전에 STOP',async()=>{
  const f=productionFixture({policyChanges:{scope:[{ticker:'O',cik:'726728'},{ticker:'MSFT',cik:'789019'}],maxFetchAttempts:2,maxProviderRequests:2}});
  const result=await f.run();assert.equal(result.stopped,true);assert.ok(result.errorCategories.includes('FETCH_BUDGET'));
  assert.equal(f.requests.filter(r=>r.host==='data.sec.gov').length,2);assert.equal(f.files.size,0);
});
test('R10C-3A detect-only는 기존 ACCEPTED reconcile도 remote 쓰기 0',async()=>{
  const f=productionFixture();await f.run({args:['--enqueue']});const old=structuredClone(f.files.get('state/journal.json'));
  const entry=Object.values(old.data.entries)[0];f.states.get('O').checkpoint={accession:entry.accession,sourceIdentity:entry.sourceIdentity,schemaVersion:1};
  const count=f.requests.filter(r=>r.method==='PUT').length;
  assert.equal((await f.run()).publishCount,0);assert.equal(f.requests.filter(r=>r.method==='PUT').length,count);
  assert.deepEqual(f.files.get('state/journal.json'),old);
});
test('R10C-3A GitHub lock conflict는 Queue/SEC 전에 중단, 자동 탈취 없음',async()=>{
  const f=productionFixture();await f.run({args:['--enqueue']});
  f.files.get('state/journal.json').data.lock={runId:'other',owner:'other',expiresAt:new Date(fixtureTime+3600000).toISOString()};
  const sec=f.requests.filter(r=>r.host==='data.sec.gov').length;
  const result=await f.run({args:['--enqueue']});assert.ok(result.errorCategories.includes('LOCK_BUSY'));
  assert.equal(result.publishCount,0);assert.equal(f.requests.filter(r=>r.host==='data.sec.gov').length,sec);
  assert.equal(f.files.get('state/journal.json').data.lock.owner,'other');
});
test('R10C-3A cleanup은 synthetic path에 실제 ticker가 섞여도 삭제 불가',async()=>{
  const f=productionFixture();await f.run({args:['--enqueue']});
  f.files.set('state/synthetic-blocked.json',structuredClone(f.files.get('state/journal.json')));
  const helper=createStateProvisioningHelper({fetchImpl:f.fetchImpl,credential:f.env.PRODUCER_STATE_TOKEN,
    repository:f.env.PRODUCER_STATE_REPOSITORY,verifyDisconnected:f.verifier});
  await assert.rejects(helper.cleanupSynthetic('state/synthetic-blocked.json'),{code:'STATE_INVALID'});
  assert.ok(f.requests.every(r=>r.method!=='DELETE'));
});
for (const response of [()=>new Response('synthetic-private',{status:403}),()=>Response.json({success:true,result:[{success:true,results:[],meta:{rows_written:1}}]}),
  ()=>new Response('synthetic-private-malformed')]) test('R10C-3A D1 실패/불법 write meta/손상 응답은 sanitized, retry 0',async()=>{
    let calls=0;const db=createProductionD1Adapter({credential:'synthetic-d1',target:fixtureTarget,fetchImpl:async(_url,request)=>{
      calls++;return request.method==='GET'?Response.json({success:true,result:{uuid:fixtureTarget.databaseId,name:fixtureTarget.databaseName}}):response();
    }});
    await assert.rejects(db.prepare('SELECT 1').all(),error=>error.code==='D1_READ'&&!error.stack.includes('synthetic-private'));
    assert.equal(calls,2);
  });

/** 초기 409와 독립 evidence를 조합하는 메모리 fake다. 실제 API/credential 파일은 사용하지 않는다. */
function emptyConflictFixture(options={}) {
  const f=productionFixture({emptyRepo:options.emptyRepo!==false,...options.fixture}),trace=[];
  const root='/repos/synthetic-owner/synthetic-state';
  let initialLookups=0;
  const fetchImpl=async(input,request)=>{
    const url=new URL(input),path=url.pathname.slice(root.length),method=request.method;
    assert.equal(url.host,'api.github.com');assert.ok(url.pathname.startsWith(root));
    assert.equal(request.headers.Authorization,`Bearer ${f.env.PRODUCER_STATE_TOKEN}`);
    assert.equal(request.redirect,'error');assert.ok(request.signal instanceof AbortSignal);
    trace.push({path,query:url.search,method,body:request.body?JSON.parse(request.body):undefined});
    if (path==='/git/ref/heads/main' && !f.branches.has('main')) {
      initialLookups++;
      if (options.networkFailure) throw Error('synthetic-private-response-marker');
      return options.initialResponse?options.initialResponse():Response.json({message:'Git Repository is empty.',status:'409'},{status:409});
    }
    if (path==='/git/ref/heads/main' && options.afterReadmeStatus && f.files.has('README.md')) {
      return Response.json({message:'Git Repository is empty.'},{status:options.afterReadmeStatus});
    }
    if (path==='/branches') {
      assert.equal(url.search,'?per_page=100');
      if (options.inventoryFailure) throw Error('synthetic-private-response-marker');
      return options.inventoryResponse?options.inventoryResponse():Response.json([...f.branches].map(name=>({name})));
    }
    if (path==='/branches/producer-state' && options.stateResponse) return options.stateResponse();
    if (path==='/contents/state/journal.json' && method==='GET' && options.pathResponse) return options.pathResponse();
    if (path==='/contents/state/journal.json' && method==='PUT' && options.journalConflict) {
      return Response.json({message:'Git Repository is empty.'},{status:options.journalConflict});
    }
    return f.fetchImpl(input,request);
  };
  const helper=createStateProvisioningHelper({fetchImpl,credential:f.env.PRODUCER_STATE_TOKEN,
    repository:f.env.PRODUCER_STATE_REPOSITORY,verifyDisconnected:f.verifier});
  return {...f,helper,fetchImpl,trace,get initialLookups(){return initialLookups;}};
}

test('R10C-3B-FIX strict empty 409: 최소 README/SHA/state/journal 순서와 재실행 overwrite 0',async()=>{
  const f=emptyConflictFixture();
  assert.deepEqual(await f.helper.bootstrap(),{status:'READY',createdState:true});
  assert.equal(f.initialLookups,1);
  assert.deepEqual(f.trace.filter(row=>row.method!=='GET').map(({method,path})=>({method,path})),[
    {method:'PUT',path:'/contents/README.md'},{method:'POST',path:'/git/refs'},{method:'PUT',path:'/contents/state/journal.json'}]);
  const initial=f.trace.findIndex(row=>row.path==='/contents/README.md');
  assert.deepEqual(f.trace.slice(0,initial).map(row=>row.path),[
    '','/git/ref/heads/main','/branches','/branches/producer-state','/contents/state/journal.json']);
  assert.equal(f.trace[initial-1].query,'?ref=producer-state');
  assert.equal(f.trace[initial+1].path,'/git/ref/heads/main');
  const created=f.trace.find(row=>row.path==='/git/refs');
  assert.deepEqual(created.body,{ref:'refs/heads/producer-state',sha:'a'.repeat(40)});
  const readme=f.trace[initial].body;
  assert.equal(Buffer.from(readme.content,'base64').toString('utf8'),'# Private producer state\n\nDisconnected state backend.\n');
  assert.deepEqual([...f.files.keys()],['README.md','state/journal.json']);
  const first=structuredClone(f.files.get('state/journal.json')),writes=f.trace.filter(row=>row.method!=='GET').length;
  assert.deepEqual(await f.helper.bootstrap(),{status:'READY',createdState:false});
  assert.deepEqual(f.files.get('state/journal.json'),first);
  assert.equal(f.trace.filter(row=>row.method!=='GET').length,writes);
});

const blockedEmptyCases=[
  ['unavailable 409',{initialResponse:()=>Response.json({message:'Git Repository is unavailable.'},{status:409})}],
  ['ambiguous conflict 409',{initialResponse:()=>Response.json({message:'Conflict'},{status:409})}],
  ['message absent 409',{initialResponse:()=>Response.json({},{status:409})}],
  ['structured status mismatch',{initialResponse:()=>Response.json({message:'Git Repository is empty.',status:503},{status:409})}],
  ['structured errors present',{initialResponse:()=>Response.json({message:'Git Repository is empty.',errors:[{code:'unavailable'}]},{status:409})}],
  ['array response',{initialResponse:()=>Response.json([{message:'Git Repository is empty.'}],{status:409})}],
  ['non-string message',{initialResponse:()=>Response.json({message:['Git Repository is empty.']},{status:409})}],
  ['null response',{initialResponse:()=>Response.json(null,{status:409})}],
  ['malformed JSON',{initialResponse:()=>new Response('synthetic-private-response-marker',{status:409,headers:{'Content-Type':'application/json'}})}],
  ['non-JSON response',{initialResponse:()=>new Response('Git Repository is empty.',{status:409})}],
  ['oversized response',{initialResponse:()=>Response.json({message:'Git Repository is empty.',extra:'x'.repeat(8192)},{status:409})}],
  ['HTTP 401',{initialResponse:()=>Response.json({message:'Git Repository is empty.'},{status:401})}],
  ['HTTP 403',{initialResponse:()=>Response.json({message:'Git Repository is empty.'},{status:403})}],
  ['branch inventory non-empty',{inventoryResponse:()=>Response.json([{name:'main'}])}],
  ['branch inventory malformed',{inventoryResponse:()=>Response.json({branches:[]})}],
  ['branch inventory 404',{inventoryResponse:()=>new Response('',{status:404})}],
  ['branch inventory unavailable',{inventoryResponse:()=>Response.json({message:'Unavailable'},{status:409})}],
  ['state branch exists',{stateResponse:()=>Response.json({name:'producer-state'})}],
  ['state branch unavailable',{stateResponse:()=>Response.json({message:'Git Repository is empty.'},{status:409})}],
  ['journal exists',{pathResponse:()=>Response.json({type:'file',path:'state/journal.json'})}],
  ['journal unavailable',{pathResponse:()=>Response.json({message:'Unavailable'},{status:409})}],
  ['initial network ambiguity',{networkFailure:true}],
  ['inventory network ambiguity',{inventoryFailure:true}],
];
for (const [name,options] of blockedEmptyCases) test(`R10C-3B-FIX ${name}: fail-closed / writes 0 / retry 0`,async()=>{
  const f=emptyConflictFixture(options);
  await assert.rejects(f.helper.bootstrap(),error=>error.code==='JOURNAL_IO'&&!error.stack.includes('synthetic-private-response-marker'));
  assert.equal(f.trace.filter(row=>row.method!=='GET').length,0);assert.equal(f.files.size,0);
  assert.equal(f.initialLookups,1);assert.ok(f.trace.filter(row=>row.path==='/branches').length<=1);
});
for (const [name,fixture] of [['wrong repository',{repository:'synthetic-owner/wrong-state'}],['public repository',{privateRepo:false}],
  ['not disconnected',{disconnected:false}]]) test(`R10C-3B-FIX ${name}: metadata guard / writes 0`,async()=>{
    const f=emptyConflictFixture({fixture});
    await assert.rejects(f.helper.bootstrap(),{code:'POLICY_INVALID'});
    assert.equal(f.initialLookups,0);assert.equal(f.trace.filter(row=>row.method!=='GET').length,0);
  });

test('R10C-3B-FIX existing 200: README/ref 생성 및 추가 inventory 없이 기존 journal 보존',async()=>{
  const f=emptyConflictFixture({emptyRepo:false});
  await f.helper.bootstrap();const journal=structuredClone(f.files.get('state/journal.json'));f.trace.length=0;
  assert.deepEqual(await f.helper.bootstrap(),{status:'READY',createdState:false});
  assert.equal(f.initialLookups,0);assert.equal(f.trace.some(row=>row.path==='/branches'),false);
  assert.equal(f.trace.filter(row=>row.method!=='GET').length,0);assert.deepEqual(f.files.get('state/journal.json'),journal);
});
test('R10C-3B-FIX existing 404: 독립 409 evidence 추가 호출 없이 기존 bootstrap 유지',async()=>{
  const f=emptyConflictFixture({initialResponse:()=>new Response('',{status:404})});
  assert.equal((await f.helper.bootstrap()).createdState,true);
  assert.equal(f.trace.some(row=>row.path==='/branches'),false);
  assert.deepEqual(f.trace.filter(row=>row.method!=='GET').map(row=>row.path),['/contents/README.md','/git/refs','/contents/state/journal.json']);
});
test('R10C-3B-FIX README 이후 ref 409: 초기 lookup 예외 재사용 금지 / 추가 쓰기 0',async()=>{
  const f=emptyConflictFixture({afterReadmeStatus:409});
  await assert.rejects(f.helper.bootstrap(),{code:'JOURNAL_IO'});
  assert.deepEqual(f.trace.filter(row=>row.method!=='GET').map(row=>row.path),['/contents/README.md']);
});
for (const status of [409,422]) test(`R10C-3B-FIX journal CAS ${status}: empty message도 충돌 / 추가 bootstrap 금지`,async()=>{
  const f=emptyConflictFixture({journalConflict:status});
  await assert.rejects(f.helper.bootstrap(),{code:'JOURNAL_CAS'});
  assert.equal(f.trace.filter(row=>row.path==='/contents/README.md').length,1);
  assert.equal(f.trace.filter(row=>row.path==='/contents/state/journal.json'&&row.method==='PUT').length,1);
  assert.equal(f.trace.filter(row=>row.path==='/branches').length,1);
});
test('R10C-3B-FIX empty 409 이후 synthetic CAS 계약과 cleanup residue 0',async()=>{
  const f=emptyConflictFixture();await f.helper.bootstrap();
  const journal=structuredClone(f.files.get('state/journal.json'));
  const result=await runSyntheticStateCasContract({fetchImpl:f.fetchImpl,credential:f.env.PRODUCER_STATE_TOKEN,
    repository:f.env.PRODUCER_STATE_REPOSITORY,verifyDisconnected:f.verifier,now:f.now});
  assert.deepEqual(result,{status:'PASS',create:true,update:true,staleConflict:true,readAfterConflict:true,residue:0});
  assert.deepEqual(f.files.get('state/journal.json'),journal);
  assert.deepEqual([...f.files.keys()],['README.md','state/journal.json']);
  await assert.rejects(f.helper.cleanupSynthetic('state/journal.json'),{code:'POLICY_INVALID'});
  await assert.rejects(f.helper.cleanupSynthetic('../state/journal.json'),{code:'POLICY_INVALID'});
});
