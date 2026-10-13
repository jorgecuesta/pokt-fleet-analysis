import test from 'node:test';
import assert from 'node:assert/strict';
import {productRuntime} from './support/runtime.mjs';

test('discovery opens all eight examples and explicit shared-host scopes',async()=>{
  const r=await productRuntime();
  assert.equal((r.html().match(/class="example-card"/g)??[]).length,8);
  for(const fleet of r.review.adapter.directory()) {
    r.action('open-fleet',{fleet:fleet.id});
    assert.equal(r.review.report.scope.value,fleet.id);
    assert(r.html().includes('Fictional data'));assert(!/NaN|undefined/.test(r.html()));
  }
  r.action('home');r.field('fleet-search','relay.shared.example','input');
  assert(r.nodes.get('search-results').innerHTML.includes('Shared hosting does not establish one operator'));
  r.action('search-match',{index:0});assert.equal(r.review.report.scope.identityCount,32);
  r.action('scope');assert(r.dialog().includes('Recorded Supplier identities'));
});

test('scenario input, targets and minimum positions never mutate historical earnings',async()=>{
  const r=await productRuntime();r.action('open-fleet',{fleet:'alder'});
  const earnings=r.review.report.rewards.actualPokt,reference=r.review.report.scenarioReference;
  r.field('scenario-count',75,'input');assert.equal(r.review.state.scenarioCount,75);
  assert.equal(r.review.report.rewards.actualPokt,earnings);
  assert(r.nodes.get('scenario-formula').textContent.includes('75 yours'));
  r.field('scenario-number',5000,'input');assert(Number(r.nodes.get('scenario-count').max)>=5000);
  r.field('selection-minimum',3);r.action('scenario-target',{target:.95});
  assert(r.nodes.get('target-message').textContent.includes('at least 3 selected'));
  assert(r.location.hash.includes('minimum=3'));assert(r.location.hash.includes('count='));
  r.action('reset-scenario');assert.equal(r.review.state.scenarioCount,reference.ownEligible);
  assert.equal(r.review.report.rewards.actualPokt,earnings);
});

test('service switching retains access to registered and currently ineligible services',async()=>{
  const r=await productRuntime();r.action('open-fleet',{fleet:'prism'});r.action('service');
  assert.equal((r.dialog().match(/data-action="choose-service"/g)??[]).length,18);
  r.field('service-search','gnosis','input');assert(r.nodes.get('service-options').innerHTML.includes('Not eligible'));
  r.action('choose-service',{service:'gnosis'});assert(r.html().includes('No eligible Suppliers in this period'));
  assert.equal(r.review.report.scenarioReference.ownEligible,0);
  r.action('choose-service',{service:'demo_testnet'});assert.equal(r.review.report.scenarioReference.totalEligible,13);
  assert(r.html().includes('100.0%'));assert(!/NaN|undefined/.test(r.html()));
});

test('breakdown changes dimensions, applies nested filters and shows session details',async()=>{
  const r=await productRuntime();r.action('open-fleet',{fleet:'meridian'});r.action('view',{view:'breakdown'});
  const group=r.review.breakdown.rows[0];r.action('filter-group',{dimension:'infrastructure',value:group.id});
  r.field('dimension-select','gateway');
  const gateway=r.review.breakdown.rows.find(row=>row.id!=='unknown');r.action('filter-group',{dimension:'gateway',value:gateway.id});
  assert.equal(r.review.state.filters.length,2);assert(r.html().includes('Clear filters'));
  r.action('scope');assert(r.dialog().includes('Recorded Supplier identities'));
  r.action('close-dialog');
  const selection=r.review.selectionDiagnosticView();assert(selection.includes('Pointwise ranges'));
  const scatter=r.review.scatterDiagnosticView();assert(scatter.includes('scatter-point'));
  const points=r.review.adapter.getSessionPoints(r.review.queryForView());r.action('inspect-session',{session:points[0].sessionId});
  assert(r.dialog().includes('Actual gross earnings'));assert(r.dialog().includes(points[0].sessionId));
  r.action('remove-filter',{index:1});assert.equal(r.review.state.filters.length,1);
  r.action('clear-filters');assert.equal(r.review.state.filters.length,0);
  assert(r.review.persistenceDiagnosticView().includes('Average daily miss'));
});

test('keyboard navigation and saved routes preserve analysis state',async()=>{
  const r=await productRuntime();r.action('open-fleet',{fleet:'cairn'});
  const before=r.location.hash,skip=new r.Node({class:'skip-link'});
  assert(r.dispatch('click',skip).prevented);assert.equal(r.location.hash,before);
  const tab=r.nodes.get('tab-summary');r.dispatch('keydown',tab,{key:'ArrowRight'});
  assert.equal(r.review.state.view,'breakdown');assert.equal(r.document.activeElement.id,'tab-breakdown');
  r.field('dimension-select','owner');const group=r.review.breakdown.rows[0];r.action('filter-group',{dimension:'owner',value:group.id});
  const saved=r.location.hash,copy=await productRuntime(saved);
  assert.equal(copy.review.report.scope.value,'cairn');assert.equal(copy.review.state.filters[0].value,group.id);
  assert.equal(copy.review.report.rewards.actualPokt,r.review.report.rewards.actualPokt);
  const wrong=await productRuntime(saved.replace('illustrative-september-2026-v1','old-snapshot'));
  assert.equal(wrong.review.state.scope,null);assert(wrong.html().includes('another snapshot'));
  const bad=await productRuntime('#snapshot=illustrative-september-2026-v1&scope=fleet&id=alder&service=bsc&filters=bad');
  assert.equal(bad.review.state.scope,null);assert(bad.html().includes('filters are invalid'));
  const duplicated=new URLSearchParams(saved.slice(1));duplicated.set('filters',JSON.stringify([r.review.state.filters[0],r.review.state.filters[0]]));
  const duplicate=await productRuntime(`#${duplicated}`);assert.equal(duplicate.review.state.scope,null);assert(duplicate.html().includes('filters are invalid'));
});

test('F and percentage explain the same estimate and retain qualified sparse results',async()=>{
  const r=await productRuntime();r.action('open-fleet',{fleet:'alder'});
  assert(r.html().includes('class="f-score"'));assert(r.html().includes('vs equal share'));
  const rewards=r.review.report.rewards;assert(Math.abs((rewards.ratio-1)*100-rewards.differencePercent)<1e-10);
  r.action('f-score');assert(r.dialog().includes('F = 1'));assert(r.dialog().includes('equal share'));
  r.action('open-fleet',{fleet:'moss'});assert(r.html().includes('Only '));
  assert(r.html().includes('not a supported period-wide result'));assert(r.html().includes('class="f-score"'));
});

test('multi-service selection applies exclusions, prevents empty views and preserves model context',async()=>{
  const r=await productRuntime();r.action('open-fleet',{fleet:'alder'});r.action('service');
  const original=r.review.state.serviceId;
  r.action('clear-services');assert.equal(r.nodes.get('apply-services').disabled,true);
  r.action('apply-services');assert.equal(r.review.state.serviceIds.length,1);
  r.action('all-services');const box=r.nodes.get(`service-check-${original}`);box.checked=false;r.dispatch('change',box);
  assert.equal(r.nodes.get('apply-services').disabled,false);r.action('apply-services');
  assert.equal(r.review.state.serviceIds.length,2);assert(!r.review.state.serviceIds.includes(original));
  assert(r.html().includes('One fleet. Different services.'));assert(r.nodes.has('scenario-service-select'));
  const earnings=r.review.report.rewards.actualPokt,ref=r.review.report.scenarioReferences.at(-1);
  r.field('scenario-service-select',ref.serviceId);r.field('scenario-number',75,'input');
  r.field('scenario-number',75);
  assert.equal(r.review.report.rewards.actualPokt,earnings);assert.equal(r.review.state.scenarioServiceId,ref.serviceId);
  assert(r.nodes.get('scenario-formula').textContent.includes('75 yours'));
  const copy=await productRuntime(r.location.hash);
  assert.equal(JSON.stringify(copy.review.state.serviceIds),JSON.stringify(r.review.state.serviceIds));
  assert.equal(copy.review.state.scenarioServiceId,ref.serviceId);assert.equal(copy.review.state.scenarioCount,75);
  assert.equal(copy.review.report.rewards.actualPokt,earnings);
  r.action('service');r.action('all-services');r.action('apply-services');
  assert(r.html().includes('All 3 services'));assert.equal(r.review.report.scope.latestEligibleCount,48);
});

test('earnings and difference charts support categories, time-point keyboard filters and saved measures',async()=>{
  const r=await productRuntime();r.action('open-fleet',{fleet:'meridian'});r.action('view',{view:'breakdown'});
  assert(r.html().includes('comparison-difference'));assert(r.html().includes('vs equal share'));
  assert(r.html().includes('comparison-amounts'));assert(!r.html().includes('comparison-bars'));
  r.action('chart-metric',{metric:'amounts'});assert(r.html().includes('comparison-dots'));
  r.action('chart-metric',{metric:'difference'});assert(r.html().includes('comparison-difference'));
  assert.equal(r.document.activeElement.dataset.metric,'difference');
  const saved=await productRuntime(r.location.hash);assert.equal(saved.review.state.chartMetric,'difference');
  r.field('dimension-select','week');assert(r.html().includes('class="time-chart"'));
  const point=r.document.querySelectorAll('.time-point')[0];assert(point);
  r.dispatch('keydown',point,{key:'Enter'});assert.equal(r.review.state.filters[0].dimension,'week');
  assert(r.html().includes('Clear filters'));
});

test('network sample opens all registered services with explicit population limits',async()=>{
  const r=await productRuntime();assert(r.html().includes('Explore the network sample'));
  r.action('open-network');assert.equal(r.review.report.services.length,18);
  assert(r.html().includes('not a whole-network census'));assert(r.html().includes('Network overview'));
  assert(r.html().includes('incomplete or limited evidence'));
  r.action('view',{view:'breakdown'});r.field('dimension-select','fleet');
  assert.equal(r.review.breakdown.rows.length,8);assert(!/NaN|undefined/.test(r.html()));
  r.action('evidence');assert(r.dialog().includes('Coverage by service'));
  r.action('scope');assert(r.dialog().includes('Eligibility by service'));
  const bad=await productRuntime('#snapshot=illustrative-september-2026-v1&scope=fleet&id=alder&services=%5B%22not-real%22%5D');
  assert.equal(bad.review.state.scope,null);assert(bad.html().includes('linked services are unavailable'));
});

test('filters, pagination and scenario reset retain useful keyboard focus after rendering',async()=>{
  const r=await productRuntime();r.action('open-fleet',{fleet:'meridian'});r.action('view',{view:'breakdown'});
  const row=r.document.querySelector('.comparison-row');row.focus();r.dispatch('click',row);
  assert.equal(row.isConnected,false);assert.equal(r.document.activeElement.id,'remove-filter-infrastructure');
  r.action('remove-filter',{index:0});assert.equal(r.document.activeElement.id,'dimension-select');
  r.field('dimension-select','supplier');const more=r.document.querySelector('[data-action="more-groups"]');more.focus();r.dispatch('click',more);
  assert.equal(r.document.querySelectorAll('.comparison-row').length,48);
  assert.equal(r.document.activeElement.dataset.value,r.review.breakdown.rows[24].id);
  r.action('filter-group',{dimension:'supplier',value:r.review.breakdown.rows[24].id});r.action('clear-filters');
  assert.equal(r.document.activeElement.id,'dimension-select');
  r.action('view',{view:'summary'});r.field('scenario-number',75);
  const reset=r.document.querySelector('[data-action="reset-scenario"]');reset.focus();r.dispatch('click',reset);
  assert.equal(reset.isConnected,false);assert.equal(r.document.activeElement.dataset.action,'reset-scenario');
  assert.equal(r.review.state.scenarioCount,r.review.report.scenarioReferences[0].ownEligible);
});

test('chained explanation dialogs focus new content and return to their original control',async()=>{
  const r=await productRuntime();r.action('open-fleet',{fleet:'alder'});
  const origin=r.document.querySelector('[data-action="f-score"]');origin.focus();r.dispatch('click',origin);
  const firstClose=r.nodes.get('product-dialog').querySelector('.icon-btn');assert.equal(r.document.activeElement,firstClose);
  r.action('evidence');assert.equal(firstClose.isConnected,false);
  assert.equal(r.document.activeElement,r.nodes.get('product-dialog').querySelector('.icon-btn'));
  r.nodes.get('product-dialog').close();assert.equal(r.document.activeElement,origin);
  r.nodes.get('service-control').focus();r.action('service');assert.equal(r.document.activeElement.id,'service-search');
  r.dispatch('keydown',r.document.activeElement,{key:'Enter'});assert(r.document.activeElement.dataset.serviceCheckbox);
  r.action('open-fleet',{fleet:'prism'});assert.equal(r.document.activeElement.id,'workspace-title');
});

test('chart tooltips dismiss with Escape, stay dismissed on hover and clear on view changes',async()=>{
  const r=await productRuntime();r.action('open-fleet',{fleet:'tidal'});
  const point=r.document.querySelector('.time-point'),tooltip=r.nodes.get('chart-tooltip');
  assert(point.querySelector('.time-hit'));point.focus();assert.equal(tooltip.hidden,false);
  assert(tooltip.textContent.includes('F score'));assert(!/NaN/.test(tooltip.style.top+tooltip.style.left));
  r.dispatch('pointermove',tooltip,{clientX:30,clientY:30});assert.equal(tooltip.hidden,false);
  r.dispatch('keydown',point,{key:'Escape'});assert.equal(tooltip.hidden,true);
  r.dispatch('pointermove',point,{clientX:10,clientY:10});assert.equal(tooltip.hidden,true);
  r.nodes.get('service-control').focus();point.focus();assert.equal(tooltip.hidden,false);
  r.window.innerWidth=390;r.window.innerHeight=400;r.dispatch('pointermove',point,{clientX:389,clientY:399});
  assert(parseFloat(tooltip.style.left)+tooltip.offsetWidth<=382);assert(parseFloat(tooltip.style.top)+tooltip.offsetHeight<=392);
  r.action('view',{view:'breakdown'});assert.equal(tooltip.hidden,true);
});


test('custom selection counts and percentage targets are exact, shareable and honest about certainty',async()=>{
  const r=await productRuntime();r.action('open-fleet',{fleet:'alder'});
  const before=r.review.report.rewards.actualPokt;
  r.field('selection-minimum','custom');assert.equal(r.document.activeElement.id,'selection-minimum-custom');
  r.field('selection-minimum-custom',7);assert.equal(r.review.state.minimum,7);
  r.field('scenario-target-percent',98.9,'input');r.dispatch('submit',r.nodes.get('scenario-target-form'));
  assert(Math.abs(r.review.state.target-.989)<1e-12);assert(r.nodes.get('target-message').textContent.includes('98.9%'));
  assert(r.nodes.get('scenario-chart').innerHTML.includes('98.9% target'));
  assert(r.location.hash.includes('minimum=7'));assert(Math.abs(Number(new URLSearchParams(r.location.hash.slice(1)).get('target'))-.989)<1e-12);
  const ref=r.review.report.scenarioReference,count=r.review.state.scenarioCount;
  const {exposureScenario}=await import('../src/math.js');
  assert(exposureScenario(ref,count,7).selectionChance>=.989);
  assert(exposureScenario(ref,count-1,7).selectionChance<.989);
  const copy=await productRuntime(r.location.hash);
  assert.equal(copy.review.state.minimum,7);assert.equal(copy.review.state.target,r.review.state.target);
  assert.equal(copy.review.state.scenarioCount,count);assert.equal(copy.review.report.rewards.actualPokt,before);
  r.field('selection-minimum-custom',7.5);assert.equal(r.review.state.minimum,7);
  r.field('scenario-target-percent',100,'input');r.dispatch('submit',r.nodes.get('scenario-target-form'));
  assert(r.nodes.get('target-message').textContent.includes('cannot be reached'));
  assert.equal(r.review.state.scenarioCount,count);assert.equal(r.review.report.rewards.actualPokt,before);
  r.field('scenario-target-percent',0,'input');r.dispatch('submit',r.nodes.get('scenario-target-form'));
  assert(r.nodes.get('target-message').textContent.includes('greater than 0%'));assert.equal(r.review.state.target,1);
  r.field('selection-minimum-custom',ref.selectionCap+1);assert(r.html().includes('is impossible under that cap'));
  assert(r.nodes.get('scenario-metrics').innerHTML.includes('0.0%'));
  r.field('selection-minimum',1);r.action('scenario-target',{target:.95});
  assert.equal(r.document.querySelector('[data-action="scenario-target"][data-target="0.95"]').getAttribute('aria-pressed'),'true');
  r.field('scenario-count',50,'input');assert.equal(r.review.state.target,null);
  assert.equal(r.document.querySelector('[data-action="scenario-target"][data-target="0.95"]').getAttribute('aria-pressed'),'false');
});

test('predictions are a dated view with inspectable days and independent diagnostic navigation',async()=>{
  const r=await productRuntime();r.action('open-fleet',{fleet:'alder'});
  assert(r.html().includes('Earnings through the period'));assert(r.html().includes('class="time-chart"'));
  const earnings=r.review.report.rewards.actualPokt;
  r.dispatch('keydown',r.nodes.get('tab-summary'),{key:'ArrowRight'});
  assert.equal(r.review.state.view,'breakdown');assert(!r.html().includes('data-diagnostic="selection"'));
  r.dispatch('keydown',r.nodes.get('tab-breakdown'),{key:'ArrowRight'});
  assert.equal(r.review.state.view,'predictions');assert(r.html().includes('class="prediction-chart"'));
  assert(/1 Sept? – 13 Sept?/.test(r.html()));assert(/16 Sept? – 30 Sept?/.test(r.html()));
  const first=r.document.querySelectorAll('.prediction-point')[0];first.focus();
  r.dispatch('keydown',first,{key:'ArrowRight'});assert.equal(r.document.activeElement.dataset.date,'2026-09-17');
  r.dispatch('keydown',r.document.activeElement,{key:'Enter'});assert(r.dialog().includes('Earlier estimate'));
  r.action('close-dialog');assert.equal(r.document.activeElement.dataset.date,'2026-09-17');
  r.field('prediction-day-select','2026-09-30');assert(r.dialog().includes('Earnings on 30 Sep'));r.action('close-dialog');
  assert(r.nodes.get('tab-predictions').textContent.includes('Past performance'));
  r.field('period-select','7');assert(r.html().includes('Use 30 days for this test'));
  r.action('prediction-full-month');assert.equal(r.review.state.period,'30');assert(r.html().includes('class="prediction-chart"'));
  r.dispatch('keydown',r.nodes.get('tab-predictions'),{key:'End'});assert.equal(r.review.state.view,'diagnostics');
  r.timers();assert(r.nodes.get('diagnostic-host').innerHTML.includes('Observed sessions'));
  r.dispatch('keydown',r.nodes.get('diagnostic-selection'),{key:'ArrowRight'});r.timers();
  assert.equal(r.review.state.view,'diagnostics');assert.equal(r.review.state.diagnostic,'scatter');
  assert.equal(r.document.activeElement.id,'diagnostic-scatter');assert(r.nodes.get('diagnostic-host').innerHTML.includes('scatter-point'));
  const copy=await productRuntime(r.location.hash);copy.timers();
  assert.equal(copy.review.state.view,'diagnostics');assert.equal(copy.review.state.diagnostic,'scatter');
  assert.equal(copy.review.report.rewards.actualPokt,earnings);
  r.dispatch('keydown',r.nodes.get('tab-diagnostics'),{key:'Home'});assert.equal(r.review.state.view,'summary');
  r.action('selection-explain');r.action('selection-shortcut');r.timers();
  assert.equal(r.review.state.view,'diagnostics');assert.equal(r.review.state.diagnostic,'selection');
});
