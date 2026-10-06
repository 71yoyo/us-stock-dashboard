import assert from 'node:assert/strict';
import { makeProducerFixture,makeAutomationPolicy,fixtureTarget,fixtureRelease,fixtureTime } from './sec-raw-automation-fixtures.js';
import { runProductionSecRawProducer } from '../../scripts/sec-raw-production-runner.mjs';

/** 모든 HTTP는 메모리 fake다. 실제 credential/env 파일/cache/원격 저장소를 읽지 않는다. */
export function productionFixture(options={}) {
  const policy=options.policy??makeAutomationPolicy({secFetchEnabled:true,...options.policyChanges});
  const f=makeProducerFixture({policy}),requests=[],files=new Map(),branches=new Set(options.emptyRepo?[]:['main','producer-state']);
  let revision=0,time=fixtureTime,queueCalls=0;
  const env={CF_QUEUE_API_TOKEN:'synthetic-queue-marker',CF_D1_READ_API_TOKEN:'synthetic-d1-marker',PRODUCER_STATE_TOKEN:'synthetic-state-marker',
    SEC_USER_AGENT:'Synthetic contact producer@invalid.example',CF_ACCOUNT_ID:fixtureTarget.accountId,CF_QUEUE_ID:fixtureTarget.queueId,
    CF_QUEUE_NAME:fixtureTarget.queueName,CF_D1_DATABASE_ID:fixtureTarget.databaseId,CF_D1_DATABASE_NAME:fixtureTarget.databaseName,
    PRODUCER_STATE_REPOSITORY:'synthetic-owner/synthetic-state',PRODUCER_STATE_BRANCH:'producer-state',
    PRODUCER_STATE_PATH:'state/journal.json',PRODUCER_POLICY_PATH:'synthetic-policy.json'};
  const verifier=async()=>options.disconnected!==false;
  async function fetchImpl(input,request={}) {
    const url=new URL(input),path=url.pathname,method=request.method??'GET';requests.push({host:url.host,path,method});
    if (url.host==='data.sec.gov') {
      assert.equal(request.headers['User-Agent'],env.SEC_USER_AGENT);assert.equal(request.headers.Authorization,undefined);
      const cik=path.match(/CIK(\d+)\.json/)?.[1],approved=policy.scope.find(row=>Number(row.cik)===Number(cik));
      if (!approved) throw Error('synthetic-source-missing');
      if (options.secResponse) return options.secResponse();
      const source=f.sources.get(approved.ticker);return Response.json(path.includes('companyfacts')?source.companyFacts:source.submissions);
    }
    if (url.host==='api.cloudflare.com' && path.includes('/queues/')) {
      assert.equal(request.headers.Authorization,`Bearer ${env.CF_QUEUE_API_TOKEN}`);assert.equal(method,'POST');
      assert.equal(path,`/client/v4/accounts/${fixtureTarget.accountId}/queues/${fixtureTarget.queueId}/messages`);
      const body=JSON.parse(request.body);assert.deepEqual(Object.keys(body).sort(),['body','content_type']);
      assert.equal(body.content_type,'json');
      const stored=files.get('state/journal.json')?.data;
      assert.ok(Object.values(stored.entries).some(entry=>entry.state==='INTENT' && entry.sourceIdentity===body.body.sourceIdentity));
      queueCalls++;return options.queueResponse?options.queueResponse():Response.json({success:true,result:{}});
    }
    if (url.host==='api.cloudflare.com' && path.includes('/d1/')) {
      assert.equal(request.headers.Authorization,`Bearer ${env.CF_D1_READ_API_TOKEN}`);
      assert.equal(path.startsWith(`/client/v4/accounts/${fixtureTarget.accountId}/d1/database/${fixtureTarget.databaseId}`),true);
      if (method==='GET') return Response.json({success:true,result:{uuid:options.databaseId??fixtureTarget.databaseId,name:fixtureTarget.databaseName}});
      assert.equal(path.endsWith('/query'),true);assert.equal(method,'POST');
      const {sql,params}=JSON.parse(request.body);let rows;
      if (sql.includes('LEFT JOIN')) rows=f.readiness;
      else if (sql.includes('FROM sec_raw_payload_checkpoint')) {
        const cp=f.states.get(params[0]).checkpoint;
        rows=cp?[{accession:cp.accession,source_identity:cp.sourceIdentity,schema_version:cp.schemaVersion}]:[];
      } else if (sql.includes('FROM sec_raw_runtime')) rows=[f.states.get(params[0]).runtime];
      else if (sql.includes('financial_metrics')) rows=f.states.get(params[0]).financialPeriods;
      else rows=[];
      return Response.json({success:true,result:[{success:true,results:rows,meta:{rows_written:0}}]});
    }
    assert.equal(url.host,'api.github.com');assert.equal(request.headers.Authorization,`Bearer ${env.PRODUCER_STATE_TOKEN}`);
    const root='/repos/synthetic-owner/synthetic-state';assert.ok(path.startsWith(root));const relative=path.slice(root.length);
    if (!relative) return Response.json({private:options.privateRepo!==false,full_name:options.repository??env.PRODUCER_STATE_REPOSITORY,
      default_branch:options.defaultBranch??'main'});
    if (relative.startsWith('/branches/')) {
      const name=decodeURIComponent(relative.slice('/branches/'.length));return branches.has(name)?Response.json({name}):new Response('',{status:404});
    }
    if (relative.startsWith('/git/ref/heads/')) {
      const name=decodeURIComponent(relative.slice('/git/ref/heads/'.length));
      return branches.has(name)?Response.json({object:{sha:'a'.repeat(40)}}):new Response('',{status:404});
    }
    if (relative==='/git/refs') {branches.add(JSON.parse(request.body).ref.slice('refs/heads/'.length));return Response.json({},{status:201});}
    assert.ok(relative.startsWith('/contents/'));const file=relative.slice('/contents/'.length),old=files.get(file);
    if (method==='GET') return old?Response.json({type:'file',path:file,encoding:'base64',sha:old.sha,
      content:Buffer.from(JSON.stringify(old.data)).toString('base64')}):new Response('',{status:404});
    if (options.failGithubWrite) throw Error('synthetic-private-response-marker');
    const body=JSON.parse(request.body);
    if (options.conflict || (body.sha??null)!==(old?.sha??null)) return Response.json({}, {status:options.conflictStatus??409});
    if (method==='DELETE') {files.delete(file);return Response.json({});}
    assert.equal(method,'PUT');assert.equal(body.branch==='main' || body.branch==='producer-state',true);
    if (file==='README.md') branches.add('main');
    const data=file==='README.md'?{}:JSON.parse(Buffer.from(body.content,'base64').toString('utf8'));
    const sha=(++revision).toString(16).padStart(40,'0');files.set(file,{data,sha});return Response.json({content:{sha}},{status:201});
  }
  const instance={...f,env,requests,files,branches,fetchImpl,verifier,now:()=>time,get queueCalls(){return queueCalls;}};
  instance.run=(changes={})=>runProductionSecRawProducer({env,args:[],release:fixtureRelease,loadPolicy:()=>policy,
    verifyDisconnected:verifier,fetchImpl,now:()=>time,sleep:async ms=>{time+=ms;},random:()=>0,runId:'synthetic-run-'+revision,owner:'synthetic-owner',...changes});
  return instance;
}
