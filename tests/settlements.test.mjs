import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {gunzipSync,gzipSync} from 'node:zlib';
import {createHash,webcrypto} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {createSettlementSource} from '../src/settlements.js';
import {createLiveAdapter} from '../src/adapter.js';
import {prepareSettlementTables} from '../scripts/prepare-settlement-tables.mjs';
import {productRuntime} from './support/runtime.mjs';
const read=async name=>JSON.parse(name.endsWith('.gz')?gunzipSync(await readFile(new URL(name,import.meta.url))):await readFile(new URL(name,import.meta.url),'utf8'));
const sampled=await read('../data/live-snapshot.json.gz'),proof=await read('./fixtures/indexed-settlements-proof.json.gz');
const receipt=await read('./fixtures/indexed-settlements-proof-receipt.json');
const monthlyCheck=await read('../data/monthly-claims-diagnostic.json');
const independent=await read('./fixtures/indexed-settlements-proof-owner-analysis.json');
const sha='63152f697a3c72b134301f6d7c043a702946ea92e24c1bd54056e26e3e18b81a';
const tables=prepareSettlementTables(sampled,proof,sha);
const adapter=createLiveAdapter(structuredClone(sampled),monthlyCheck,proof,receipt,tables);
const source=createSettlementSource(sampled,proof,receipt);
const q=(scope={type:'network',value:'live-sample'},extra={})=>({scope,serviceId:'eth',serviceIds:['eth'],period:'7',filters:[],...extra});
const close=(a,b,tolerance=1e-7)=>assert(Math.abs(a-b)<tolerance,`${a} != ${b}`);

 test('the real proof keeps recorded earnings and sampled selection in separate universes',()=>{
  const report=adapter.getReport(q());
  assert.equal(report.earningsUniverse,'indexed-settled-sessions');
  assert.equal(report.rewards.recordedSessions,1327);assert.equal(report.rewards.comparableSessions,1327);
  assert.equal(report.rewards.coverage,1);assert.equal(report.rewards.ratio,1);
  assert.equal(report.rewards.availability,'available');assert.deepEqual(report.rewards.intervalRatio,[1,1]);
  assert.equal(report.exposure.recordedSessions,224);assert.equal(report.exposure.selectedPositions,224*50);
  assert.equal(report.evidence.selectionSampleSessions,224);assert.equal(report.evidence.sampledComparableOutcomes,74);
  assert.equal(adapter.coverageDiagnostics().sessions,4080);assert.equal(adapter.coverageDiagnostics().covered,1652);
  assert.equal(adapter.coverageDiagnostics().unknown,2428);assert.equal(adapter.coverageDiagnostics().neverCoveredGroups,19);
  assert(source.framesFor(q()).every(f=>f.N===null&&f.n===null&&f.populationId===null));
  const original=createLiveAdapter(structuredClone(sampled),monthlyCheck).getReport(q());
  assert.deepEqual(report.exposure,original.exposure);assert.deepEqual(report.scenarioReferences,original.scenarioReferences);
  assert.equal(report.snapshotId,adapter.snapshotInfo.snapshotId);assert.notEqual(report.snapshotId,sampled.snapshotId);
});

 test('all 193 owner results reconcile with independent exact integer/Fraction analysis',()=>{
  const rows=adapter.leaderboard('eth','7','owner');assert.equal(rows.length,193);
  assert.equal(rows.filter(r=>r.availability==='available').length,110);
  const byOwner=new Map(rows.map(row=>[row.ownerAddress,row]));
  for(const row of independent.rows){
    const actual=adapter.getReport(q({type:'owner',value:row.label})).rewards,table=byOwner.get(row.label);
    assert(table);close(actual.actualPokt,row.actualPokt);close(actual.equalSharePokt,row.equalSharePokt);
    if(row.fScore!==null){close(actual.ratio,row.fScore,1e-11);close(table.ratio,row.fScore,1e-11);}
    assert.equal(actual.positiveSessions,row.positiveSessions);assert.equal(actual.informativeDays,row.informativeDays);
    assert.equal(table.availability,actual.availability);assert.equal(table.selectedSuppliers,row.selectedSupplierIdentities);
    close(table.actualPokt,actual.actualPokt);close(table.equalSharePokt,actual.equalSharePokt);
  }
  close(rows.reduce((n,r)=>n+r.actualPokt,0),adapter.getReport(q()).rewards.actualPokt);
  close(rows.reduce((n,r)=>n+r.equalSharePokt,0),adapter.getReport(q()).rewards.equalSharePokt);
});

 test('all 255 service subsets and three periods include the pilot exactly once and never invent other service payments',()=>{
  const ids=sampled.services.map(s=>s.id),total=source.framesFor(q()).reduce((n,f)=>n+f.actual,0);
  let views=0;
  for(let mask=1;mask<256;mask++)for(const period of ['7','14','30']){
    const selected=ids.filter((_,i)=>mask&(1<<i)),frames=source.framesFor(q(undefined,{serviceIds:selected,period}));
    assert.equal(frames.length,selected.includes('eth')?1327:0);
    if(frames.length){close(frames.reduce((n,f)=>n+f.actual,0),total);assert.equal(new Set(frames.map(f=>f.sessionId)).size,1327);}
    views++;
  }
  assert.equal(views,765);
});

 test('domain, hostname, owner, Supplier and intersecting filters follow each exact selected roster',()=>{
  const row=proof.sessions[40],member=proof.membershipCatalog[row.members[0]],endpoint=proof.endpointCatalog[member[2][0]];
  const scopes=[{type:'owner',value:proof.ownerIds[member[1]]},{type:'supplier',value:proof.supplierIds[member[0]]},
    {type:'hostname',value:endpoint.hostname},{type:'domain',value:endpoint.registrableDomain}];
  const matches=(m,scope)=>scope.type==='owner'?proof.ownerIds[m[1]]===scope.value:scope.type==='supplier'?proof.supplierIds[m[0]]===scope.value:
    m[2].some(i=>scope.type==='hostname'?proof.endpointCatalog[i].hostname===scope.value:
      proof.endpointCatalog[i].hostname===scope.value||proof.endpointCatalog[i].hostname?.endsWith('.'+scope.value));
  for(const scope of scopes){
    const frames=source.framesFor(q(scope));
    for(let i=0;i<frames.length;i++){
      const raw=proof.sessions.find(s=>s.id===frames[i].sessionId),own=new Set(raw.members.map(index=>proof.membershipCatalog[index]).filter(m=>matches(m,scope)).map(m=>m[0]));
      assert.equal(frames[i].X,own.size);close(frames[i].actual,raw.payouts.reduce((n,[id,v])=>n+(own.has(id)?Number(v):0),0)/1e6);
      close(frames[i].reference,Number(raw.poolUpokt)*own.size/raw.selectedCount/1e6);
    }
  }
  const scoped={type:'domain',value:endpoint.registrableDomain},filter={dimension:'owner',value:proof.ownerIds[member[1]]};
  const frames=source.framesFor(q(scoped,{filters:[filter]}));
  for(const frame of frames){
    const raw=proof.sessions.find(s=>s.id===frame.sessionId),selected=raw.members.map(i=>proof.membershipCatalog[i]).filter(m=>matches(m,scoped)&&proof.ownerIds[m[1]]===filter.value);
    assert.equal(frame.X,selected.length);
  }
  assert(source.framesFor(q({type:'domain',value:'not'+endpoint.registrableDomain})).every(f=>f.X===0));
});

 test('every recorded identity table matches the same service and period report',()=>{
  for(const period of ['7','14','30'])for(const grouping of ['owner','domain']){
    for(const row of adapter.leaderboard('eth',period,grouping)){
      const report=adapter.getReport(q(row.scope,{period})).rewards;
      close(row.actualPokt,report.actualPokt);close(row.equalSharePokt,report.equalSharePokt);
      if(row.ratio!==null)close(row.ratio,report.ratio,1e-11);
      assert.equal(row.recordedSessions,report.recordedSessions);assert.equal(row.positiveSessions,report.positiveSessions);
      assert.equal(row.availability,report.availability);
      if(row.intervalRatio)row.intervalRatio.forEach((value,i)=>close(value,report.intervalRatio[i],1e-11));
    }
  }
  assert.equal(adapter.leaderboard('eth','7','domain').length,13);
  assert.deepEqual(adapter.leaderboard('base','7','domain'),[]);
});

 test('Application groups absent from the index remain unavailable, rather than verified zero',()=>{
  const breakdown=adapter.getBreakdown(q(),'application');
  assert.equal(breakdown.rows.length,8);assert.equal(breakdown.rows.filter(r=>r.recordedSessions===0).length,5);
  for(const row of breakdown.rows.filter(r=>r.recordedSessions===0)){
    assert.equal(row.actualPokt,null);assert.equal(row.equalSharePokt,null);assert.equal(row.ratio,null);
    assert.match(row.reason,/remain unknown/);assert.equal(row.availability,'unavailable');
  }
  close(breakdown.rows.reduce((n,r)=>n+(r.actualPokt??0),0),adapter.getReport(q()).rewards.actualPokt);
  assert.equal(adapter.getPersistenceDiagnostic(q(undefined,{period:'30'})).availability,'unavailable');
  assert.match(adapter.getPersistenceDiagnostic(q(undefined,{period:'30'})).reason,/covers 7 days/);
});

 test('exports retain exact integer amounts, membership catalogs, original sample and conditional disclosure',()=>{
  const result=adapter.exportResult(q(),'application');
  assert.equal(result.sessionEvidence.length,1327);assert.equal(result.selectionEvidence.length,224);
  assert.equal(result.recordedSettlementEvidence.codec,'membership-indices-v2');
  assert.equal(result.recordedSettlementEvidence.membershipCatalog.length,proof.membershipCatalog.length);
  assert.equal(result.recordedSettlementEvidence.sessions[0].poolUpokt,proof.sessions[0].poolUpokt);
  assert.match(result.disclosure,/outside this denominator/);
  assert.equal(result.settlementReceipt.overlap.coveredSessionsReconciled,74);
});

 test('corrupt receipts, dates, money, payout identities and cross-service memberships fail closed',()=>{
  const mutate=[
    w=>w.config.cutoff++,w=>w.sessions[0].members.push(w.sessions[0].members[0]),
    w=>w.sessions[0].members[0]=999999999,w=>w.sessions[0].poolUpokt='9007199254740993',
    w=>w.sessions[0].poolUpokt=String(Number(w.sessions[0].poolUpokt)+1),
    w=>w.sessions[0].payouts[0][0]=w.supplierIds.length,
    w=>w.sessions[0].endedAt='2026-10-06T00:00:00Z',w=>w.coverage.indexedClaims++,
    w=>w.sessions.push(w.sessions[0]),
    w=>w.endpointCatalog[w.membershipCatalog[w.sessions[0].members[0]][2][0]].serviceId='base'
  ];
  for(const change of mutate){const bad=structuredClone(proof);change(bad);assert.throws(()=>createSettlementSource(sampled,bad,receipt),/Invalid settlement evidence/);}
  const badReceipt=structuredClone(receipt);badReceipt.overlap.passed=false;
  assert.throws(()=>createSettlementSource(sampled,proof,badReceipt),/receipt/);
});

 test('an endpoint observed only in settlements remains searchable without inventing sampled eligibility',()=>{
  // A generated endpoint exercises the registry/sample boundary; it is test-only.
  const wire=structuredClone(proof),endpoint={...wire.endpointCatalog[0],id:'endpoint:test-only',
    hostname:'fresh.runner.example',registrableDomain:'runner.example',url:'wss://fresh.runner.example',
    subdomain:'fresh',subdomainLabels:['fresh']};
  wire.endpointCatalog.push(endpoint);
  const catalogIndex=wire.sessions[0].members[0];
  wire.membershipCatalog[catalogIndex][2].push(wire.endpointCatalog.length-1);
  const a=createLiveAdapter(structuredClone(sampled),null,wire,receipt);
  assert(a.search('runner').some(r=>r.scope.type==='domain'&&r.scope.value==='runner.example'));
  assert(a.search('fresh.runner.example').some(r=>r.scope.type==='hostname'));
  const scope={type:'domain',value:'runner.example'},services=a.servicesFor(scope);
  assert.equal(services.length,1);assert.equal(services[0].id,'eth');assert.equal(services[0].availability,'recorded_only');
  const report=a.getReport(q(scope));assert(report.scope.identityCount>0);assert.equal(report.scope.supplierCount,0);
  assert(report.rewards.positiveSessions>0);assert.equal(report.exposure.presentSessions,0);
 });

 test('table metrics do not reuse the old sampled comparison when no settlement table is supplied',()=>{
  const runtime=createLiveAdapter(structuredClone(sampled),monthlyCheck,proof,receipt);
  const rows=runtime.leaderboard('eth','7','domain');assert.equal(rows.length,13);
  assert(rows.every(r=>r.recordedSessions===1327&&r.coverage===1&&r.earningsUniverse==='indexed-settled-sessions'));
  assert.deepEqual(runtime.leaderboard('base','7','domain'),[]);
});

 test('historical tests require enough separate early and late evidence and retain late outcomes in the training denominator',()=>{
  // Generated unit-test records; never installed as mainnet evidence.
  const wire=structuredClone(proof);wire.config.start=sampled.period.start;wire.sessions=[];
  for(let day=0;day<30;day++)for(let i=0;i<4;i++){
    const date=new Date(+new Date(sampled.period.start)+day*86400000+i*3600000).toISOString();
    wire.sessions.push({...structuredClone(proof.sessions[0]),id:`test-${day}-${i}`,endedAt:date,outcomeAvailableAt:new Date(+new Date(date)+600000).toISOString()});
  }
  wire.coverage={indexedClaims:240,verifiedDistributionClaims:240,unknownDistributionClaims:0,indexedSettledSessions:120,verifiedDistributionSessions:120};
  const r=structuredClone(receipt);r.config=structuredClone(wire.config);r.coverage=structuredClone(wire.coverage);
  const a=createLiveAdapter(structuredClone(sampled),null,wire,r);
  const prediction=a.getPersistenceDiagnostic(q(undefined,{period:'30'}));
  assert.equal(prediction.availability,'available');assert.equal(prediction.trainingDays,13);assert.equal(prediction.testDays,15);
  close(prediction.equalDailyErrorPokt,0);close(prediction.earlierDailyErrorPokt,0);
  assert.equal(a.getPersistenceDiagnostic(q(undefined,{period:'14'})).availability,'unavailable');
  wire.sessions.filter(s=>s.endedAt<'2026-09-19').forEach(s=>s.outcomeAvailableAt='2026-10-05T00:00:00Z');
  const late=createLiveAdapter(structuredClone(sampled),null,wire,r).getPersistenceDiagnostic(q(undefined,{period:'30'}));
  assert.equal(late.availability,'unavailable');assert.match(late.reason,/Earlier period: 0 informative days/);
});

 test('the saved-data loader fetches only a same-deployment hashed asset and rejects failed or altered bytes',async()=>{
  const code=(await readFile(new URL('../src/snapshot-loader.js',import.meta.url),'utf8')).replace(/^export /gm,'');
  const bytes=gzipSync(JSON.stringify({testMarker:true})),digest=createHash('sha256').update(bytes).digest('hex');
  const filename=`settlements-${digest.slice(0,16)}.bin`,calls=[];
  const context={crypto:webcrypto,Response,Blob,DecompressionStream,Uint8Array,fetch:async(url,options)=>{calls.push([url,options]);return new Response(bytes);}};
  const load=runInNewContext(code+'\nloadSavedSettlements;',context);
  assert.equal((await load(filename,digest)).testMarker,true);assert.equal(calls[0][0],'./'+filename);
  assert.equal(calls[0][1].credentials,'same-origin');
  await assert.rejects(load('https://untrusted.example/data',digest),/reference/);assert.equal(calls.length,1);
  context.fetch=async()=>new Response('changed');await assert.rejects(load(filename,digest),/checksum/);
  context.fetch=async()=>new Response('',{status:503});await assert.rejects(load(filename,digest),/HTTP 503/);
});

 test('controller views explain both scopes, preserve missing groups and change F ordering',async()=>{
  const runtime=await productRuntime('',{data:structuredClone(sampled),monthlyCheck,settlementData:proof,settlementReceipt:receipt,settlementTables:tables});
  runtime.action('live-open-domain',{domain:'kleomedes.network'});
  runtime.action('earnings-scope');assert(runtime.dialog().includes('1,327'));assert(runtime.dialog().includes('4,080'));
  assert(runtime.dialog().includes('1,652'));assert(runtime.dialog().includes('not been certified as zero'));
  runtime.action('live-coverage');assert(runtime.dialog().includes('40.5%'));assert(runtime.dialog().includes('19 of 34'));
  runtime.action('close-dialog');
  for(const view of ['summary','breakdown','predictions','diagnostics']){
    runtime.action('view',{view});assert(runtime.html().includes('Why two sets?'));assert(!runtime.html().includes('NaN'));
  }
  runtime.action('home');runtime.action('live-discovery-view',{view:'compare'});runtime.field('leaderboard-service','eth');runtime.field('leaderboard-period','7');
  assert(runtime.html().includes('Recorded gross earnings'));assert(runtime.html().includes('Opportunities'));
  const ids=()=>[...runtime.html().matchAll(/data-comparison-group="([^"]+)"/g)].map(m=>m[1]);
  for(const grouping of ['domain','owner']){
    runtime.action('live-grouping',{grouping,'grouping-context':'comparison'});runtime.action('live-sort',{sort:'earnings'});const before=ids();
    runtime.action('live-sort',{sort:'score'});assert.notDeepEqual(ids(),before);
    const raw=adapter.leaderboard('eth','7',grouping).slice().sort((a,b)=>(a.ratio===null)-(b.ratio===null)||(a.ratio!==null&&b.ratio!==null?b.ratio-a.ratio:0)||(a.domain??a.ownerAddress).localeCompare(b.domain??b.ownerAddress));
    assert.deepEqual(ids(),raw.slice(0,20).map(r=>r.domain??r.ownerAddress));
    runtime.action('live-row-detail',{'group-key':ids()[0]});assert(runtime.dialog().includes('Verified recorded settlements'));
    assert(runtime.dialog().includes('does not certify every registered session'));runtime.action('close-dialog');
  }
});

 test('session and endpoint inspections expose recorded times and never infer eligible N or continuous ownership',async()=>{
  const runtime=await productRuntime('',{data:structuredClone(sampled),settlementData:proof,settlementReceipt:receipt,settlementTables:tables});
  runtime.action('open-network');runtime.review.state.serviceId='eth';runtime.review.state.serviceIds=['eth'];runtime.review.state.period='7';runtime.review.render();
  runtime.action('inspect-session',{session:proof.sessions[0].id});
  assert(runtime.dialog().includes('UTC session end'));assert(runtime.dialog().includes('Not inferred here'));
  assert(runtime.dialog().includes('Session end block'));assert(runtime.dialog().includes('Indexed claim records'));
  const member=proof.membershipCatalog[proof.sessions[0].members[0]],id=proof.supplierIds[member[0]];
  runtime.action('supplier-endpoints',{supplier:id});assert(runtime.dialog().includes('discrete selected-session observations'));
  assert(runtime.dialog().includes('no continuous association inferred'));assert(!runtime.dialog().includes('undefined'));
});
