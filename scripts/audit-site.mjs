/** Independent totals, identity attribution and complete service-subset audit. */
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {createAnalysisEngine} from '../src/engine.js';
import {createLiveAdapter} from '../src/adapter.js';
import {productRuntime} from '../tests/support/runtime.mjs';

const root=new URL('../',import.meta.url),started=performance.now();
const data=JSON.parse(gunzipSync(await readFile(new URL('data/live-snapshot.json.gz',root))));
const adapter=createLiveAdapter(data),engine=createAnalysisEngine(data);
const suppliers=new Map(data.suppliers.map(s=>[s.id,s])),populations=new Map(data.populations.map(p=>[p.id,p]));
const sessions=new Map(data.sessions.map(s=>[s.id,s])),endpoints=new Map(data.endpointCatalog.map(e=>[e.id,e]));
const services=data.services.map(s=>s.id).sort();
const near=(a,b)=>assert(Math.abs(a-b)<=1e-7*Math.max(1,Math.abs(a),Math.abs(b)),`${a} != ${b}`);
const network={type:'network',value:data.networkScopeValue};
let subsetCases=0,scopeCases=0,frameChecks=0,partitionCases=0,controllerViews=0;

function directMember(id,scope,date,service){
  const supplier=suppliers.get(id),at=+new Date(date);
  if(scope.type==='network')return true;
  if(scope.type==='supplier')return id===scope.value;
  const owner=supplier.ownerHistory.find(h=>+new Date(h.start)<=at&&(!h.end||at<+new Date(h.end)))?.ownerId;
  if(scope.type==='owner')return owner===scope.value;
  const history=supplier.endpointHistory.find(h=>+new Date(h.start)<=at&&(!h.end||at<+new Date(h.end)));
  const hosts=(history?.endpointIds??[]).map(id=>endpoints.get(id)).filter(e=>e.serviceId===service).map(e=>e.hostname).filter(Boolean);
  return scope.type==='hostname'?hosts.includes(scope.value):hosts.some(h=>h===scope.value||h.endsWith('.'+scope.value));
}

// All 255 nonempty subsets, each under 7/14/30-day windows. Compare combined
// totals with independently added single-service source frames, not mean F.
for(const period of ['7','14','30']){
  const singles=new Map(services.map(serviceId=>[serviceId,engine.framesFor({scope:network,serviceId,period,filters:[]})]));
  for(let mask=1;mask<2**services.length;mask++){
    const ids=services.filter((_,i)=>mask&(1<<i));
    const frames=engine.framesFor({scope:network,serviceIds:ids,period,filters:[]});
    const expected=ids.flatMap(id=>singles.get(id));
    assert.equal(frames.length,expected.length);assert.equal(new Set(frames.map(f=>f.sessionId)).size,frames.length);
    for(const field of ['actual','reference','X'])near(frames.reduce((n,f)=>n+(f[field]??0),0),expected.reduce((n,f)=>n+(f[field]??0),0));
    assert.equal(frames.filter(f=>f.comparisonReady).length,expected.filter(f=>f.comparisonReady).length);
    subsetCases++;
  }
  console.log(`All service subsets checked for ${period} days`);
}

const domains=adapter.domainDirectory().sort((a,b)=>b.supplierCount-a.supplierCount);
const owners=adapter.directory().sort((a,b)=>b.supplierCount-a.supplierCount);
const scopes=[network,domains[0].scope,domains.at(-1).scope,{type:'hostname',value:domains[0].hostnames[0]},
  {type:'owner',value:owners[0].ownerAddress},{type:'owner',value:owners.at(-1).ownerAddress},
  {type:'supplier',value:data.suppliers[0].id}];
for(const period of ['7','14','30'])for(const serviceId of services)for(const scope of scopes){
  const frames=engine.framesFor({scope,serviceId,period,filters:[]});
  for(const frame of frames){
    const session=sessions.get(frame.sessionId),population=populations.get(frame.populationId);
    const selected=session.selectedSupplierIds.filter(id=>directMember(id,scope,population.observedAt,serviceId));
    assert.equal(frame.X,selected.length);assert(frame.X<=frame.n&&frame.n<=frame.N);
    if(frame.comparisonReady){
      const chosen=new Set(selected);
      const actual=session.supplierPayouts.filter(p=>chosen.has(p.supplierId)).reduce((n,p)=>n+p.pokt,0);
      near(frame.actual,actual);near(frame.reference,session.totalPayoutPokt*selected.length/session.selectedCount);
    }else{assert.equal(frame.actual,null);assert.equal(frame.reference,null);}
    frameChecks++;
  }
  // Independent eligible membership on both historical boundaries.
  for(const population of data.populations.filter(p=>p.serviceId===serviceId).filter((_,i,a)=>i===0||i===a.length-1)){
    assert.equal(engine.eligibleIds(population,{scope,serviceId,period,filters:[]}).length,
      population.eligibleSupplierIds.filter(id=>directMember(id,scope,population.observedAt,serviceId)).length);
  }
  scopeCases++;
}
console.log('Owner, domain, hostname and Supplier attribution checked independently');

// These are disjoint partitions. Endpoint groups deliberately remain overlap
// groups and are excluded from additive partition claims.
const query={scope:domains[0].scope,serviceIds:['base','eth'],period:'30',filters:[]};
const all=engine.framesFor(query),covered=all.filter(f=>f.comparisonReady);
for(const dimension of ['service','application','week','hour','selected_count']){
  const groups=adapter.getBreakdown(query,dimension),rows=groups.rows;
  near(rows.reduce((n,r)=>n+(r.actualPokt??0),0),covered.reduce((n,f)=>n+f.actual,0));
  near(rows.reduce((n,r)=>n+(r.equalSharePokt??0),0),covered.reduce((n,f)=>n+f.reference,0));
  assert.equal(rows.reduce((n,r)=>n+r.recordedSessions,0),all.length);partitionCases++;
}
for(const dimension of ['hostname','domain'])assert.equal(adapter.getBreakdown(query,dimension,{limit:24}).overlapping,true);
const full=adapter.getReport(query),parts=full.perService;
near(full.rewards.actualPokt,parts.reduce((n,r)=>n+(r.actualPokt??0),0));
near(full.rewards.equalSharePokt,parts.reduce((n,r)=>n+(r.equalSharePokt??0),0));
near(full.rewards.ratio,full.rewards.actualPokt/full.rewards.equalSharePokt);

// Exercise each available dimension through the real controller and generated
// UI, then keep no-matching-session and multiple-filter states inspectable.
const runtime=await productRuntime('',{data:structuredClone(data)});
runtime.action('live-open-owner',{owner:owners.at(-1).ownerAddress});
for(const view of ['summary','breakdown','predictions','diagnostics']){
  runtime.action('view',{view});if(view==='diagnostics')runtime.timers();
  assert(!/\bNaN\b|\bundefined\b|Infinity/.test(runtime.html()));controllerViews++;
}
runtime.action('view',{view:'breakdown'});
for(const dimension of ['service','hostname','domain','owner','supplier','application','week','hour','selected_count','session_value']){
  runtime.field('dimension-select',dimension);
  assert(!/\bNaN\b|\bundefined\b|Infinity/.test(runtime.html()));controllerViews++;
}
runtime.action('filter-group',{dimension:'application',value:'not-in-this-snapshot'});
assert.equal(runtime.review.report.rewards.availability,'unavailable');assert.equal(runtime.review.report.evidence.recordedSessions,0);
runtime.action('clear-filters');
runtime.action('service');runtime.action('clear-services');
assert.equal(runtime.nodes.get('apply-services').disabled,true);

const result={asOfDate:'2026-10-10',snapshotId:data.snapshotId,services,periods:['7','14','30'],
  status:'passed',serviceSubsetCases:subsetCases,historicalScopeCases:scopeCases,independentFrameChecks:frameChecks,
  additivePartitionCases:partitionCases,controllerViews,seconds:Math.round((performance.now()-started)/10)/100,
  limits:['No browser layout, native clipboard/download or native modal verification in this environment.',
    'This finite matrix covers every nonempty subset of the eight services; it is not a proof of every possible filter combination.',
    'Settlement expansion is a separate live proof and does not silently change the sampled coverage denominator.']};
await writeFile(new URL('docs/site-audit-results.json',root),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
