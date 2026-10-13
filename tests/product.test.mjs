import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createIllustrativeAdapter} from '../src/adapter.js';
import {createAnalysisEngine,normaliseHost,hostMatches,ownerAt} from '../src/engine.js';

const data=JSON.parse(await readFile(new URL('../data/fictional-snapshot.json',import.meta.url),'utf8'));
const adapter=createIllustrativeAdapter(data),engine=createAnalysisEngine(data);
const query=(fleet,service=null,extra={})=>({scope:{type:'fleet',value:fleet},serviceId:service??adapter.getFleet(fleet).primary,period:'30',filters:[],...extra});
const close=(a,b,tolerance=1e-6)=>assert(Math.abs(a-b)<tolerance,`${a} differs from ${b}`);

test('fictional snapshot has coherent identities, eligibility, rosters and settled payouts',()=>{
  assert.equal(data.dataKind,'illustrative');assert.equal(data.fleets.length,8);
  assert.equal(data.services.length,18);assert.equal(data.sessions.length,8640);
  const suppliers=new Map(data.suppliers.map(s=>[s.id,s]));
  const populations=new Map(data.populations.map(p=>[p.id,p]));
  assert.equal(suppliers.size,data.suppliers.length);
  assert.equal(new Set(data.sessions.map(s=>s.id)).size,data.sessions.length);
  for(const s of data.suppliers) {
    assert(s.id.startsWith('demo:'));assert(s.endpointHosts.every(h=>h.endsWith('.example')));
    for(const owner of s.ownerHistory)assert(owner.ownerId.startsWith('demo:'));
  }
  for(const pop of data.populations) {
    assert(pop.totalEligible>=pop.eligibleSupplierIds.length);
    assert.equal(new Set(pop.eligibleSupplierIds).size,pop.eligibleSupplierIds.length);
    assert(pop.eligibleSupplierIds.every(id=>suppliers.get(id).serviceIds.includes(pop.serviceId)));
  }
  for(const session of data.sessions) {
    const pop=populations.get(session.populationId),eligible=new Set(pop.eligibleSupplierIds);
    assert.equal(session.serviceId,pop.serviceId);
    assert.equal(session.selectedCount,Math.min(pop.selectionCap,pop.totalEligible));
    if(session.rosterStatus==='complete') {
      assert(session.selectedSupplierIds.length<=session.selectedCount);
      assert.equal(new Set(session.selectedSupplierIds).size,session.selectedSupplierIds.length);
      assert(session.selectedSupplierIds.every(id=>eligible.has(id)));
    } else assert.equal(session.selectedSupplierIds,null);
    if(session.payoutStatus==='complete') {
      assert(session.supplierPayouts.every(p=>p.pokt>=0&&eligible.has(p.supplierId)));
      const sum=session.supplierPayouts.reduce((a,p)=>a+p.pokt,0);
      assert(sum<=session.totalPayoutPokt+1e-5);
      if(session.serviceId==='demo_testnet')close(sum,session.totalPayoutPokt,1e-5);
      if(session.rosterStatus==='complete')assert(session.supplierPayouts.every(p=>session.selectedSupplierIds.includes(p.supplierId)));
    } else {assert.equal(session.totalPayoutPokt,null);assert.equal(session.supplierPayouts,null);}
  }
});

test('all intended product states are derived from the records',()=>{
  const alder=adapter.getReport(query('alder'));
  assert.equal(alder.rewards.availability,'available');assert.equal(alder.rewards.direction,'above');
  assert.equal(adapter.getReport(query('moss')).rewards.availability,'limited');
  const juniper=adapter.getReport(query('juniper'));
  assert.equal(juniper.scope.supplierCount,1);assert.equal(juniper.rewards.availability,'available');
  assert.equal(adapter.getReport(query('tidal')).trend.variable,true);
  assert.deepEqual(adapter.getReport(query('cairn')).exposure.eligibleRange,[18,44]);
  const copper=adapter.getReport(query('copper'));
  assert.equal(copper.rewards.availability,'partial');assert(copper.evidence.pendingOutcomes>0);assert(copper.evidence.missingOutcomes>0);
  assert(copper.evidence.verifiedRosters<copper.evidence.recordedSessions);
  assert.equal(adapter.servicesFor({type:'fleet',value:'prism'}).length,18);
  const ineligible=adapter.getReport(query('prism','gnosis'));
  assert.equal(ineligible.rewards.availability,'unavailable');assert.equal(ineligible.scenarioReference.ownEligible,0);
  assert(ineligible.scope.identityCount>0);
});

test('search normalises URLs, respects domain boundaries and exposes shared-host subsets',()=>{
  assert.equal(normaliseHost(' HTTPS://ALDER.EXAMPLE/some/path '),'alder.example');
  assert.equal(normaliseHost('https://user:password@alder.example'),null);
  assert.equal(hostMatches('notalder.example','alder.example'),false);
  assert.equal(adapter.search('notalder.example').length,0);
  const shared=adapter.search('relay.shared.example');
  assert.equal(shared.length,3);assert.equal(shared[0].supplierCount,32);
  assert.deepEqual(shared.slice(1).map(s=>s.supplierCount).sort((a,b)=>a-b),[4,28]);
  const first=shared[0];
  const report=adapter.getReport({scope:first.scope,serviceId:first.primaryService,period:'30',filters:[]});
  assert.equal(report.scope.identityCount,32);assert.equal(report.scope.fleetNames.length,2);
  assert.equal(adapter.search('demo:juniper:supplier:001')[0].kind,'Supplier');
});

test('owner membership is historical and transferred identities are counted once',()=>{
  const supplier=data.suppliers.find(s=>s.fleetId==='cairn'&&s.ownerHistory.length>1);
  assert.equal(ownerAt(supplier,'2026-09-15'),'demo:cairn:owner:1');
  assert.equal(ownerAt(supplier,'2026-09-16'),'demo:cairn:owner:2');
  const q=query('cairn');
  const total=engine.framesFor(q);
  const one=engine.framesFor({...q,scope:{type:'owner',value:'demo:cairn:owner:1'}});
  const two=engine.framesFor({...q,scope:{type:'owner',value:'demo:cairn:owner:2'}});
  for(let i=0;i<total.length;i++) {assert.equal(one[i].n+two[i].n,total[i].n);assert.equal(one[i].X+two[i].X,total[i].X);close(one[i].actual+two[i].actual,total[i].actual);}
  assert(one[0].n>one.at(-1).n);
});

test('comparison uses ratios of totals, retains zeros and excludes unknown outcomes from both sides',()=>{
  for(const fleet of ['alder','copper','meridian']) {
    const q=query(fleet),report=adapter.getReport(q),frames=engine.framesFor(q);
    const included=frames.filter(f=>f.comparisonReady);
    close(report.rewards.actualPokt,included.reduce((a,f)=>a+f.actual,0));
    close(report.rewards.equalSharePokt,included.reduce((a,f)=>a+f.pool*f.X/f.K,0));
    close(report.rewards.ratio,report.rewards.actualPokt/report.rewards.equalSharePokt);
    const zero=frames.find(f=>f.comparisonReady&&f.pool===0);
    assert.equal(zero.actual,0);assert.equal(zero.reference,0);
    assert(frames.filter(f=>!f.comparisonReady).every(f=>f.actual===null&&f.reference===null));
  }
});

test('partitions reconcile and nested filters affect the complete analysis scope',()=>{
  const q=query('meridian'),total=adapter.getReport(q);
  const groups=adapter.getBreakdown(q,'infrastructure');
  close(groups.rows.reduce((sum,row)=>sum+row.actualPokt,0),total.rewards.actualPokt);
  close(groups.rows.reduce((sum,row)=>sum+row.equalSharePokt,0),total.rewards.equalSharePokt);
  const group=groups.rows[0],filtered={...q,filters:[{dimension:'infrastructure',value:group.id},{dimension:'gateway',value:data.gateways[0].id}]};
  const frames=engine.framesFor(filtered);
  assert(frames.length>0&&frames.every(f=>f.gatewayId===data.gateways[0].id));
  assert(adapter.suppliersFor(filtered).every(s=>s.groupId===group.id));
  const child=adapter.getReport(group.query);close(child.rewards.actualPokt,group.actualPokt);
  const gateways=adapter.getBreakdown(q,'gateway');
  assert(gateways.rows.find(row=>row.id==='unknown').recordedSessions>0);
  const host=adapter.getBreakdown(query('alder'),'hostname');assert.equal(host.overlapping,true);
});

test('periods and persistence use recorded dates and outcomes available before evaluation',()=>{
  const q=query('alder'),last=engine.framesFor({...q,period:'7'});
  assert.equal(last.length,7*16);assert(last.every(row=>row.startedAt>='2026-09-24T00:00:00.000Z'));
  assert.equal(adapter.getPersistenceDiagnostic({...q,period:'7'}).availability,'unavailable');
  const first=adapter.getPersistenceDiagnostic(q);assert.equal(first.availability,'available');assert.equal(first.testDays,15);
  const mutated=structuredClone(data);
  for(const s of mutated.sessions.filter(s=>s.serviceId===q.serviceId&&s.startedAt>='2026-09-16'))for(const p of s.supplierPayouts)p.pokt*=.5;
  const second=createIllustrativeAdapter(mutated).getPersistenceDiagnostic(q);
  close(first.earlierRatio,second.earlierRatio);assert(first.laterRatio!==second.laterRatio);
  const delayed=structuredClone(data);
  for(const s of delayed.sessions.filter(s=>s.startedAt<'2026-09-14'))s.outcomeAvailableAt='2026-10-02T00:00:00.000Z';
  assert.equal(createIllustrativeAdapter(delayed).getPersistenceDiagnostic(q).availability,'unavailable');
});

test('export retains the snapshot, active scope, complete session evidence and fictional disclosure',()=>{
  const result=adapter.exportResult(query('alder'),'gateway');
  assert.equal(result.snapshotId,data.snapshotId);assert.equal(result.sessionEvidence.length,480);
  assert.equal(result.breakdown.dimension,'gateway');assert(result.disclosure.includes('fictional'));
  assert.equal(result.dataKind,'illustrative');
});

test('multiple services combine POKT totals, pair days and count identities once',()=>{
  const scope={type:'fleet',value:'alder'},ids=adapter.servicesFor(scope).map(service=>service.id);
  assert(ids.length>1);
  const q={scope,serviceIds:ids,period:'30',filters:[]},report=adapter.getReport(q);
  const singles=ids.map(serviceId=>adapter.getReport({...q,serviceIds:[serviceId]}));
  const total=field=>singles.reduce((sum,row)=>sum+row.rewards[field],0);
  close(report.rewards.actualPokt,total('actualPokt'));close(report.rewards.equalSharePokt,total('equalSharePokt'));
  close(report.rewards.ratio,total('actualPokt')/total('equalSharePokt'));
  assert.equal(report.rewards.daily.length,30);assert.equal(report.rewards.informativeDays,30);
  assert.equal(report.scope.supplierCount,48);assert.equal(report.scope.latestEligibleCount,48);
  assert.equal(report.rewards.recordedSessions,ids.length*480);
  assert.equal(report.scenarioReference,null);assert.equal(report.scenarioReferences.length,ids.length);
  for(const ref of report.scenarioReferences){assert.equal(ref.ownEligible,48);assert(ref.totalEligible>=ref.ownEligible);}
  close(report.perService.reduce((sum,row)=>sum+row.actualPokt,0),report.rewards.actualPokt);
  const groups=adapter.getBreakdown(q,'service');close(groups.rows.reduce((sum,row)=>sum+row.equalSharePokt,0),report.rewards.equalSharePokt);
  const reordered=adapter.getReport({...q,serviceId:ids.at(-1),serviceIds:[...ids].reverse().concat(ids[0])});
  assert.deepEqual(report.rewards,reordered.rewards);
  const excluded=adapter.getReport({...q,serviceIds:ids.slice(1)});
  close(excluded.rewards.actualPokt,report.rewards.actualPokt-singles[0].rewards.actualPokt);
  assert.equal(excluded.rewards.recordedSessions,(ids.length-1)*480);
  assert.equal(adapter.suppliersFor(q).length,48);
  assert.throws(()=>adapter.getReport({...q,serviceIds:[]}),/empty service/);
  assert.throws(()=>adapter.getReport({...q,serviceIds:['unavailable-service']}),/Unknown/);
});

test('aggregate views retain partial service evidence and explicit network sample boundaries',()=>{
  const q=query('copper',null,{serviceIds:adapter.servicesFor({type:'fleet',value:'copper'}).map(service=>service.id)});
  const copper=adapter.getReport(q),partial=copper.perService.find(row=>row.id==='polygon');
  assert.equal(partial.availability,'partial');assert(partial.comparableSessions<partial.recordedSessions);
  assert(copper.evidence.missingOutcomes>0);assert(copper.evidence.pendingOutcomes>0);
  const network={scope:{type:'network',value:'illustrative-sample'},serviceIds:data.services.map(s=>s.id),period:'30',filters:[]};
  const report=adapter.getReport(network);
  assert.equal(report.scope.identityCount,305);assert.equal(report.scope.fleetNames.length,8);
  assert(report.scope.sampleNotice.includes('not a whole-network census'));
  assert.equal(report.rewards.recordedSessions,8640);assert.equal(report.services.length,18);
  assert.equal(report.rewards.daily.length,30);
  const fleets=adapter.getBreakdown(network,'fleet');assert.equal(fleets.rows.length,8);
  close(fleets.rows.reduce((sum,row)=>sum+row.actualPokt,0),report.rewards.actualPokt);
  close(fleets.rows.reduce((sum,row)=>sum+row.equalSharePokt,0),report.rewards.equalSharePokt);
  const selected=adapter.getReport({...network,filters:[{dimension:'fleet',value:'alder'},{dimension:'service',value:'bsc'}]});
  close(selected.rewards.actualPokt,adapter.getReport(query('alder','bsc')).rewards.actualPokt);
  assert.equal(selected.scope.supplierCount,48);
});


test('dated estimate series reconciles daily errors, session payout caps and the export',()=>{
  const q=query('alder'),result=adapter.getPersistenceDiagnostic(q),frames=engine.framesFor(q);
  assert.equal(result.trainingPeriod.endExclusive,'2026-09-14');assert.equal(result.testPeriod.start,'2026-09-16');
  assert.equal(result.daily.length,15);assert.equal(result.daily[0].date,'2026-09-16');
  assert.equal(result.daily.at(-1).date,'2026-09-30');
  for(const day of result.daily){
    const included=frames.filter(frame=>frame.date===day.date&&frame.comparisonReady);
    close(day.actualPokt,included.reduce((sum,frame)=>sum+frame.actual,0));
    close(day.equalSharePokt,included.reduce((sum,frame)=>sum+frame.reference,0));
    close(day.earlierEstimatePokt,included.reduce((sum,frame)=>sum+Math.min(frame.pool,result.earlierRatio*frame.reference),0));
    assert.equal(day.comparableSessions,included.length);
  }
  close(result.earlierDailyErrorPokt,result.daily.reduce((sum,day)=>sum+Math.abs(day.actualPokt-day.earlierEstimatePokt),0)/result.daily.length);
  close(result.equalDailyErrorPokt,result.daily.reduce((sum,day)=>sum+Math.abs(day.actualPokt-day.equalSharePokt),0)/result.daily.length);
  assert.deepEqual(adapter.exportResult(q,'gateway').earningsEstimate,result);
  const delayed=structuredClone(data);
  for(const s of delayed.sessions.filter(s=>s.startedAt<'2026-09-14'))s.outcomeAvailableAt='2026-10-02T00:00:00.000Z';
  assert.equal(createIllustrativeAdapter(delayed).exportResult(q,'gateway').earningsEstimate.availability,'unavailable');
});
