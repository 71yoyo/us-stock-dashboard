import test from 'node:test';
import assert from 'node:assert/strict';
import { createGithubJournalBackend } from '../scripts/sec-raw-github-journal.mjs';
import { createProducerJournal } from '../scripts/sec-raw-producer-journal.mjs';
import { makeProducerFixture,fixtureTarget } from './helpers/sec-raw-automation-fixtures.js';

/** GitHub protocol까지 fake한다. 실제 repo/network/credential을 사용하지 않는 contract test다. */
function githubFixture({privateRepo=true,defaultBranch='main',disconnected=true,branchExists=true,conflict=false,failWrite=false}={}) {
  const requests=[];let stored=null,sha=null,revision=0;
  const backend=createGithubJournalBackend({repository:'synthetic-owner/synthetic-automation',credential:'synthetic-only',
    verifyDisconnected:async()=>disconnected,fetchImpl:async(url,options)=>{
      requests.push({method:options.method,path:new URL(url).pathname});
      if (options.method==='PUT') {
        if (failWrite) throw Error('SYNTHETIC_PRIVATE_DO_NOT_LOG');
        const body=JSON.parse(options.body);assert.equal(body.branch,'producer-state');
        assert.equal(body.message,'Update producer journal state');
        if (conflict || (body.sha??null)!==sha) return Response.json({message:'synthetic-conflict'},{status:409});
        stored=JSON.parse(Buffer.from(body.content,'base64').toString('utf8'));revision++;sha=revision.toString(16).padStart(40,'0');
        return Response.json({content:{sha}},{status:201});
      }
      if (url.includes('/contents/')) return stored?Response.json({type:'file',path:'state/journal.json',encoding:'base64',sha,
        content:Buffer.from(JSON.stringify(stored)).toString('base64')}):new Response('',{status:404});
      if (url.includes('/branches/')) return branchExists?Response.json({name:'producer-state'}):new Response('',{status:404});
      return Response.json({private:privateRepo,full_name:'synthetic-owner/synthetic-automation',default_branch:defaultBranch});
    }});
  return {backend,requests,get:()=>stored};
}
test('R10B private Github CAS adapter는 같은 backend contract와 journal 재시작을 지원한다',async()=>{
  const f=githubFixture(),producer=makeProducerFixture({backend:f.backend});const result=await producer.run();
  assert.equal(result.queued,1);assert.equal(f.backend.productionDurable,true);
  const restored=createProducerJournal(f.backend,{now:producer.now});const next=await producer.run({journal:restored});
  assert.equal(next.inFlight,1);assert.equal(producer.sends.length,1);
  assert.ok(!JSON.stringify(f.get()).includes('facts'));assert.ok(f.requests.some(row=>row.method==='PUT'));
});
test('R10B Github optimistic SHA conflict는 기존 state를 overwrite하지 않는다',async()=>{
  const f=githubFixture(),snapshot=await f.backend.load();
  assert.equal(await f.backend.compareAndSwap(null,snapshot.state),true);
  assert.equal(await f.backend.compareAndSwap(null,snapshot.state),false);
});
for (const [label,options,code] of [
  ['public repo',{privateRepo:false},'POLICY_INVALID'],
  ['default branch',{defaultBranch:'producer-state'},'POLICY_INVALID'],
  ['연결 차단 미확인',{disconnected:false},'POLICY_INVALID'],
  ['404 branch 없음',{branchExists:false},'JOURNAL_IO'],
]) test(`R10B Github ${label} fail-closed`,async()=>{
  const f=githubFixture(options);await assert.rejects(f.backend.load(),{code});assert.ok(f.requests.every(row=>row.method==='GET'));
});
test('R10B Github CAS conflict가 지속되면 3회 후 STOP',async()=>{
  const f=githubFixture({conflict:true}),journal=createProducerJournal(f.backend);
  await assert.rejects(journal.acquire({runId:'run',owner:'owner',target:fixtureTarget}),{code:'JOURNAL_CAS'});
  assert.equal(f.requests.filter(row=>row.method==='PUT').length,3);
});
test('R10B Github write network/ambiguous는 오류 원문 미노출이며 자동 write retry하지 않는다',async()=>{
  const f=githubFixture({failWrite:true}),journal=createProducerJournal(f.backend);
  await assert.rejects(journal.acquire({runId:'run',owner:'owner',target:fixtureTarget}),error=>error.code==='JOURNAL_IO'&&!error.stack.includes('SYNTHETIC_PRIVATE'));
  assert.equal(f.requests.filter(row=>row.method==='PUT').length,1);
});
test('R10B Github adapter는 injectable fetch/분리검증 없으면 생성하지 못한다',()=>{
  assert.throws(()=>createGithubJournalBackend({credential:'synthetic-only',repository:'synthetic-owner/synthetic-automation'}),{code:'POLICY_INVALID'});
});
test('R10B 실제 Queue REST core는 memory/local ephemeral journal을 durable truth로 허용하지 않는다',async()=>{
  const f=makeProducerFixture();await assert.rejects(f.run({transport:{kind:'official-rest',send:()=>{throw Error('must not call');}}}),{code:'POLICY_INVALID'});
});
