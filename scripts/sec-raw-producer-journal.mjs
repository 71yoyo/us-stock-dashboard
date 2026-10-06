import { readFile, open, rename, unlink, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonical, hash, safeError, errorCategories } from './sec-raw-automation-policy.mjs';

export const journalStates = Object.freeze(['INTENT','ACCEPTED','AMBIGUOUS','FAILED_SAFE','COMPLETED_RECONCILED','REVIEW_BLOCKED','OPERATOR_REQUIRED']);
const unresolved = new Set(['INTENT','ACCEPTED','AMBIGUOUS','OPERATOR_REQUIRED']);
const emptyState = () => ({version:1,targetHash:null,lock:null,entries:{},days:{},delays:{}});
const entryKeys = ['ticker','accession','sourceIdentity','applicationIdentity','schemaVersion','policyHash','release',
  'createdAt','updatedAt','publishAttemptCount','transportCategory','state','runId'];
const hex = (text,n) => typeof text==='string' && new RegExp(`^[a-f0-9]{${n}}$`).test(text);
const id = text => typeof text==='string' && /^[a-zA-Z0-9_-]{1,80}$/.test(text);
const date = text => typeof text==='string' && Number.isFinite(Date.parse(text));
function keysEqual(object,keys) { return object && typeof object==='object' && !Array.isArray(object) && Object.keys(object).sort().join('|')===[...keys].sort().join('|'); }

/** 상태에는 식별자/고정 범주만 허용한다. raw payload나 오류 원문이 durable 파일에 섞이지 않도록 한다. */
export function validateJournalState(state) {
  if (!keysEqual(state,['version','targetHash','lock','entries','days','delays']) || state.version!==1 ||
      !(state.targetHash===null || hex(state.targetHash,64))) throw safeError('STATE_INVALID');
  if (state.lock!==null && (!keysEqual(state.lock,['runId','owner','expiresAt']) || !id(state.lock.runId) || !id(state.lock.owner) || !date(state.lock.expiresAt))) throw safeError('STATE_INVALID');
  for (const field of ['entries','days','delays']) if (!state[field] || typeof state[field]!=='object' || Array.isArray(state[field])) throw safeError('STATE_INVALID');
  for (const [key,e] of Object.entries(state.entries)) {
    if (!keysEqual(e,entryKeys) || key!==applicationIdentity(e) || !/^[A-Z][A-Z0-9.-]{0,9}$/.test(e.ticker) || e.ticker==='LMT' ||
        !/^\d{10}-\d{2}-\d{6}$/.test(e.accession) || !hex(e.sourceIdentity,64) || !hex(e.policyHash,64) || !hex(e.release,40) ||
        e.schemaVersion!==1 || !date(e.createdAt) || !date(e.updatedAt) || !id(e.runId) ||
        !Number.isSafeInteger(e.publishAttemptCount) || e.publishAttemptCount!==1 || !journalStates.includes(e.state) ||
        !(['INTENT','ACCEPTED','COMPLETED','REVIEW',...errorCategories].includes(e.transportCategory))) throw safeError('STATE_INVALID');
  }
  for (const [day,count] of Object.entries(state.days)) if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isSafeInteger(count) || count<0) throw safeError('STATE_INVALID');
  for (const [key,d] of Object.entries(state.delays)) if (!/^[A-Z][A-Z0-9.-]{0,9}:\d{10}-\d{2}-\d{6}$/.test(key) ||
      !keysEqual(d,['attempts','nextCheckAt','status']) || !Number.isSafeInteger(d.attempts) || d.attempts<1 || d.attempts>3 ||
      !date(d.nextCheckAt) || !['SOURCE_NOT_INDEXED','OPERATOR_REQUIRED'].includes(d.status)) throw safeError('STATE_INVALID');
  return state;
}
export function applicationIdentity({ticker,accession,sourceIdentity,schemaVersion=1}) { return hash({ticker,accession,sourceIdentity,schemaVersion}); }
export function createMemoryJournalBackend(initial) {
  let snapshot=initial ? structuredClone(initial) : {revision:null,state:emptyState()};
  validateJournalState(snapshot.state);
  return Object.freeze({kind:'memory-fixture',productionDurable:false,
    load:async()=>structuredClone(snapshot),
    compareAndSwap:async(revision,state)=>{
      validateJournalState(state);
      if (snapshot.revision!==revision) return false;
      snapshot={revision:randomUUID(),state:structuredClone(state)}; return true;
    }
  });
}

/** 로컬 fixture 전용이다. exclusive mutation lock + fsync + atomic rename으로 재시작을 검증하며 Actions durable truth로 사용하지 않는다. */
export function createLocalFixtureJournalBackend(file) {
  const path=resolve(file);
  if (!path.endsWith('.fixture.json')) throw safeError('STATE_INVALID');
  async function load() {
    try {
      const raw=await readFile(path,'utf8');
      if (Buffer.byteLength(raw)>8*1024*1024) throw safeError('STATE_INVALID');
      const parsed=JSON.parse(raw);
      if (!keysEqual(parsed,['revision','state']) || !id(parsed.revision)) throw safeError('STATE_INVALID');
      validateJournalState(parsed.state); return parsed;
    } catch (error) { if (error.code==='ENOENT') return {revision:null,state:emptyState()}; throw safeError(error.code==='STATE_INVALID'?'STATE_INVALID':'JOURNAL_IO'); }
  }
  return Object.freeze({kind:'local-fixture',productionDurable:false,load,compareAndSwap:async(revision,state)=>{
    validateJournalState(state); await mkdir(dirname(path),{recursive:true});
    let lock;
    try { lock=await open(path+'.mutation-lock','wx',0o600); }
    catch (error) { throw safeError(error.code==='EEXIST'?'JOURNAL_CAS':'JOURNAL_IO'); }
    const temporary=path+'.'+randomUUID()+'.tmp';
    try {
      const current=await load(); if (current.revision!==revision) return false;
      const handle=await open(temporary,'wx',0o600);
      try { await handle.writeFile(JSON.stringify({revision:randomUUID(),state})); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary,path); return true;
    } catch { throw safeError('JOURNAL_IO'); }
    finally {
      await unlink(temporary).catch(()=>{}); await lock.close(); await unlink(path+'.mutation-lock').catch(()=>{});
    }
  }});
}

/** CAS는 제한된 횟수만 재시도한다. 오래된 run lock을 자동 탈취하지 않고 operator의 명시적 해제를 요구한다. */
export function createProducerJournal(backend,{now=Date.now}={}) {
  if (typeof backend?.load!=='function' || typeof backend?.compareAndSwap!=='function') throw safeError('STATE_INVALID');
  async function load() { try { const result=await backend.load(); validateJournalState(result.state); return result; } catch { throw safeError('JOURNAL_IO'); } }
  async function mutate(action) {
    for (let i=0;i<3;i++) {
      const snapshot=await load(), state=structuredClone(snapshot.state), result=action(state);
      if (result?.unchanged) return result.value;
      validateJournalState(state);
      try { if (await backend.compareAndSwap(snapshot.revision,state)) return result; }
      catch { throw safeError('JOURNAL_IO'); }
    }
    throw safeError('JOURNAL_CAS');
  }
  function assertLock(state,runId,owner) {
    if (!state.lock || state.lock.runId!==runId || state.lock.owner!==owner) throw safeError('LOCK_BUSY');
    if (Date.parse(state.lock.expiresAt)<=now()) throw safeError('LOCK_STALE');
  }
  async function transition(key,state,category) {
    return mutate(s=>{
      const e=s.entries[key]; if (!e) throw safeError('STATE_INVALID');
      if (e.state===state) return {unchanged:true,value:structuredClone(e)};
      if (['COMPLETED_RECONCILED','REVIEW_BLOCKED'].includes(e.state)) throw safeError('STATE_INVALID');
      if (['ACCEPTED','AMBIGUOUS','FAILED_SAFE'].includes(state) && e.state!=='INTENT') throw safeError('STATE_INVALID');
      e.state=state; e.transportCategory=category; e.updatedAt=new Date(now()).toISOString(); return structuredClone(e);
    });
  }
  return Object.freeze({load,productionDurable:backend.productionDurable===true,backendKind:backend.kind??'contract-adapter',
    acquire:async({runId,owner,target,ttlMs=300000})=>mutate(s=>{
      if (!id(runId) || !id(owner) || !Number.isSafeInteger(ttlMs) || ttlMs<1000 || ttlMs>3600000) throw safeError('STATE_INVALID');
      const targetHash=hash(target);
      if (s.targetHash && s.targetHash!==targetHash) throw safeError('TARGET_MISMATCH');
      if (s.lock) throw safeError(Date.parse(s.lock.expiresAt)<=now()?'LOCK_STALE':'LOCK_BUSY');
      s.targetHash=targetHash; s.lock={runId,owner,expiresAt:new Date(now()+ttlMs).toISOString()}; return structuredClone(s.lock);
    }),
    release:async({runId,owner})=>mutate(s=>{
      if (!s.lock || s.lock.runId!==runId || s.lock.owner!==owner) throw safeError('LOCK_BUSY');
      s.lock=null; return true;
    }),
    // 자동 orchestration에서는 호출하지 않는다. stale owner를 확인한 별도 operator 도구만 사용 가능하다.
    clearStale:async({runId,owner,operatorApproved=false})=>mutate(s=>{
      if (!operatorApproved || !s.lock || s.lock.runId!==runId || s.lock.owner!==owner || Date.parse(s.lock.expiresAt)>now()) throw safeError('OPERATOR_REQUIRED');
      s.lock=null; return true;
    }),
    get:async key=>(await load()).state.entries[key]??null,
    listUnresolved:async ticker=>Object.values((await load()).state.entries).filter(e=>(!ticker || e.ticker===ticker)&&unresolved.has(e.state)),
    putIntent:async({message,policy,runId,owner,runPublishes})=>mutate(s=>{
      assertLock(s,runId,owner);
      const key=applicationIdentity(message);
      if (s.entries[key]) return {unchanged:true,value:{existing:true,entry:structuredClone(s.entries[key])}};
      const day=new Date(now()).toISOString().slice(0,10);
      const reserved=Object.values(s.entries).filter(e=>e.runId===runId).length;
      if (runPublishes>=policy.maxPublishesPerRun || reserved>=policy.maxPublishesPerRun || (s.days[day]??0)>=policy.maxPublishesPerDay) throw safeError('BUDGET_EXHAUSTED');
      const timestamp=new Date(now()).toISOString();
      const entry={ticker:message.ticker,accession:message.accession,sourceIdentity:message.sourceIdentity,applicationIdentity:key,
        schemaVersion:1,policyHash:policy.policyManifestHash,release:policy.release,createdAt:timestamp,updatedAt:timestamp,
        publishAttemptCount:1,transportCategory:'INTENT',state:'INTENT',runId};
      s.entries[key]=entry; s.days[day]=(s.days[day]??0)+1;
      return {existing:false,entry:structuredClone(entry)};
    }),
    markAccepted:key=>transition(key,'ACCEPTED','ACCEPTED'),
    markAmbiguous:key=>transition(key,'AMBIGUOUS','QUEUE_AMBIGUOUS'),
    markFailed:(key,category='QUEUE_REJECTED')=>transition(key,'FAILED_SAFE',category),
    markOperator:key=>transition(key,'OPERATOR_REQUIRED','OPERATOR_REQUIRED'),
    // 완료/review를 추측으로 설정하는 범용 setter는 공개하지 않는다. source/schema/accession 증거가 필수다.
    reconcile:async(ticker,{checkpoint,reviewEvidence}={})=>{
      for (const e of await (async()=>Object.values((await load()).state.entries).filter(row=>row.ticker===ticker&&unresolved.has(row.state)))()) {
        const matches=proof=>proof?.accession===e.accession && proof?.sourceIdentity===e.sourceIdentity && proof?.schemaVersion===e.schemaVersion;
        if (matches(checkpoint)) await transition(e.applicationIdentity,'COMPLETED_RECONCILED','COMPLETED');
        else if (reviewEvidence?.status==='pending_review' && matches(reviewEvidence)) await transition(e.applicationIdentity,'REVIEW_BLOCKED','REVIEW');
        else if (e.state==='INTENT') await transition(e.applicationIdentity,'OPERATOR_REQUIRED','OPERATOR_REQUIRED');
      }
    },
    deferNotIndexed:async({ticker,accession,runId,owner})=>mutate(s=>{
      assertLock(s,runId,owner); const key=`${ticker}:${accession}`, old=s.delays[key];
      const attempts=Math.min(3,(old?.attempts??0)+1);
      s.delays[key]={attempts,nextCheckAt:new Date(now()+Math.min(3600000,300000*2**(attempts-1))).toISOString(),
        status:attempts===3?'OPERATOR_REQUIRED':'SOURCE_NOT_INDEXED'}; return structuredClone(s.delays[key]);
    }),
    delayed:async(ticker,accession)=>(await load()).state.delays[`${ticker}:${accession}`]??null
  });
}
