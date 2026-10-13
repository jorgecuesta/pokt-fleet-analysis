import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {createLiveAdapter} from '../src/adapter.js';
import {productRuntime} from './support/runtime.mjs';

const wire=JSON.parse(gunzipSync(await readFile(new URL('./fixtures/live-pilot.json.gz',import.meta.url))));
const fixture=()=>structuredClone(wire);
const close=(a,b)=>assert(Math.abs(a-b)<1e-7,`${a} != ${b}`);

test('live evidence has complete rosters and excludes unknown payouts from both amounts',()=>{
  const data=fixture(),adapter=createLiveAdapter(data);
  assert.equal(data.sessions.length,136);
  assert.equal(data.liveSource.coverage.comparableSessions,53);
  assert.equal(data.liveSource.registeredServiceCount,264);
  const populations=new Map(data.populations.map(p=>[p.id,p]));
  for(const s of data.sessions){
    const pop=populations.get(s.populationId);
    assert.equal(s.selectedCount,new Set(s.selectedSupplierIds).size);
    assert.equal(s.selectedCount,Math.min(pop.selectionCap,pop.totalEligible));
    assert(s.selectedSupplierIds.every(id=>pop.eligibleSupplierIds.includes(id)));
    if(s.payoutStatus==='complete')close(s.totalPayoutPokt,s.supplierPayouts.reduce((sum,p)=>sum+p.pokt,0));
    else{assert.equal(s.totalPayoutPokt,null);assert.deepEqual(s.supplierPayouts,[]);}
  }
  const report=adapter.getReport({scope:{type:'network',value:'live-sample'},serviceIds:data.services.map(s=>s.id),period:'30',filters:[]});
  close(report.rewards.actualPokt,data.sessions.filter(s=>s.payoutStatus==='complete').reduce((sum,s)=>sum+s.totalPayoutPokt,0));
  close(report.rewards.actualPokt,report.rewards.equalSharePokt);
  close(report.rewards.ratio,1);
  assert.notEqual(report.rewards.availability,'available');
});

test('each service table agrees with fleet analysis and sparse rows receive no ranks',()=>{
  const data=fixture(),adapter=createLiveAdapter(data);
  for(const service of data.services){
    const rows=adapter.leaderboard(service.id);
    assert(rows.length>0);
    assert(rows.every(row=>row.availability!=='available'&&row.intervalRatio===null));
    for(const row of rows.filter((_,i)=>i%17===0)){
      const report=adapter.getReport({scope:{type:'fleet',value:row.fleetId},serviceId:service.id,period:'30',filters:[]});
      close(row.actualPokt,report.rewards.actualPokt??0);
      close(row.equalSharePokt,report.rewards.equalSharePokt??0);
      close(row.coverage,report.rewards.coverage);
      assert.equal(row.ratio,report.rewards.ratio);
      assert.equal(row.informativeDays,report.rewards.informativeDays);
    }
  }
});

test('live discovery discloses real coverage and offers address lookup and service comparisons',async()=>{
  const r=await productRuntime('',{data:fixture()});
  assert(r.html().includes('Mainnet snapshot'));
  assert(r.html().includes('1 day · 8 services'));
  assert(r.html().includes('30-day collection pending'));
  assert(!r.html().includes('class="leaderboard-table'));
  assert.equal((r.html().match(/class="example-card"/g)??[]).length,4);
  r.action('live-discovery-view',{view:'compare'});
  assert(r.html().includes('No groups meet ranking criteria yet'));
  assert.equal(r.nodes.get('leaderboard-period').children.length,1);
  assert(r.nodes.get('leaderboard-period').disabled);
  r.action('live-catalog');assert(r.dialog().includes('95% target was not reached'));assert(r.dialog().includes('arb_one'));
  r.action('about');assert(r.dialog().includes('83 outcomes remain unknown'));assert(r.dialog().includes('no automatic refresh'));assert(r.dialog().includes('30-day expansion is pending'));assert(r.dialog().includes('86.1%'));
  r.action('close-dialog');
  r.action('live-discovery-view',{view:'explore'});
  const fleet=r.review.adapter.directory().sort((a,b)=>b.supplierCount-a.supplierCount)[0];
  r.field('fleet-search',fleet.ownerAddress,'input');
  assert(r.nodes.get('search-results').innerHTML.includes('Owner address'));
  r.action('search-match',{index:0});
  assert.equal(r.review.report.scope.value,fleet.id);
  assert(r.nodes.get('period-select').disabled);
  assert(!/NaN|undefined/.test(r.html()));
});

const comparisonOrder=r=>[...r.html().matchAll(/data-comparison-group="([^"]+)"/g)].map(m=>m[1]);

test('F sorting reorders the real partial BNB results, retains unknown scores last and persists the selected view',async()=>{
  const r=await productRuntime('',{data:fixture()});
  r.action('live-discovery-view',{view:'compare'});r.field('leaderboard-service','bsc');
  const earnings=comparisonOrder(r);
  assert.equal(earnings[3],'nodefleet.net');assert.equal(earnings[6],'lexiscan.ai');
  r.action('live-sort',{sort:'score'});
  assert.deepEqual(comparisonOrder(r).slice(0,7),['rpcgate.xyz','kleomedes.network','kalorius.tech','lexiscan.ai','stakeandrelax.net','easy2stake.com','nodefleet.net']);
  assert(r.html().includes('data-sort="score" aria-pressed="true"'));
  assert(r.html().includes('aria-sort="descending">F score'));
  assert(!r.html().includes('<th scope="col">Rank</th>'));
  assert(r.html().includes('payout outcomes unknown'));
  assert.deepEqual(comparisonOrder(r).slice(7),['lascodistribution.com','nodeflare.app','weaversnodes.org','xrpc.cl']);
  const copy=await productRuntime(r.location.hash,{data:fixture()});
  assert.deepEqual(comparisonOrder(copy),comparisonOrder(r));assert(copy.html().includes('data-sort="score" aria-pressed="true"'));
  copy.action('live-row-detail',{groupKey:'lexiscan.ai'});
  assert(copy.dialog().includes('lexiscan.ai'));assert(copy.dialog().includes('4 / 12 sessions'));assert(copy.dialog().includes('Insufficient evidence for a range'));
  copy.action('live-open-domain',{domain:'lexiscan.ai'});assert.equal(copy.review.report.services[0].id,'bsc');
  r.action('live-sort',{sort:'earnings'});assert.deepEqual(comparisonOrder(r),earnings);
});

test('metric ordering includes partial rows while numeric ranks only count eligible rows',async()=>{
  const data=fixture(),rows=data.liveSource.domainLeaderboards['30'].bsc;
  for(const name of ['kleomedes.network','lexiscan.ai']){
    const row=rows.find(r=>r.name===name);row.availability='available';row.intervalRatio=[row.ratio-.1,row.ratio+.1];
  }
  const r=await productRuntime('',{data});r.action('live-discovery-view',{view:'compare'});r.field('leaderboard-service','bsc');r.action('live-sort',{sort:'score'});
  const displayed=new Map([...r.html().matchAll(/<tr data-comparison-group="([^"]+)"><td>([^<]+)<\/td>/g)].map(m=>[m[1],m[2]]));
  assert.equal(comparisonOrder(r)[0],'rpcgate.xyz');
  assert.equal(displayed.get('rpcgate.xyz'),'—');assert.equal(displayed.get('kleomedes.network'),'1');assert.equal(displayed.get('lexiscan.ai'),'2');
  assert(r.html().includes('<th scope="col">Rank</th>'));
  r.action('live-grouping',{grouping:'owner',groupingContext:'comparison'});
  const first=comparisonOrder(r);assert.equal(first.length,20);
  r.action('live-more');const more=comparisonOrder(r);assert.equal(more.length,40);assert.deepEqual(more.slice(0,20),first);
  const byIdentity=new Map(r.review.adapter.leaderboard('bsc','30','owner').map(row=>[row.ownerAddress,row]));
  const scores=more.map(key=>byIdentity.get(key).ratio).filter(score=>score!==null);
  for(let i=1;i<scores.length;i++)assert(scores[i-1]>=scores[i]);
});

test('discovery tabs support keyboard navigation, four initial suggestions, and return to a saved comparison',async()=>{
  const r=await productRuntime('',{data:fixture()});
  assert.equal((r.html().match(/class="example-card"/g)??[]).length,4);
  r.action('live-more-suggestions');assert.equal((r.html().match(/class="example-card"/g)??[]).length,8);
  r.nodes.get('discovery-tab-explore').focus();r.dispatch('keydown',r.document.activeElement,{key:'ArrowRight'});
  assert.equal(r.document.activeElement.id,'discovery-tab-compare');assert(r.html().includes('class="leaderboard-table compact-table"'));
  assert(!r.html().includes('id="fleet-search"'));
  r.field('leaderboard-service','eth');r.action('live-grouping',{grouping:'owner',groupingContext:'comparison'});
  const saved=r.location.hash,copy=await productRuntime(saved,{data:fixture()});
  assert(copy.html().includes('Owner address'));assert(copy.nodes.get('leaderboard-service').innerHTML.includes('value="eth" selected'));
  copy.action('live-open-owner',{owner:comparisonOrder(copy)[0]});assert(copy.review.report);
  copy.location.hash=saved;copy.dispatch('popstate',copy.document.activeElement??copy.nodes.get('app'));
  assert.deepEqual(comparisonOrder(copy),comparisonOrder(r));assert(!copy.review.report);
  copy.nodes.get('discovery-tab-compare').focus();copy.dispatch('keydown',copy.document.activeElement,{key:'Home'});
  assert.equal(copy.document.activeElement.id,'discovery-tab-explore');assert(copy.nodes.get('fleet-search').isConnected);
  copy.action('live-rank-help');assert(copy.dialog().includes('7 informative days'));assert(copy.dialog().includes('display guardrails'));
});

test('live multi-service exclusions, relevant breakdowns and unavailable prediction survive a saved route',async()=>{
  const r=await productRuntime('',{data:fixture()});
  r.action('open-network');
  assert.equal(r.review.report.services.length,8);
  assert(r.html().includes('All 8 collected services'));
  r.action('service');r.action('choose-service',{service:'bsc'});
  assert.equal(r.review.report.services.length,1);
  r.action('view',{view:'breakdown'});
  const options=r.nodes.get('dimension-select').innerHTML;
  assert(!options.includes('value="infrastructure"'));assert(!options.includes('value="gateway"'));
  r.field('dimension-select','owner');assert(r.review.breakdown.rows.length>0);
  r.action('view',{view:'predictions'});assert(r.html().includes('Collect at least 30 days'));assert(r.html().includes('snapshot covers 1 day'));
  const copy=await productRuntime(r.location.hash,{data:fixture()});
  assert.equal(copy.review.state.view,'predictions');assert.equal(copy.review.report.services[0].id,'bsc');
  close(copy.review.report.rewards.actualPokt,r.review.report.rewards.actualPokt);
  const malformed=await productRuntime('#snapshot='+wire.snapshotId+'&scope=fleet&id=missing&service=bsc',{data:fixture()});
  assert(malformed.html().includes('Choose a fleet from this snapshot'));
});

test('provider fragments find domain groups and service-specific hostnames expose only their recorded service',()=>{
  const data=fixture(),adapter=createLiveAdapter(data);
  for(const [query,domain,count] of [['Nodefleet','nodefleet.net',2342],['kleomedes','kleomedes.network',306],['kleom','kleomedes.network',306]]){
    const result=adapter.search(query)[0];
    assert.equal(result.scope.type,'domain');assert.equal(result.scope.value,domain);
    assert.equal(result.supplierCount,count);assert.equal(result.kind,'Endpoint domain');
  }
  assert.deepEqual(adapter.servicesFor({type:'hostname',value:'base.pocket.kleomedes.network'}).map(s=>s.id),['base']);
  assert.equal(adapter.search('https://base.pocket.kleomedes.network/rpc')[0].primaryService,'base');
  assert.equal(adapter.search('kleomedes.network.attacker.invalid').length,0);
  assert(adapter.domainDirectory().every(g=>g.tag==='Endpoint domain'));
});

test('domain comparison rows reconcile with analysis across every collected service',()=>{
  const data=fixture(),adapter=createLiveAdapter(data);
  for(const service of data.services)for(const row of adapter.leaderboard(service.id,'30','domain')){
    const report=adapter.getReport({scope:row.scope,serviceId:service.id,period:'30',filters:[]});
    close(row.actualPokt,report.rewards.actualPokt??0);
    close(row.equalSharePokt,report.rewards.equalSharePokt??0);
    close(row.coverage,report.rewards.coverage);
    assert.equal(row.ratio,report.rewards.ratio);
    assert.equal(row.eligibleSuppliers,report.scope.latestEligibleCount);
    assert.notEqual(row.availability,'available');
  }
});

test('domain discovery, owner grouping and structured endpoint inspection work through the controller',async()=>{
  const r=await productRuntime('',{data:fixture()});
  assert(r.html().includes('Explore a domain group'));assert(r.html().includes('nodefleet.net'));
  r.action('live-grouping',{grouping:'owner'});assert(r.html().includes('Explore an owner-address group'));
  r.action('live-grouping',{grouping:'domain'});
  r.field('fleet-search','Kleomedes','input');
  assert(r.nodes.get('search-results').innerHTML.includes('kleomedes.network'));
  assert(r.nodes.get('search-results').innerHTML.includes('Shared hosting does not establish one operator'));
  r.action('search-match',{index:0});
  assert.equal(r.review.report.scope.type,'domain');
  assert.equal(r.review.report.services.length,8);
  r.action('service');r.action('choose-service',{service:'base'});
  r.action('scope');assert(r.dialog().includes('Inspect endpoints'));
  const supplier=r.review.adapter.suppliersFor(r.review.queryForView())[0];
  r.action('supplier-endpoints',{supplier:supplier.id});
  assert(r.dialog().includes('base.pocket.kleomedes.network'));assert(r.dialog().includes('Registrable domain'));
  assert(r.dialog().includes('Subdomain labels'));assert(!r.dialog().includes('arb-one.pocket.kleomedes.network'));
  r.action('close-dialog');r.action('view',{view:'breakdown'});r.field('dimension-select','domain');
  assert(r.review.breakdown.overlapping);
  const copy=await productRuntime(r.location.hash,{data:fixture()});
  assert.equal(copy.review.report.scope.value,'kleomedes.network');assert.equal(copy.review.state.dimension,'domain');
});

test('endpoint membership follows both service and time, including an owner subset before transfer',()=>{
  const day='2026-10-05',at=hour=>`${day}T${hour}:00:00Z`;
  const endpoints=[{id:'a-target',serviceId:'a',hostname:'rpc.target.net',registrableDomain:'target.net'},
    {id:'b-other',serviceId:'b',hostname:'rpc.other.net',registrableDomain:'other.net'},
    {id:'a-other',serviceId:'a',hostname:'rpc.other.net',registrableDomain:'other.net'},
    {id:'b-target',serviceId:'b',hostname:'rpc.target.net',registrableDomain:'target.net'}];
  const d={schemaVersion:1,dataKind:'live',snapshotId:'test-history',generatedAt:at('21'),
    liveSource:{cutoff:100},period:{start:at('00'),endExclusive:'2026-10-06T00:00:00Z'},description:'Synthetic regression test',sampling:'Test records',
    services:['a','b'].map(id=>({id,name:id,shortName:id,selectionCap:1})),gateways:[],applications:[],endpointCatalog:endpoints,
    fleets:['old','new'].map(id=>({id:`owner:${id}`,ownerAddress:id,name:id,primary:'a',services:['a','b']})),
    suppliers:[{id:'test-supplier',name:'Test',fleetId:'owner:new',serviceIds:['a','b'],endpointHosts:['rpc.target.net','rpc.other.net'],endpointIds:endpoints.map(e=>e.id),
      ownerHistory:[{ownerId:'old',start:at('00'),end:at('09')},{ownerId:'new',start:at('09'),end:null}],
      endpointHistory:[{start:at('00'),end:at('09'),hosts:['rpc.target.net','rpc.other.net'],endpointIds:['a-target','b-other']},
        {start:at('09'),end:null,hosts:['rpc.target.net','rpc.other.net'],endpointIds:['a-other','b-target']}]}],
    populations:[],sessions:[]};
  for(const hour of ['03','15'])for(const serviceId of ['a','b']){
    const id=`${serviceId}-${hour}`;
    d.populations.push({id,serviceId,observedAt:at(hour),totalEligible:1,selectionCap:1,eligibleSupplierIds:['test-supplier']});
    d.sessions.push({id,serviceId,populationId:id,applicationId:'app',startedAt:at(hour),selectedSupplierIds:['test-supplier'],selectedCount:1,
      rosterStatus:'complete',payoutStatus:'complete',totalPayoutPokt:10,supplierPayouts:[{supplierId:'test-supplier',pokt:10}],outcomeAvailableAt:'2026-10-06T00:00:00Z'});
  }
  const adapter=createLiveAdapter(d),query={scope:{type:'domain',value:'target.net'},serviceIds:['a','b'],period:'30',filters:[]};
  const report=adapter.getReport(query);
  assert.equal(report.exposure.selectedPositions,2);assert.equal(report.rewards.actualPokt,20);
  const subset=adapter.getReport({...query,scope:{...query.scope,fleetId:'owner:old'}});
  assert.equal(subset.exposure.selectedPositions,1);assert.equal(subset.rewards.actualPokt,10);
  const groups=adapter.getBreakdown({...query,serviceIds:['a']},'domain');
  assert.equal(groups.rows.find(r=>r.id==='target.net').actualPokt,10);
});
