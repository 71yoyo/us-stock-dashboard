import { createBoundedJsonClient } from './sec-raw-production-http.mjs';
import { createGithubJournalBackend } from './sec-raw-github-journal.mjs';
import { applicationIdentity,validateJournalState } from './sec-raw-producer-journal.mjs';
import { safeError } from './sec-raw-automation-policy.mjs';

const empty=()=>({version:1,targetHash:null,lock:null,entries:{},days:{},delays:{}});
// 실제 개인 이메일을 Git commit metadata로 자동 유입하지 않도록 provisioning에서는 합성 bot identity를 사용한다.
const author={name:'SEC Producer State Bootstrap',email:'producer-state@invalid.example'};
/** provisioning 전용이다. 실행 CLI/default fetch는 제공하지 않으며 별도 승인 gate가 명시적으로 호출해야 한다. */
export function createStateProvisioningHelper({fetchImpl,credential,repository,stateBranch='producer-state',statePath='state/journal.json',
  verifyDisconnected}={}) {
  const backendFor=path=>createGithubJournalBackend({fetchImpl,credential,repository,stateBranch,statePath:path,verifyDisconnected});
  backendFor(statePath); // 기존 backend와 같은 경로/credential guard를 먼저 검사한다.
  const request=createBoundedJsonClient({fetchImpl,credential,category:'JOURNAL_IO',base:`https://api.github.com/repos/${repository}`});
  const get=path=>request(path,{allowedStatuses:[200,404],headers:{'X-GitHub-Api-Version':'2022-11-28'}});
  async function metadata(path=statePath) {
    const {data}=await get('');
    if (data?.private!==true || data.full_name!==repository || data.default_branch===stateBranch ||
        !/^[a-zA-Z0-9_-]{1,80}$/.test(data.default_branch??'') ||
        await verifyDisconnected({repository,stateBranch,statePath:path})!==true) throw safeError('POLICY_INVALID');
    return data;
  }
  const write=(path,method,body)=>request(path,{method,body,allowedStatuses:[200,201,409,422],
    headers:{'X-GitHub-Api-Version':'2022-11-28'}});
  return Object.freeze({
    bootstrap:async()=>{
      const repo=await metadata(),branch=repo.default_branch;
      let main=await get(`/git/ref/heads/${encodeURIComponent(branch)}`);
      if (main.status===404) {
        // 기존 default branch를 덮어쓰지 않는다. 빈 repo에 한정한 최소 bootstrap 문서다.
        const result=await write('/contents/README.md','PUT',{message:'Initialize producer state repository',branch,
          content:Buffer.from('# Private producer state\n\nDisconnected state backend.\n').toString('base64'),author,committer:author});
        if (![200,201].includes(result.status)) throw safeError('JOURNAL_CAS');
        main=await get(`/git/ref/heads/${encodeURIComponent(branch)}`);
      }
      if (!/^[a-f0-9]{40}$/.test(main.data?.object?.sha??'')) throw safeError('JOURNAL_IO');
      const state=await get(`/git/ref/heads/${encodeURIComponent(stateBranch)}`);
      if (state.status===404) {
        const created=await write('/git/refs','POST',{ref:`refs/heads/${stateBranch}`,sha:main.data.object.sha});
        if (created.status!==201) throw safeError('JOURNAL_CAS');
      }
      const backend=backendFor(statePath),snapshot=await backend.load();
      if (snapshot.revision===null && !await backend.compareAndSwap(null,empty())) throw safeError('JOURNAL_CAS');
      return {status:'READY',createdState:snapshot.revision===null};
    },
    cleanupSynthetic:async path=>{
      // journal.json은 삭제할 수 없다. 허용된 synthetic 경로에도 실제 ticker/state가 있으면 중단한다.
      if (!/^state\/synthetic-[a-zA-Z0-9_-]{1,50}\.json$/.test(path??'') || path===statePath) throw safeError('POLICY_INVALID');
      await metadata(path);
      const backend=backendFor(path),snapshot=await backend.load();
      if (snapshot.revision===null) return {residue:0};
      const state=snapshot.state;
      if (state.targetHash!==null || state.lock!==null || Object.keys(state.days).length || Object.keys(state.delays).length ||
          Object.values(state.entries).some(entry=>entry.ticker!=='SYNTHETIC')) throw safeError('STATE_INVALID');
      const result=await write(`/contents/${path}`,'DELETE',{message:'Remove synthetic producer state test',branch:stateBranch,
        sha:snapshot.revision,author,committer:author});
      if (result.status!==200) throw safeError('JOURNAL_CAS');
      if ((await backend.load()).revision!==null) throw safeError('JOURNAL_IO');
      return {residue:0};
    }
  });
}

/** 후속 remote gate용 계약 harness다. 여기서는 fake API로만 실행한다. 실패 시 잔여 상태를 임의 삭제하지 않는다. */
export async function runSyntheticStateCasContract({fetchImpl,credential,repository,stateBranch='producer-state',
  statePath='state/synthetic-contract.json',verifyDisconnected,now=Date.now}={}) {
  if (!/^state\/synthetic-[a-zA-Z0-9_-]{1,50}\.json$/.test(statePath)) throw safeError('POLICY_INVALID');
  const options={fetchImpl,credential,repository,stateBranch,verifyDisconnected};
  const backend=createGithubJournalBackend({...options,statePath});
  const missing=await backend.load();if (missing.revision!==null) throw safeError('STATE_INVALID');
  const stamp=new Date(now()).toISOString(),entry={ticker:'SYNTHETIC',accession:'0000000000-00-000001',sourceIdentity:'0'.repeat(64),
    schemaVersion:1,policyHash:'0'.repeat(64),release:'0'.repeat(40),createdAt:stamp,updatedAt:stamp,publishAttemptCount:1,
    transportCategory:'INTENT',state:'INTENT',runId:'synthetic-contract'};
  const key=applicationIdentity(entry);entry.applicationIdentity=key;
  const state=empty();state.entries[key]=entry;validateJournalState(state);
  if (!await backend.compareAndSwap(null,state)) throw safeError('JOURNAL_CAS');
  const first=await backend.load();
  if (JSON.stringify(first.state)!==JSON.stringify(state)) throw safeError('STATE_INVALID');
  state.entries[key].state='ACCEPTED';state.entries[key].transportCategory='ACCEPTED';
  if (!await backend.compareAndSwap(first.revision,state)) throw safeError('JOURNAL_CAS');
  if (await backend.compareAndSwap(first.revision,first.state)!==false) throw safeError('JOURNAL_CAS');
  const current=await backend.load();
  state.entries[key].state='COMPLETED_RECONCILED';state.entries[key].transportCategory='COMPLETED';
  if (!await backend.compareAndSwap(current.revision,state)) throw safeError('JOURNAL_CAS');
  if (JSON.stringify((await backend.load()).state)!==JSON.stringify(state)) throw safeError('STATE_INVALID');
  const cleanup=await createStateProvisioningHelper({...options}).cleanupSynthetic(statePath);
  return {status:'PASS',create:true,update:true,staleConflict:true,readAfterConflict:true,residue:cleanup.residue};
}
