import { validateJournalState } from './sec-raw-producer-journal.mjs';
import { safeError } from './sec-raw-automation-policy.mjs';

/** Contents-style SHA CAS adapter다. 별도 private repo/비기본 branch/연결 차단 검증을 요구하며 R10B에서는 fake fetch로만 검증한다. */
export function createGithubJournalBackend({fetchImpl,credential,repository,stateBranch='producer-state',statePath='state/journal.json',
  verifyDisconnected,timeoutMs=10000}={}) {
  if (typeof fetchImpl!=='function' || typeof verifyDisconnected!=='function' || typeof credential!=='string' || !credential || /[\r\n]/.test(credential) ||
      !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository??'') || !/^[a-zA-Z0-9_-]{1,80}$/.test(stateBranch) ||
      !/^state\/[a-zA-Z0-9_-]+\.json$/.test(statePath) || !Number.isSafeInteger(timeoutMs) || timeoutMs<1 || timeoutMs>20000) throw safeError('POLICY_INVALID');
  const base=`https://api.github.com/repos/${repository}`;
  async function request(path,method='GET',body) {
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
    try {
      const response=await fetchImpl(base+path,{method,headers:{Authorization:`Bearer ${credential}`,Accept:'application/vnd.github+json',
        'X-GitHub-Api-Version':'2022-11-28',...(body?{'Content-Type':'application/json'}:{})},
        ...(body?{body:JSON.stringify(body)}:{}),signal:controller.signal,redirect:'error'});
      if ([404,409,422].includes(response.status)) {await response.body?.cancel().catch(()=>{});return {status:response.status};}
      if (![200,201].includes(response.status)) {await response.body?.cancel().catch(()=>{});throw safeError('JOURNAL_IO');}
      const reader=response.body?.getReader();if (!reader) throw safeError('JOURNAL_IO');
      const chunks=[];let bytes=0;
      try {
        while (true) {const {done,value}=await reader.read();if (done) break;bytes+=value.byteLength;
          if (bytes>2*1024*1024) throw safeError('JOURNAL_IO');chunks.push(value);}
        return {status:response.status,data:JSON.parse(Buffer.concat(chunks,bytes).toString('utf8'))};
      } finally {await reader.cancel().catch(()=>{});}
    } catch {throw safeError('JOURNAL_IO');} finally {clearTimeout(timer);}
  }
  let verified=false;
  async function verify() {
    if (verified) return;
    const metadata=await request('');
    if (metadata.data?.private!==true || metadata.data.full_name!==repository || metadata.data.default_branch===stateBranch ||
        await verifyDisconnected({repository,stateBranch,statePath})!==true) throw safeError('POLICY_INVALID');
    verified=true;
  }
  const contents=`/contents/${statePath}`;
  return Object.freeze({kind:'github-private-cas',productionDurable:true,
    load:async()=>{
      await verify();const response=await request(`${contents}?ref=${encodeURIComponent(stateBranch)}`);
      if (response.status===404) {
        // 미존재 파일만 초기화한다. branch 미존재/권한 은폐 404를 empty journal로 오인하지 않는다.
        const branch=await request(`/branches/${encodeURIComponent(stateBranch)}`);
        if (branch.status!==200 || branch.data?.name!==stateBranch) throw safeError('JOURNAL_IO');
        return {revision:null,state:{version:1,targetHash:null,lock:null,entries:{},days:{},delays:{}}};
      }
      try {
        const data=response.data;
        if (data.type!=='file' || data.path!==statePath || data.encoding!=='base64' || !/^[a-f0-9]{40}$/.test(data.sha??'') ||
            typeof data.content!=='string' || !/^[A-Za-z0-9+/=\r\n]*$/.test(data.content)) throw safeError('STATE_INVALID');
        const state=JSON.parse(Buffer.from(data.content,'base64').toString('utf8'));validateJournalState(state);
        return {revision:data.sha,state};
      } catch {throw safeError('STATE_INVALID');}
    },
    compareAndSwap:async(revision,state)=>{
      await verify();validateJournalState(state);
      if (revision!==null && !/^[a-f0-9]{40}$/.test(revision??'')) throw safeError('STATE_INVALID');
      const content=Buffer.from(JSON.stringify(state)).toString('base64');
      if (content.length>1024*1024) throw safeError('JOURNAL_IO');
      const response=await request(contents,'PUT',{message:'Update producer journal state',branch:stateBranch,content,...(revision?{sha:revision}:{})});
      if ([409,422].includes(response.status)) return false;
      if (![200,201].includes(response.status) || !/^[a-f0-9]{40}$/.test(response.data?.content?.sha??'')) throw safeError('JOURNAL_IO');
      return true;
    }
  });
}
