import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {createAnalysisEngine,normaliseHost} from '../src/engine.js';
import {createIllustrativeAdapter,createLiveAdapter} from '../src/adapter.js';
import {productRuntime} from './support/runtime.mjs';

const fixture=JSON.parse(await readFile(new URL('../data/fictional-snapshot.json',import.meta.url),'utf8'));
const live=JSON.parse(gunzipSync(await readFile(new URL('../data/live-snapshot.json.gz',import.meta.url))));
const q={scope:{type:'fleet',value:'alder'},serviceId:'eth',period:'30',filters:[]};

test('the earnings test retains missing and late training outcomes in coverage',()=>{
  const data=structuredClone(fixture),adapter=createIllustrativeAdapter(data);
  const query={...q,serviceId:adapter.getFleet('alder').primary};
  assert.equal(adapter.getPersistenceDiagnostic(query).availability,'available');
  const train=data.sessions.filter(s=>s.serviceId===query.serviceId&&s.startedAt<'2026-09-14');
  for(let i=0;i<train.length;i++)if(i%4===0)train[i].outcomeAvailableAt='2026-10-02T00:00:00Z';
  assert.equal(createIllustrativeAdapter(data).getPersistenceDiagnostic(query).availability,'unavailable');
  for(let i=0;i<train.length;i++)if(i%4===0){train[i].payoutStatus='missing';train[i].outcomeAvailableAt=null;train[i].totalPayoutPokt=null;train[i].supplierPayouts=null;}
  assert.equal(createIllustrativeAdapter(data).getPersistenceDiagnostic(query).availability,'unavailable');
});

test('selection references remain chronological when populations arrive out of order',()=>{
  const original=createAnalysisEngine(fixture),reordered=structuredClone(fixture);reordered.populations.reverse();
  const other=createAnalysisEngine(reordered),query={...q,serviceId:fixture.fleets.find(f=>f.id==='alder').primary};
  assert.deepEqual(other.latestReference(query),original.latestReference(query));
  assert.equal(other.report(query).scope.latestEligibleCount,original.report(query).scope.latestEligibleCount);
});

test('comparison inspection dates and opened analysis retain the selected period',async()=>{
  const r=await productRuntime('',{data:structuredClone(live)});r.action('live-discovery-view',{view:'compare'});
  r.field('leaderboard-period','7');r.field('leaderboard-service','eth');
  const group=r.review.adapter.leaderboard('eth','7','domain')[0].domain;
  r.action('live-row-detail',{'group-key':group});
  assert(/29 Sept? – 5 Oct 2026/.test(r.dialog()));assert(!/6 Sept? – 5 Oct 2026/.test(r.dialog()));
  r.action('live-open-domain',{domain:group});
  assert.equal(r.review.report.period.requestedDays,7);
});

test('IP and single-label host searches retain their hostname identity',()=>{
  const data=structuredClone(fixture),supplier=data.suppliers.find(s=>s.fleetId==='juniper');
  supplier.endpointHosts=['2001:db8::1','localhost'];
  assert.equal(normaliseHost('https://[2001:db8::1]:443/rpc'),'2001:db8::1');
  assert.equal(normaliseHost('2001:db8::1'),'2001:db8::1');
  assert.equal(normaliseHost('https://user:password@[2001:db8::1]'),null);
  const adapter=createIllustrativeAdapter(data);
  for(const text of ['2001:db8::1','https://[2001:db8::1]/rpc','localhost']){
    const match=adapter.search(text)[0];assert.equal(match.scope.type,'hostname');assert.equal(match.supplierCount,1);
  }
});

test('paginated Supplier breakdowns match complete results and retain total counts',()=>{
  const adapter=createIllustrativeAdapter(fixture),query={...q,scope:{type:'fleet',value:'meridian'},serviceId:fixture.fleets.find(f=>f.id==='meridian').primary};
  const page=adapter.getBreakdown(query,'supplier',{limit:24}),full=adapter.getBreakdown(query,'supplier');
  assert.equal(page.rows.length,24);assert.equal(page.totalGroups,full.rows.length);
  assert.deepEqual(page.rows,full.rows.slice(0,24));
  assert.equal(adapter.exportResult(query,'supplier').breakdown.rows.length,full.rows.length);
});

test('encoded historical populations reject invalid identities and share identical sets',()=>{
  const data=structuredClone(live);
  data.populations.push({...structuredClone(data.populations[0]),id:'audit-identical-population'});
  createLiveAdapter(data);
  assert.equal(data.populations.at(-1).eligibleSupplierIds,data.populations[0].eligibleSupplierIds);
  for(const bad of [-1,live.suppliers.length,1.5]){
    const wrong=structuredClone(live);wrong.populations[0].eligibleSupplierIndices[0]=bad;
    assert.throws(()=>createLiveAdapter(wrong),/encoded historical/);
  }
});
