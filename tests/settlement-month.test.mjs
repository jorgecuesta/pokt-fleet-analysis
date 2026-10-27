/** Integration checks against the user's actual reconciled month, never generated data. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {createSettlementSource} from '../src/settlements.js';
import {createLiveAdapter} from '../src/adapter.js';
import {productRuntime} from './support/runtime.mjs';

const read=async p=>JSON.parse(p.endsWith('.gz')?gunzipSync(await readFile(new URL(p,import.meta.url))):await readFile(new URL(p,import.meta.url),'utf8'));
const sampled=await read('../data/live-snapshot.json.gz'),wire=await read('../data/settlement-month.json.gz'),receipt=await read('../data/settlement-month-receipt.json');
const tables=await read('../data/settlement-tables.json.gz'),independent=await read('../data/settlement-month-owner-analysis.json');
const ids=sampled.services.map(s=>s.id),source=createSettlementSource(sampled,wire,receipt),adapter=createLiveAdapter(sampled,null,wire,receipt,tables);
const q=(scope={type:'network',value:'live-sample'},extra={})=>({scope,serviceId:'eth',serviceIds:ids,period:'30',filters:[],...extra});
const close=(a,b)=>assert(Math.abs(a-b)<=Math.max(1e-8,Math.abs(b)*1e-11),`${a} differs from ${b}`);
const datesFor=period=>new Date(+new Date(wire.config.endExclusive)-Number(period)*86400000).toISOString().slice(0,10);

test('the actual monthly source, receipt, immutable sample and shipped table hashes agree',async()=>{
  const sha=async p=>createHash('sha256').update(await readFile(new URL(p,import.meta.url))).digest('hex');
  assert.equal(await sha('../data/live-snapshot.json.gz'),'feeebfbb120044a782dd60f1879c0613924cb259b7eb528d5f74659055842088');
  assert.equal(await sha('../data/settlement-month.json.gz'),tables.packedSha256);
  assert.equal(wire.sessions.length,29448);assert.equal(source.info.claims,851096);
  assert.equal(source.info.verifiedSessions,29448);assert.equal(receipt.coverage.unknownDistributionClaims,0);
  assert.equal(receipt.overlap.sampledSessionsChecked,4080);assert.equal(receipt.overlap.coveredSessionsReconciled,1652);
  assert.deepEqual(adapter.coverageDiagnostics().unknown,2428);
  assert.equal((await read('../data/settlement-integration.json')).fortnightReceiptVerified,true);
});

test('all 765 actual service-subset and period views conserve the independently summed indexed pool',()=>{
  const sums=new Map();
  for(const period of ['7','14','30'])for(const id of ids){
    const rows=wire.sessions.filter(r=>r.serviceId===id&&r.endedAt.slice(0,10)>=datesFor(period));
    sums.set(`${period}:${id}`,{n:rows.length,upokt:rows.reduce((n,r)=>n+BigInt(r.poolUpokt),0n)});
  }
  let cases=0;
  for(let mask=1;mask<256;mask++)for(const period of ['7','14','30']){
    const selected=ids.filter((_,i)=>mask&(1<<i)),frames=source.framesFor(q(undefined,{serviceIds:selected,period}));
    assert.equal(frames.length,selected.reduce((n,id)=>n+sums.get(`${period}:${id}`).n,0));
    assert.equal(new Set(frames.map(f=>f.sessionId)).size,frames.length);
    const expected=Number(selected.reduce((n,id)=>n+sums.get(`${period}:${id}`).upokt,0n))/1e6;
    close(frames.reduce((n,f)=>n+f.actual,0),expected);close(frames.reduce((n,f)=>n+f.reference,0),expected);
    assert(frames.every(f=>f.N===null&&f.n===null&&f.populationId===null));cases++;
  }
  assert.equal(cases,765);
});

test('all 198 monthly owner partitions agree with independent Python integer and Fraction results',()=>{
  const groups=source.groupRewards(q(),'owner');assert.equal(groups.size,198);
  for(const row of independent.rows){
    const group=groups.get(row.label);assert(group);
    close(group.totals.actual,Number(BigInt(row.actualUpokt))/1e6);
    close(group.totals.reference,Number(row.equalShareUpokt.numerator)/Number(row.equalShareUpokt.denominator)/1e6);
    assert.equal(group.daily.filter(d=>d.reference>0).length,row.informativeDays);
    assert.equal(group.daily.reduce((n,d)=>n+d.positiveSessions,0),row.positiveSessions);
  }
  const total=Number(wire.sessions.reduce((n,r)=>n+BigInt(r.poolUpokt),0n))/1e6;
  close([...groups.values()].reduce((n,g)=>n+g.totals.actual,0),total);
  close([...groups.values()].reduce((n,g)=>n+g.totals.reference,0),total);
});

test('all monthly precomputed owner and domain rows reconcile across eight services and three periods',()=>{
  for(const id of ids)for(const period of ['7','14','30'])for(const dimension of ['owner','domain']){
    const query=q(undefined,{serviceId:id,serviceIds:[id],period}),groups=source.groupRewards(query,dimension),rows=adapter.leaderboard(id,period,dimension);
    assert.equal(rows.length,groups.size);
    for(const row of rows){
      const group=groups.get(row.domain??row.ownerAddress);assert(group);
      close(row.actualPokt,group.totals.actual);close(row.equalSharePokt,group.totals.reference);
      close(row.ratio,row.actualPokt/row.equalSharePokt);
      assert.equal(row.recordedSessions,group.recordedSessions);assert.equal(row.coverage,1);
      assert.equal(row.informativeDays,group.daily.filter(d=>d.reference>0).length);
      assert.equal(row.positiveSessions,group.daily.reduce((n,d)=>n+d.positiveSessions,0));
    }
  }
});

test('monthly ownership, service endpoints and nested time, Application and selection filters retain exact rosters',()=>{
  const raw=wire.sessions.find(r=>r.serviceId==='eth'),member=wire.membershipCatalog[raw.members[0]],endpoint=wire.endpointCatalog[member[2][0]];
  const scopes=[{type:'owner',value:wire.ownerIds[member[1]]},{type:'supplier',value:wire.supplierIds[member[0]]},
    {type:'hostname',value:endpoint.hostname},{type:'domain',value:endpoint.registrableDomain}];
  const match=(m,s)=>s.type==='owner'?wire.ownerIds[m[1]]===s.value:s.type==='supplier'?wire.supplierIds[m[0]]===s.value:
    m[2].some(i=>s.type==='hostname'?wire.endpointCatalog[i].hostname===s.value:
      wire.endpointCatalog[i].hostname===s.value||wire.endpointCatalog[i].hostname?.endsWith('.'+s.value));
  const rawById=new Map(wire.sessions.map(r=>[r.id,r]));
  for(const scope of scopes)for(const period of ['7','30']){
    const query=q(scope,{serviceIds:['eth','bsc'],period,filters:[{dimension:'owner',value:wire.ownerIds[member[1]]}]}),frames=source.framesFor(query);
    for(const frame of frames){
      const row=rawById.get(frame.sessionId),own=new Set(row.members.map(i=>wire.membershipCatalog[i]).filter(m=>match(m,scope)&&wire.ownerIds[m[1]]===wire.ownerIds[member[1]]).map(m=>m[0]));
      assert.equal(frame.X,own.size);close(frame.actual,row.payouts.reduce((n,[id,v])=>n+(own.has(id)?Number(v):0),0)/1e6);
      close(frame.reference,Number(row.poolUpokt)*own.size/row.selectedCount/1e6);
    }
  }
  const cases=[{dimension:'application',value:raw.applicationId},{dimension:'hour',value:'18'},
    {dimension:'week',value:'3'},{dimension:'session_value',value:'high'},{dimension:'selected_count',value:'1'}];
  for(const filter of cases){
    const frames=source.framesFor(q(scopes[1],{filters:[filter]}));
    for(const f of frames){
      if(filter.dimension==='application')assert.equal(f.applicationId,filter.value);
      if(filter.dimension==='hour')assert.equal(Math.floor(new Date(f.startedAt).getUTCHours()/6)*6,18);
      if(filter.dimension==='week')assert.equal(Math.floor((+new Date(f.date)-+new Date(sampled.period.start))/604800000),3);
      if(filter.dimension==='session_value')assert(f.pool>500);
      if(filter.dimension==='selected_count')assert.equal(f.X,1);
    }
  }
  const known=new Set(wire.sessions.map(r=>r.applicationId));
  const absent=sampled.applications.find(a=>!known.has(a.id));assert(absent);
  assert.equal(adapter.getReport(q(undefined,{filters:[{dimension:'application',value:absent.id}]})).rewards.availability,'unavailable');
  const extra=wire.endpointCatalog.find(e=>!sampled.endpointCatalog.some(old=>old.id===e.id));assert(extra);
  assert.equal(extra.hostname,'bsc.pocket.kleomedes.network');assert(adapter.search(extra.hostname).length>0);
});

test('actual monthly historical tests work for Kleomedes in all eight services and stay unavailable for short periods',()=>{
  for(const serviceId of ids){
    const query=q({type:'domain',value:'kleomedes.network'},{serviceId,serviceIds:[serviceId]});
    assert.equal(adapter.getPersistenceDiagnostic(query).availability,'available',serviceId);
    for(const period of ['7','14'])assert.equal(adapter.getPersistenceDiagnostic({...query,period}).availability,'unavailable');
  }
});

test('monthly controller F sorting changes ordering in every service and period for owner and domain comparisons',async()=>{
  const runtime=await productRuntime('',{data:sampled,settlementData:wire,settlementReceipt:receipt,settlementTables:tables});
  runtime.action('live-discovery-view',{view:'compare'});
  const visible=()=>[...runtime.html().matchAll(/data-comparison-group="([^"]+)"/g)].map(m=>m[1]);
  for(const grouping of ['owner','domain']){
    runtime.action('live-grouping',{grouping,'grouping-context':'comparison'});
    for(const serviceId of ids)for(const period of ['7','14','30']){
      runtime.field('leaderboard-service',serviceId);runtime.field('leaderboard-period',period);
      runtime.action('live-sort',{sort:'earnings'});const before=visible();
      runtime.action('live-sort',{sort:'score'});const after=visible();
      const expected=adapter.leaderboard(serviceId,period,grouping).slice().sort((a,b)=>(a.ratio===null)-(b.ratio===null)||(a.ratio!==null&&b.ratio!==null?b.ratio-a.ratio:0)||(a.domain??a.ownerAddress).localeCompare(b.domain??b.ownerAddress));
      assert.deepEqual(after,expected.slice(0,20).map(r=>r.domain??r.ownerAddress));
      assert.notDeepEqual(after,before,`${serviceId}/${period}/${grouping}`);assert(!runtime.html().includes('NaN'));
    }
  }
});

test('monthly pagination and exports preserve every financial group and separate original selection evidence',()=>{
  const query=q({type:'domain',value:'kleomedes.network'},{serviceIds:['eth'],serviceId:'eth'});
  const page=adapter.getBreakdown(query,'supplier',{limit:24}),full=adapter.getBreakdown(query,'supplier');
  assert.equal(page.rows.length,Math.min(24,full.rows.length));assert.equal(page.totalGroups,full.rows.length);
  assert.deepEqual(page.rows,full.rows.slice(0,24));assert(page.rows.every(r=>r.exposure===null&&r.exposureNotice));
  const exported=adapter.exportResult(query,'owner');
  assert.equal(exported.recordedSettlementEvidence.sessions.length,5745);
  assert(exported.selectionEvidence.length>0);assert(exported.recordedSettlementEvidence.membershipCatalog.length>0);
  assert.equal(exported.settlementReceipt.coverage.indexedClaims,851096);
  assert.equal(exported.disclosure,wire.notice);
});
