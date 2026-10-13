import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {createLiveAdapter} from '../src/adapter.js';
import {productRuntime} from './support/runtime.mjs';

const bytes=await readFile(new URL('../data/live-snapshot.json.gz',import.meta.url));
const wire=JSON.parse(gunzipSync(bytes));
const adapter=createLiveAdapter(structuredClone(wire));
const monthlyCheck=JSON.parse(await readFile(new URL('../data/monthly-claims-diagnostic.json',import.meta.url)));
const close=(a,b)=>assert(Math.abs(a-b)<1e-6,`${a} != ${b}`);

test('the product serves the exact completed uploaded month, not the pilot fixture',()=>{
  assert.equal(createHash('sha256').update(bytes).digest('hex'),'059ffa4dba60e0c4e3f0f3810cdf778c87d09560c65a701735de5777b84b3b57');
  assert.equal(wire.period.start,'2026-09-06T00:00:00Z');
  assert.equal(wire.period.endExclusive,'2026-10-06T00:00:00Z');
  assert.equal(wire.populations.length,960);assert.equal(wire.sessions.length,4080);
  assert.equal(new Set(wire.populations.map(p=>p.scheduledAt)).size,120);
  assert.equal(wire.liveSource.extension,undefined);
});

test('coverage diagnoses the concentration of absent claims without excluding Application groups',()=>{
  const d=adapter.coverageDiagnostics();
  assert.equal(d.covered,1652);assert.equal(d.unknown,2428);
  assert.equal(d.applications.length,34);assert.equal(d.neverCoveredGroups,19);
  assert.equal(d.unknownInNeverCoveredGroups,2280);
  assert.equal(d.services.reduce((n,s)=>n+s.noIndexedClaims,0),2428);
  assert.equal(d.services.reduce((n,s)=>n+s.unverifiedClaims,0),0);
  assert(d.services.every(s=>s.coverage<.9));
  assert.equal(adapter.coverageDiagnostics('7').sessions,952);
  assert.equal(adapter.coverageDiagnostics('14').sessions,1904);
});

test('full-month claim evidence preserves all eligibility denominators and keeps the restricted view explicit',()=>{
  const checked=createLiveAdapter(structuredClone(wire),monthlyCheck),d=checked.coverageDiagnostics();
  assert.equal(d.sessions,4080);assert.equal(d.covered,1652);assert.equal(d.unknown,2428);
  const m=d.monthlyActivity;
  assert.equal(m.groupsWithClaims,15);assert.equal(m.groupsWithoutClaims,19);
  assert.equal(m.monthlyClaimRecords,851096);assert.equal(m.recheckedSampledClaimRecords,47880);
  assert.equal(m.sampledInGroupsWithClaims,1800);assert.equal(m.coveredInGroupsWithClaims,1652);assert.equal(m.unknownInGroupsWithClaims,148);
  close(m.coverageInGroupsWithClaims,1652/1800);
  assert.equal(checked.coverageDiagnostics('7').monthlyActivity,undefined);
  assert.equal(checked.coverageDiagnostics('14').monthlyActivity,undefined);
  assert(checked.leaderboard('eth','30','domain').every(r=>r.availability!=='available'));
});

test('claim-check evidence from another frame or changed sampled count is rejected',()=>{
  for(const mutate of [c=>c.cutoff++,c=>c.groups.pop(),c=>c.groups[0].recheckedSampledClaimCount++]){
    const wrong=structuredClone(monthlyCheck);mutate(wrong);
    assert.throws(()=>createLiveAdapter(structuredClone(wire),wrong),/different snapshot|reconcile|incomplete/);
  }
  assert.equal(createHash('sha256').update(bytes).digest('hex'),monthlyCheck.productSha256);
});

test('coverage drawer distinguishes counted monthly claims from collected sampled payouts',async()=>{
  const r=await productRuntime('',{data:structuredClone(wire),monthlyCheck});
  r.action('live-coverage');
  assert(r.dialog().includes('851,096 monthly claim records'));
  assert(r.dialog().includes('1,652 / 1,800'));
  assert(r.dialog().includes('91.8%'));
  assert(r.dialog().includes('40.5%'));
  assert(r.dialog().includes('Additional monthly payout details have not been installed'));
  assert(r.dialog().includes('Indexed monthly claims'));
  assert.equal((r.dialog().match(/class="coverage-detail"/g)??[]).length,8);
  r.action('about');assert(r.dialog().includes('Each group&#39;s original sampled count')||r.dialog().includes("Each group's original sampled count"));
});

test('7, 14 and 30-day saved comparison rows reconcile with the existing engine',()=>{
  for(const period of ['7','14','30'])for(const service of wire.services)for(const grouping of ['owner','domain']){
    const rows=adapter.leaderboard(service.id,period,grouping);
    assert(rows.length>0);assert(rows.every(r=>r.availability!=='available'));
    for(const row of [rows[0],rows.at(-1)]){
      const r=adapter.getReport({scope:row.scope,serviceId:service.id,period,filters:[]}).rewards;
      close(r.actualPokt??0,row.actualPokt);close(r.equalSharePokt??0,row.equalSharePokt);
      close(r.coverage,row.coverage);assert.equal(r.ratio,row.ratio);
    }
  }
});

test('monthly discovery stays concise and explains full collection versus unknown earnings',async()=>{
  const r=await productRuntime('',{data:structuredClone(wire)});
  assert(r.html().includes('30 days · 8 services'));
  assert(!r.html().includes('collection pending'));
  assert.equal((r.html().match(/class="example-card"/g)??[]).length,4);
  assert(!r.html().includes('class="leaderboard-table'));
  r.action('about');assert(r.dialog().includes('2,428 outcomes remain unknown'));
  r.action('live-coverage');assert(r.dialog().includes('19 of 34'));
  assert(r.dialog().includes('2,280 of 2,428'));
  assert(r.dialog().includes('not establish zero income'));
  assert.equal((r.dialog().match(/class="coverage-detail"/g)??[]).length,8);
  r.action('close-dialog');
  for(const name of ['nodefleet','kleomedes'])assert(r.review.adapter.search(name).length>0);
});

test('F ordering changes the monthly table for both grouping modes and all periods',async()=>{
  const r=await productRuntime('',{data:structuredClone(wire)});
  r.action('live-discovery-view',{view:'compare'});
  for(const grouping of ['owner','domain']){
    r.action('live-grouping',{grouping,groupingContext:'comparison'});
    for(const period of ['7','14','30']){
      r.field('leaderboard-period',period);
      r.field('leaderboard-service','eth');
      const keys=()=>[...r.html().matchAll(/data-comparison-group="([^"]+)"/g)].map(m=>m[1]);
      r.action('live-sort',{sort:'earnings'});const earnings=keys();
      r.action('live-sort',{sort:'score'});const score=keys();
      assert.notDeepEqual(score,earnings);
      const rows=r.review.adapter.leaderboard('eth',period,grouping);
      const byKey=new Map(rows.map(row=>[row.domain??row.ownerAddress,row]));
      for(let i=1;i<score.length;i++)assert((byKey.get(score[i-1]).ratio??-Infinity)>=(byKey.get(score[i]).ratio??-Infinity));
      assert(r.html().includes('aria-sort="descending">F score'));
      assert(r.html().includes('No groups meet ranking criteria yet'));
    }
  }
});
