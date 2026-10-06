import test from 'node:test';
import assert from 'node:assert/strict';
import { makeProducerFixture } from './helpers/sec-raw-automation-fixtures.js';
import { createAutomationQueueTransport } from '../scripts/sec-raw-automation-transport.mjs';
import { establishReadiness } from '../scripts/sec-raw-automation-readiness.mjs';

for (const [name,response,kind,category] of [
  ['200',()=>Response.json({success:true,result:{}}),'accepted','ACCEPTED'],
  ['400',()=>new Response('',{status:400}),'rejected','QUEUE_REJECTED'],
  ['401',()=>new Response('',{status:401}),'rejected','QUEUE_AUTH'],
  ['403',()=>new Response('',{status:403}),'rejected','QUEUE_AUTH'],
  ['404',()=>new Response('',{status:404}),'rejected','QUEUE_TARGET'],
  ['429',()=>new Response('',{status:429}),'rejected','QUEUE_REJECTED'],
  ['500',()=>new Response('',{status:500}),'ambiguous','QUEUE_AMBIGUOUS'],
  ['malformed',()=>new Response('synthetic-private-response'),'ambiguous','QUEUE_AMBIGUOUS'],
  ['reset',()=>{throw Error('synthetic-private-reset');},'ambiguous','QUEUE_AMBIGUOUS'],
  ['false success',()=>Response.json({success:false}),'ambiguous','QUEUE_AMBIGUOUS']
]) test(`R10C-3A Queue exact single POST ${name}, payload/auth/retry/response sanitization`,async()=>{
  const f=makeProducerFixture(),runId='single-contract',message=await f.message();let calls=0;
  const receipt=await establishReadiness({policy:f.policy,reader:f.reader,runId,now:f.now});
  const transport=createAutomationQueueTransport({credential:'synthetic-queue-token',now:f.now,fetchImpl:async(url,request)=>{
    calls++;assert.equal(url,`https://api.cloudflare.com/client/v4/accounts/${f.policy.target.accountId}/queues/${f.policy.target.queueId}/messages`);
    assert.equal(request.method,'POST');assert.equal(request.headers.Authorization,'Bearer synthetic-queue-token');
    assert.deepEqual(JSON.parse(request.body),{body:message,content_type:'json'});assert.equal(request.redirect,'error');return response();
  }});
  const result=await transport.send(message,{policy:f.policy,receipt,runId,enqueue:true});
  assert.equal(result.kind,kind);assert.equal(result.category,category);assert.equal(calls,1);
  assert.equal(result.messageId,undefined);assert.equal(JSON.stringify(result).includes('synthetic-private'),false);
});
test('R10C-3A Queue timeout-before-response 단일 POST ambiguous, retry 0',async()=>{
  const f=makeProducerFixture(),runId='timeout-single';let calls=0;
  const receipt=await establishReadiness({policy:f.policy,reader:f.reader,runId,now:f.now});
  const transport=createAutomationQueueTransport({credential:'synthetic-only',timeoutMs:2,now:f.now,
    fetchImpl:async(_url,{signal})=>{calls++;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error()),{once:true}));}});
  assert.equal((await transport.send(await f.message(),{policy:f.policy,receipt,runId,enqueue:true})).kind,'ambiguous');assert.equal(calls,1);
});
