import { sourceFixture } from './sec-raw-promotion-fixtures.js';
import { policyManifestHash } from '../../scripts/sec-raw-automation-policy.mjs';
import { createMemoryJournalBackend,createProducerJournal } from '../../scripts/sec-raw-producer-journal.mjs';
import { runScheduledSecRawProducer } from '../../scripts/sec-raw-scheduled-producer.mjs';
import { buildDiscoveredMessage } from '../../scripts/sec-raw-source-discovery.mjs';

// 모두 합성 identity다. 실제 account/credential/contact를 fixture에 넣지 않는다.
export const fixtureTime=Date.parse('2026-10-06T01:00:00Z');
export const fixtureRelease='736eb6c54a7da93e4a29d93e5b49b643e11312be';
export const fixtureTarget={accountId:'9686e3cb9a51466c847748755431f6ac',databaseId:'9c1ec422-8e29-4c36-a930-edc049254f87',
  databaseName:'synthetic-producer-db',queueId:'0e4d941cae2e4c13b377fc4d85bd0dbf',queueName:'synthetic-producer-queue'};
export const oldAccession='0000726728-26-000001';
export const nextAccession='0000726728-26-000002';
export const laterAccession='0000726728-26-000003';
export function makeAutomationPolicy(changes={}) {
  const policy={policyVersion:1,identityAlgorithmVersion:2,release:fixtureRelease,target:{...fixtureTarget},schemaVersion:1,scope:[{ticker:'O',cik:'726728'}],
    allowedForms:['10-K','10-Q','10-K/A','10-Q/A'],maxPayloadBytes:64000,maxPublishesPerRun:100,maxPublishesPerDay:100,
    maxFetchAttempts:300,maxProviderRequests:300,validFrom:new Date(fixtureTime-1000).toISOString(),expiresAt:new Date(fixtureTime+3600000).toISOString(),
    secFetchEnabled:false,productionEnqueueEnabled:true,...changes};
  return {...policy,policyManifestHash:policyManifestHash(policy)};
}
export function makeSource(ticker='O',{accessions=[nextAccession,oldAccession],indexed=[nextAccession],cash=10,cik='726728'}={}) {
  const companyFacts=sourceFixture({accession:indexed[0]??nextAccession,cash});companyFacts.cik=Number(cik);
  if (!indexed.length) companyFacts.facts={};
  for (const accession of indexed.slice(1)) {
    const extra=sourceFixture({accession,cash});
    for (const [tag,fact] of Object.entries(extra.facts['us-gaap'])) companyFacts.facts['us-gaap'][tag].units.USD.push(...fact.units.USD);
  }
  return {companyFacts,submissions:{cik:Number(cik),tickers:[ticker],filings:{recent:{accessionNumber:accessions,
    filingDate:accessions.map(a=>a===oldAccession?'2026-01-01':a===nextAccession?'2026-04-01':'2026-07-01'),
    form:accessions.map(a=>a===oldAccession?'10-K':'10-Q')},files:[]}}};
}
export function makeProducerFixture(options={}) {
  let time=fixtureTime;
  const policy=options.policy??makeAutomationPolicy(),queries=[],sends=[],sources=new Map(),states=new Map();
  for (const approved of policy.scope) {
    sources.set(approved.ticker,makeSource(approved.ticker,{cik:approved.cik}));
    states.set(approved.ticker,{checkpoint:null,runtime:{raw_status:'ready'},financialPeriods:[{period_type:'annual',fiscal_period_end:'2025-12-31'}]});
  }
  const readiness=policy.scope.map(row=>({ticker:row.ticker,cik:row.cik,migration:22,historical_accession:oldAccession,
    historical_source_identity:'b'.repeat(64),historical_schema_version:1,raw_schema_version:1,raw_data_version:2,raw_status:'ready',record_count:953,available_count:709}));
  const reader={identity:async()=>({uuid:fixtureTarget.databaseId,name:fixtureTarget.databaseName,accountId:fixtureTarget.accountId}),
    readiness:async()=>{queries.push('run-readiness');return structuredClone(readiness);},
    ticker:async ticker=>{queries.push('indexed-ticker');return structuredClone(states.get(ticker));}};
  const backend=options.backend??createMemoryJournalBackend(),journal=createProducerJournal(backend,{now:()=>time});
  const fixture={policy,reader,backend,journal,queries,sends,sources,states,readiness,now:()=>time,advance:ms=>{time+=ms;},
    sourceLoader:async approved=>sources.get(approved.ticker),transport:{send:async(message)=>{sends.push(message);return {kind:'accepted'};}},
    message:async(ticker='O',accession=nextAccession)=>buildDiscoveredMessage({approved:policy.scope.find(row=>row.ticker===ticker),
      candidate:{accession},companyFacts:sources.get(ticker).companyFacts,financialPeriods:states.get(ticker).financialPeriods,
      enqueuedAt:new Date(time).toISOString()})};
  fixture.run=(changes={})=>runScheduledSecRawProducer({policy,release:fixtureRelease,target:fixtureTarget,reader,journal,
    sourceLoader:fixture.sourceLoader,transport:fixture.transport,now:()=>time,enqueue:true,dryRun:false,...changes});
  return fixture;
}
