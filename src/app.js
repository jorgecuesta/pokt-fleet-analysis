import {createIllustrativeAdapter,createLiveAdapter} from './adapter.js';
import {exposureScenario,countForTarget} from './math.js';
import {resultDownloadBlob} from './export-download.js';

/* The build supplies saved evidence; the browser never queries Pocket APIs. */
const productData=typeof SNAPSHOT_DATA==='undefined'?FIXTURE_DATA:SNAPSHOT_DATA;
const live=productData.dataKind==='live';
const adapter = live?createLiveAdapter(productData,typeof MONTHLY_CLAIM_CHECK==='undefined'?null:MONTHLY_CLAIM_CHECK,
  typeof SETTLEMENT_DATA==='undefined'?null:SETTLEMENT_DATA,typeof SETTLEMENT_RECEIPT==='undefined'?null:SETTLEMENT_RECEIPT,
  typeof SETTLEMENT_TABLES==='undefined'?null:SETTLEMENT_TABLES):createIllustrativeAdapter(productData);
const settled=!!adapter.snapshotInfo.settlement;
const settlementProof=typeof SETTLEMENT_PROOF==='undefined'?null:SETTLEMENT_PROOF;
const app = document.getElementById('app');
const productDialog = document.getElementById('product-dialog');
const chartTooltip = document.getElementById('chart-tooltip');
const DIMENSIONS = [
  ['infrastructure','Fleet groups'],['service','Services'],['fleet','Fleets'],['hostname','Hostnames'],['domain','Endpoint domains'],['owner','Owner addresses'],['supplier','Suppliers'],
  ['gateway','Gateway'],['application','Application'],['week','Week'],['hour','Time of day'],
  ['selected_count','Selected Supplier count'],['session_value','Session value']
].filter(([id])=>live?!['infrastructure','gateway'].includes(id):id!=='domain');
const scopeTypes = ['fleet','supplier','owner','hostname','domain','network'];
const VIEWS = [['summary','Summary','chart'],['breakdown','Breakdown','layers'],['predictions','Past performance','clock'],['diagnostics','Diagnostics','evidence']];
const state = {scope:null,serviceId:null,serviceIds:[],scenarioServiceId:null,period:'30',filters:[],view:'summary',diagnostic:'selection',dimension:live?'hostname':'infrastructure',chartMetric:'difference',scenarioCount:null,minimum:1,customMinimum:false,query:'',error:'',target:null,groupLimit:24};
const discovery={view:'explore',grouping:'domain',service:(adapter.snapshotInfo.source?.screeningSelectedServices??adapter.snapshotInfo.source?.selectedServices)?.find(id=>productData.services.some(s=>s.id===id))??productData.services[0].id,period:'30',sort:'earnings',limit:20,suggestedLimit:4,catalogQuery:''};
let currentReport = null, currentBreakdown = null, modalKind = null, toastTimer = null, pendingServiceIds = new Set();
let dialogReturnFocus = null, tooltipTarget = null, dismissedTooltipTarget = null;
const esc = value => String(value??'').replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const number = (value,decimals=0) => value===null||value===undefined?'—':Number(value).toLocaleString('en-GB',{maximumFractionDigits:decimals,minimumFractionDigits:decimals});
const money = value => value===null||value===undefined?'—':`${number(value,1)} POKT`;
const percent = (value,decimals=1) => value===null||value===undefined?'—':`${number(value*100,decimals)}%`;
const signed = (value,decimals=1) => value===null||value===undefined?'—':`${Math.abs(value)<Math.pow(10,-decimals)/2?'≈':value>0?'+':value<0?'−':''}${number(Math.abs(value),decimals)}%`;
const chanceLabel = fraction => fraction<1 && fraction>=.9995 ? '>99.9%' : percent(fraction,1);
const targetLabel = fraction => `${Number((fraction*100).toFixed(6)).toLocaleString('en-GB',{maximumFractionDigits:6})}%`;
const dateLabel = date => new Date(date).toLocaleDateString('en-GB',{day:'numeric',month:'short',timeZone:'UTC'});
const periodLabel = period => `${dateLabel(period.start)} – ${dateLabel(new Date(+new Date(period.endExclusive)-1))} ${new Date(+new Date(period.endExclusive)-1).getUTCFullYear()}`;
const collectedDays=Math.ceil((+new Date(productData.period.endExclusive)- +new Date(productData.period.start))/86400000);
const periodChoices=[['30',`${periodLabel(productData.period)}${live?` · ${collectedDays} ${collectedDays===1?'day':'days'}`:''}`],...(!live||collectedDays>14?[['14','Last 14 days']]:[]),...(!live||collectedDays>7?[['7','Last 7 days']]:[])];
const periodOptions=current=>periodChoices.map(([id,label])=>`<option value="${id}" ${id===current?'selected':''}>${esc(label)}</option>`).join('');
const shortId = value => String(value).length>33 ? `${String(value).slice(0,21)}…${String(value).slice(-8)}` : String(value);
const tip = text => `data-tip="${esc(text)}"`;
const queryForView = () => ({scope:state.scope,serviceId:state.serviceId,serviceIds:state.serviceIds,period:state.period,filters:state.filters});
const scenarioReferenceFor = report => report.scenarioReferences.find(ref=>ref.serviceId===state.scenarioServiceId)??report.scenarioReferences[0]??null;
const serviceLabel = report => report.services.length===1?report.services[0].name:report.services.length===adapter.servicesFor(state.scope).length?`All ${report.services.length} ${live?'collected services':'services'}`:`${report.services.length} services`;
const icon = name => {
  const paths = {
    search:'<circle cx="10.7" cy="10.7" r="6.7"/><path d="m16 16 4.5 4.5"/>',
    arrow:'<path d="M5 12h14M13 6l6 6-6 6"/>',
    chevron:'<path d="m8 5 7 7-7 7"/>',down:'<path d="m6 9 6 6 6-6"/>',
    close:'<path d="m6 6 12 12M18 6 6 18"/>',
    info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
    check:'<path d="m5 12 4 4L19 6"/>',
    share:'<path d="M12 15V3m-4 4 4-4 4 4M5 11v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8"/>',
    layers:'<path d="m12 3 10 5-10 5L2 8l10-5Zm-10 9 10 5 10-5M2 16l10 5 10-5"/>',
    chart:'<path d="M4 3v17h17M8 15l4-5 4 2 5-7"/>',
    download:'<path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4"/>',
    clock:'<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
    globe:'<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z"/>',
    evidence:'<path d="M6 3h9l4 4v14H5V3h1Zm9 0v5h4M8 12h8M8 16h6"/>',
    reset:'<path d="M3 11a9 9 0 1 1 2 7M3 4v7h7"/>',
    fleet:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'
  };
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name]??paths.info}</svg>`;
};
const badge = (label,kind='') => `<span class="pill ${kind}">${esc(label)}</span>`;

function earningsEvidenceLabel(result,available='Enough observed evidence') {
  if(result.availability==='available')return available;
  if(!result.recordedSessions)return 'No recorded sessions';
  if(!result.comparableSessions)return 'No recorded payouts';
  if(result.ratio===null)return 'No earnings opportunity recorded';
  if(result.coverage<.9){const missing=result.recordedSessions-result.comparableSessions;return `${number(missing)} payout ${missing===1?'outcome':'outcomes'} unknown`;}
  if(result.informativeDays<7)return `Only ${number(result.informativeDays)} ${result.informativeDays===1?'day':'days'} with opportunity`;
  if(result.positiveSessions<24)return `Only ${number(result.positiveSessions)} ${result.positiveSessions===1?'opportunity':'opportunities'}`;
  if(result.largestDayShare>.4)return 'Too concentrated in one day';
  return 'Uncertainty range not clear';
}

const plainEvidenceReason = reason => String(reason??'')
  .replaceAll('informative days','days with opportunity')
  .replaceAll('% comparable','% with known payouts')
  .replaceAll('No positive equal-share comparison amount in this scope.','No earnings opportunity was recorded for this scope.');

function earningsScopeBanner(report) {
  if(!settled)return '';
  return `<div class="subtle-notice earnings-scope-notice"><span><strong>Verified recorded settlements</strong> · ${number(report.rewards.comparableSessions)} / ${number(report.rewards.recordedSessions)} indexed sessions for earnings. <strong>Sampled selection</strong> · ${number(report.exposure.recordedSessions)} sessions. <button class="text-action" data-action="earnings-scope">Why two sets? ${icon('info')}</button></span></div>`;
}

function earningsScopeDialog() {
  if(!settled)return;
  const evidence=adapter.snapshotInfo.settlement,original=adapter.snapshotInfo.source.coverage;
  openDialog('earnings-scope','Two evidence sets, two questions','Recorded payments and selection use different denominators.',
    `<h3>Verified recorded settlements</h3><p>${number(evidence.claims)} indexed claims across ${number(evidence.sessions)} settled sessions · ${esc(periodLabel(evidence.period))} · UTC. We compare attributed gross Supplier payments with equal share using the same sessions and their exact historical selected members, owners and service endpoints.</p><h3>Sampled selection</h3><p>The original ${number(original.sessions)} sampled sessions retain their eligible network populations and rosters. ${number(original.comparableSessions)} have comparable sampled payouts; the remaining outcomes stay unknown. These records support selection statistics and the fleet-size model.</p><h3>What does complete mean here?</h3><p>Retrieval and attribution of returned indexed settlements can be complete while other registered sessions remain unresolved. A selected Supplier with no attributed distribution has zero recorded payment in that indexed session only. A session absent from the index has not been certified as zero income. This is recorded gross earnings, not owner profit or all network traffic.</p><h3>Why can a comparison still be unavailable?</h3><p>A scope needs positive equal-share opportunity, enough informative days and sessions, and a usable range. The historical earnings test additionally requires separate earlier and later evidence, with training payouts settled before evaluation.</p><div class="dialog-actions"><button class="btn" data-action="live-coverage">Inspect original sampled gaps</button><button class="btn primary" data-action="close-dialog">Back to analysis</button></div>`,{drawer:true});
}

function shell(content) {
  if(live)return `<div class="topbar"><header class="site-header wrap"><button class="brand" data-action="home" aria-label="Pocket fleet analysis home"><img class="pocket-wordmark" src="__POCKET_LOGO__" alt="Pocket"><span class="brand-caption">Fleet analysis</span></button><div class="header-right"><button class="header-help" data-action="about">About the data</button><span class="demo-badge"><span class="demo-dot"></span>Mainnet snapshot</span></div></header></div><div class="wrap ${state.scope?'workspace-wrap':'explore-wrap'}"><div class="demo-note live-note"><span>${icon('clock')} ${esc(periodLabel(adapter.snapshotInfo.period))} · ${collectedDays} ${collectedDays===1?'day':'days'} · ${productData.services.length} services</span><span>${adapter.snapshotInfo.source.extension?.status!=='complete'&&adapter.snapshotInfo.source.extension?'<span class="collection-pending">30-day collection pending</span> · ':''}<button class="text-action" data-action="about">Source & evidence</button></span></div>${content}<footer class="site-footer"><span>Pocket Network · Fleet analysis</span><span>Snapshot · All dates UTC · <button class="text-action" data-action="method" style="font-size:11px">Methodology</button> · <a href="?dataset=preview">Fictional preview</a></span></footer></div>`;
  return `<div class="topbar"><header class="site-header wrap"><button class="brand" data-action="home" aria-label="Pocket fleet analysis home"><img class="pocket-wordmark" src="__POCKET_LOGO__" alt="Pocket"><span class="brand-caption">Fleet analysis</span></button><div class="header-right"><button class="header-help" data-action="about">About this preview</button><span class="demo-badge"><span class="demo-dot"></span>Illustrative preview</span></div></header></div><div class="wrap ${state.scope?'workspace-wrap':'explore-wrap'}"><div class="demo-note"><span>${icon('info')} All fleets, identities and results are fictional.</span><span>${esc(periodLabel(adapter.snapshotInfo.period))} · saved examples</span></div>${content}<footer class="site-footer"><span>Pocket Network · Fleet analysis preview</span><span>Fictional data · All dates UTC · ${state.scope?'<button class="text-action" data-action="method" style="font-size:11px">How results are calculated</button>':'<button class="text-action" data-action="about" style="font-size:11px">About the examples</button>'}</span></footer></div>`;
}

function homePage() {
  if(live)return liveHomePage();
  const examples=adapter.directory();
  return shell(`<main id="main-content" tabindex="-1"><section class="home-hero"><div class="eyebrow">Your fleet. A clearer picture.</div><h1>Understand<br><span>your fleet.</span></h1><p>See how your earnings compare with the sessions you reached.<br>Explore how fleet size changes selection.</p>${state.error?`<p class="preview-error" role="alert">${esc(state.error)}</p>`:''}<form class="search-box" id="fleet-search-form" role="search">${icon('search')}<label class="sr-only" for="fleet-search">Search by fleet, domain, hostname or address</label><input id="fleet-search" placeholder="Fleet, domain, hostname or address" autocomplete="off" value="${esc(state.query)}"><button class="btn primary" type="submit">Find fleet ${icon('arrow')}</button></form><div class="search-caption">Search across every service. Addresses in this preview start with <code>demo:</code>.</div><div class="query-suggestions" aria-label="Example searches"><button data-action="example-query" data-value="Meridian">Meridian</button><button data-action="example-query" data-value="alder.example">alder.example</button><button data-action="example-query" data-value="relay.shared.example">Shared hostname</button><button data-action="example-query" data-value="demo:cairn:owner:1">Owner address</button></div><div id="search-results" class="search-results" aria-live="polite">${state.query?searchResults(state.query):''}</div></section><section class="examples" aria-labelledby="examples-title"><div class="between"><div><h2 id="examples-title" class="section-label">Explore a fictional fleet</h2><p class="section-subtitle">Eight examples. Different questions, different evidence.</p></div></div><div class="example-grid">${examples.map(fleet=>`<button class="example-card" data-action="open-fleet" data-fleet="${fleet.id}" aria-label="Open ${esc(fleet.name)}: ${esc(fleet.note)}"><span class="example-top"><span class="fleet-avatar">${fleet.name[0]}</span><span><span class="example-name">${esc(fleet.name)}</span><span class="example-count" style="display:block">${fleet.supplierCount} ${fleet.supplierCount===1?'Supplier':'Suppliers'} · ${fleet.serviceCount} ${fleet.serviceCount===1?'service':'services'}</span></span></span><span class="example-note">${esc(fleet.note)}</span><span class="example-bottom">${badge(fleet.tag,fleet.id==='moss'||fleet.id==='copper'?'amber':'')}${icon('arrow')}</span></button>`).join('')}</div><div class="network-entry"><span>Looking at the wider picture?</span><button class="text-action" data-action="open-network">Explore the network sample ${icon('arrow')}</button></div></section></main>`);
}

function liveSuggestedFleets() {
  const groups=(discovery.grouping==='domain'?adapter.domainDirectory():adapter.directory()).slice()
    .sort((a,b)=>b.supplierCount-a.supplierCount||a.id.localeCompare(b.id));
  const selected=[];
  for(const [low,high] of [[1000,Infinity],[100,999],[10,99],[1,9]]) {
    const bin=groups.filter(f=>f.supplierCount>=low&&f.supplierCount<=high);
    if(bin.length)selected.push(bin[0]);
  }
  for(const [low,high] of [[1000,Infinity],[100,999],[10,99],[1,9]]) {
    const bin=groups.filter(f=>f.supplierCount>=low&&f.supplierCount<=high);
    if(bin.length>1)selected.push(bin[Math.floor(bin.length/2)]);
  }
  for(const group of groups)if(selected.length<8&&!selected.some(f=>f.id===group.id))selected.push(group);
  return selected.slice(0,8);
}

function liveGroupingControl(label) {
  return `<div class="chart-switch" role="group" aria-label="${esc(label)}">${[['domain','Endpoint domains'],['owner','Owner addresses']].map(([id,text])=>`<button data-action="live-grouping" data-grouping-context="${label.includes('discovery')?'discovery':'comparison'}" data-grouping="${id}" aria-pressed="${discovery.grouping===id}" class="${discovery.grouping===id?'active':''}">${text}</button>`).join('')}</div>`;
}

function liveHomePage() {
  const examples=liveSuggestedFleets(),shown=examples.slice(0,discovery.suggestedLimit),domains=discovery.grouping==='domain';
  const totalGroups=(domains?adapter.domainDirectory():adapter.directory()).length;
  const suggestedNames=['nodefleet','kleomedes'].filter(name=>adapter.domainDirectory().some(g=>g.domain.includes(name)));
  const cards=shown.map(f=>`<button class="example-card" data-action="${domains?'live-open-domain':'open-fleet'}" ${domains?`data-domain="${esc(f.domain)}" data-all-services="true"`:`data-fleet="${esc(f.id)}"`} aria-label="Open ${domains?'endpoint domain':'owner address'} ${esc(domains?f.domain:f.ownerAddress)}"><span class="example-top"><span class="fleet-avatar">${icon(domains?'globe':'fleet')}</span><span><span class="example-name address-label">${esc(f.name)}</span><span class="example-count" style="display:block">${number(f.supplierCount)} ${f.supplierCount===1?'Supplier':'Suppliers'} · ${f.serviceCount} services</span></span></span><span class="example-note">${domains?`${number(f.ownerCount)} owner ${f.ownerCount===1?'address':'addresses'}`:'Recorded owner-address group'}</span><span class="example-bottom">${badge(domains?'Endpoint domain':'Owner address')}${icon('arrow')}</span></button>`).join('');
  const tabs=`<div class="discovery-tabs" role="tablist" aria-label="Fleet discovery">${[['explore','Find a fleet'],['compare','Compare fleets']].map(([id,label])=>`<button id="discovery-tab-${id}" role="tab" aria-selected="${discovery.view===id}" aria-controls="discovery-panel-${id}" tabindex="${discovery.view===id?'0':'-1'}" data-action="live-discovery-view" data-view="${id}">${label}</button>`).join('')}</div>`;
  const explore=`<section class="home-hero"><div class="eyebrow">Your fleet. A clearer picture.</div><h1 id="discovery-title" tabindex="-1">Understand<br><span>your fleet.</span></h1><p>See how your earnings compare with the sessions you reached.<br>Explore how fleet size changes selection.</p>${state.error?`<p class="preview-error" role="alert">${esc(state.error)}</p>`:''}<form class="search-box" id="fleet-search-form" role="search">${icon('search')}<label class="sr-only" for="fleet-search">Find a provider name, domain, hostname or address</label><input id="fleet-search" placeholder="Name, domain, hostname or address" autocomplete="off" value="${esc(state.query)}"><button class="btn primary" type="submit">Find fleet ${icon('arrow')}</button></form><div class="search-caption">Search names, domains, hostnames and addresses across the collected services.</div><div class="query-suggestions" aria-label="Example domain searches">${suggestedNames.map(name=>`<button data-action="example-query" data-value="${esc(name)}">${esc(name==='nodefleet'?'Nodefleet':'Kleomedes')}</button>`).join('')}<button data-action="live-catalog">Browse services</button></div><div id="search-results" class="search-results" aria-live="polite">${state.query?searchResults(state.query):''}</div></section><section class="examples" aria-labelledby="examples-title"><div class="between discovery-heading"><div><h2 id="examples-title" class="section-label">${domains?'Explore a domain group':'Explore an owner-address group'}</h2><p class="section-subtitle">Start with a suggestion, or search above.</p></div>${liveGroupingControl('Group discovery by')}</div><p class="discovery-explanation">${domains?'Recorded endpoint associations':'Recorded historical ownership'} · <button class="text-action" data-action="about">What does a group mean?</button></p><div class="example-grid">${cards}</div>${examples.length>shown.length?'<button class="text-action more-suggestions" data-action="live-more-suggestions">Show more groups '+icon('down')+'</button>':''}<div class="network-entry"><span>Looking at the wider picture?</span><button class="text-action" data-action="open-network">Explore the network sample ${icon('arrow')}</button></div></section>`;
  return shell(`<main id="main-content" class="live-discovery" tabindex="-1">${tabs}<section id="discovery-panel-explore" role="tabpanel" aria-labelledby="discovery-tab-explore" ${discovery.view==='explore'?'':'hidden'}>${discovery.view==='explore'?explore:''}</section><section id="discovery-panel-compare" role="tabpanel" aria-labelledby="discovery-tab-compare" ${discovery.view==='compare'?'':'hidden'}>${discovery.view==='compare'?liveLeaderboard():''}</section></main>`);
}

function liveLeaderboard() {
  const domains=discovery.grouping==='domain',raw=adapter.leaderboard(discovery.service,discovery.period,discovery.grouping);
  const eligible=raw.filter(r=>r.availability==='available');
  const identity=r=>r.domain??r.ownerAddress;
  const value=r=>discovery.sort==='score'?r.ratio:r.comparableSessions?r.actualPokt:null;
  const sort=(a,b)=>{const av=value(a),bv=value(b);return (av===null)-(bv===null)||(av!==null&&bv!==null?bv-av:0)||identity(a).localeCompare(identity(b));};
  const ranks=new Map(eligible.slice().sort(sort).map((r,i)=>[identity(r),i+1]));
  const all=raw.slice().sort(sort).slice(0,discovery.limit),ranked=eligible.length;
  const tbody=all.map(r=>`<tr data-comparison-group="${esc(identity(r))}">${ranked?`<td>${ranks.get(identity(r))??'—'}</td>`:''}<td><button class="text-action address-label" data-action="${domains?'live-open-domain':'live-open-owner'}" ${domains?`data-domain="${esc(r.domain)}"`:`data-owner="${esc(r.ownerAddress)}"`} ${tip(identity(r))}>${esc(r.name)}</button><small>${number(r.eligibleSuppliers)} eligible Suppliers${settled?' at latest sample':''}</small></td><td>${r.comparableSessions?money(r.actualPokt):'—'}</td><td>${r.ratio===null?'—':number(r.ratio,2)}<small>${r.differencePercent===null?'No positive opportunity':signed(r.differencePercent,1)+' vs equal share'}</small></td><td>${settled?`${number(r.positiveSessions)}<small>${r.informativeDays} informative days</small>`:`${percent(r.coverage,0)}<small>${r.comparableSessions} / ${r.recordedSessions} sessions</small>`}</td><td><button class="evidence-button" data-action="live-row-detail" data-group-key="${esc(identity(r))}" aria-label="Inspect evidence for ${esc(r.name)}">${badge(earningsEvidenceLabel(r,'Ranked'),r.availability==='available'?'green':'amber')}${icon('chevron')}</button></td></tr>`).join('');
  return `<section class="card live-leaderboard" aria-labelledby="discovery-title"><div class="card-head"><div><div class="eyebrow">Same service. Same ${settled?'recorded':'sampled'} period.</div><h1 id="discovery-title" tabindex="-1">Compare fleets.</h1><p id="leaderboard-title">Explore earnings and equal-share results within one service.</p></div><button class="text-action" data-action="live-rank-help">How comparisons work ${icon('info')}</button></div><div class="leaderboard-controls"><label for="leaderboard-service">Service<select id="leaderboard-service">${productData.services.map(s=>`<option value="${esc(s.id)}" ${s.id===discovery.service?'selected':''}>${esc(s.name)} · ${esc(s.id)}</option>`).join('')}</select></label><label for="leaderboard-period">Period<select id="leaderboard-period" ${periodChoices.length===1?'disabled':''}>${periodOptions(discovery.period)}</select></label>${liveGroupingControl('Group service comparisons by')}<div class="leaderboard-order"><span>Sort by</span><div class="chart-switch" role="group" aria-label="Comparison ordering">${[['earnings',settled?'Recorded earnings':'Sampled earnings'],['score','F score']].map(([id,label])=>`<button data-action="live-sort" data-sort="${id}" aria-pressed="${discovery.sort===id}" class="${discovery.sort===id?'active':''}">${label}</button>`).join('')}</div></div></div><div class="subtle-notice ${ranked?'':'warning'}">${icon('info')}<span>${ranked?`${ranked} of ${raw.length} groups meet ranking criteria.`:'No groups meet ranking criteria yet.'} ${settled?'Sparse results remain visible;':'Sorting includes partial results;'} evidence determines whether a rank is shown.</span></div><div class="table-scroll" tabindex="0" aria-label="Service comparison table"><table class="leaderboard-table compact-table"><caption class="sr-only">Within-service ${domains?'domain':'owner-address'} comparisons, sorted by ${discovery.sort==='score'?'F score':settled?'recorded gross earnings':'sampled gross earnings'}, descending. ${settled?'Amounts cover indexed settled sessions; absent-index sessions remain outside this comparison.':'Amounts cover sampled sessions, not monthly total earnings.'}</caption><thead><tr>${ranked?'<th scope="col">Rank</th>':''}<th scope="col">${domains?'Endpoint domain':'Owner address'}</th><th scope="col" ${discovery.sort==='earnings'?'aria-sort="descending"':''}>${settled?'Recorded gross earnings':'Sampled gross earnings'}</th><th scope="col" ${discovery.sort==='score'?'aria-sort="descending"':''}>F score</th><th scope="col">${settled?'Opportunities':'Original sampled payout evidence'}</th><th scope="col">Evidence ${icon('info')}</th></tr></thead><tbody>${tbody||`<tr><td colspan="${ranked?6:5}">No recorded groups for this service.</td></tr>`}</tbody></table></div>${raw.length>all.length?`<button class="btn small show-more" data-action="live-more">Show ${Math.min(20,raw.length-all.length)} more groups</button>`:''}<p class="chart-caption">${settled?'Amounts and F use indexed settled sessions. Sessions absent from the index remain unknown in the separate selection sample.':'Amounts and F use covered sampled sessions. Missing outcomes remain unknown.'} Select an evidence label for detail.${domains?' Domain groups may overlap; their totals must not be added.':''}</p></section>`;
}

function liveRankHelp() {
  openDialog('live-rank-help','Read the comparison','Sorting and evidence answer different questions.',`<p>${settled?'Recorded gross earnings show attributed Supplier distributions across indexed settled sessions.':'Sampled gross earnings show indexed Supplier distributions across covered sampled sessions.'} ${settled?'These are recorded gross payments for this period; income absent from the index and owner costs are outside this evidence.':'They are sampled payments, not total monthly income or owner profit.'} F divides those earnings by the equal-share amount from the same sessions: 1.00 means equal share; 1.20 means 20% above.</p><p>Sorting orders every result by your chosen metric, including partial results. Missing metrics appear last. A numeric rank is assigned only among groups that meet the evidence criteria.</p><div class="definition-list"><div class="definition"><strong>Rank criteria</strong><span>At least 7 informative days, 24 positive opportunities, 90% comparable ${settled?'indexed settled':'sampled'} sessions, no day accounting for more than 40% of opportunity, and a usable 95% range.</span></div><div class="definition"><strong>Interpretation</strong><span>These are display guardrails, not a formal statistical test or a service-quality rating. More days do not automatically fix missing payouts.</span></div><div class="definition"><strong>Domain groups</strong><span>Recorded service-specific endpoints can span multiple owners or operators. Groups may overlap and their totals must not be summed.</span></div></div><div class="dialog-actions"><button class="btn" data-action="about">Source & evidence</button><button class="btn primary" data-action="close-dialog">Back to comparisons</button></div>`,{drawer:true});
}

function liveRowDetail(key) {
  const row=adapter.leaderboard(discovery.service,discovery.period,discovery.grouping).find(r=>(r.domain??r.ownerAddress)===key);
  if(!row)return;
  const service=productData.services.find(s=>s.id===discovery.service);
  const comparisonPeriod={start:new Date(Math.max(+new Date(adapter.snapshotInfo.period.start),+new Date(adapter.snapshotInfo.period.endExclusive)-Number(discovery.period)*86400000)).toISOString(),endExclusive:adapter.snapshotInfo.period.endExclusive};
  const fields=[[settled?'Recorded gross earnings':'Sampled gross earnings',row.comparableSessions?money(row.actualPokt):'No covered payouts'],['Equal-share amount',row.comparableSessions?money(row.equalSharePokt):'Unavailable'],['F score',number(row.ratio,3)],['Difference from equal share',signed(row.differencePercent,2)],[settled?'Verified recorded settlements':'Original sampled payout evidence',`${row.comparableSessions} / ${row.recordedSessions} sessions · ${percent(row.coverage,1)}`],['Informative days / opportunities',`${row.informativeDays} days · ${row.positiveSessions} opportunities`],['95% F range',row.intervalRatio?row.intervalRatio.map(n=>number(n,3)).join(' – '):'Insufficient evidence for a range'],['Eligible Suppliers at latest sample',number(row.eligibleSuppliers)]];
  if(row.domain)fields.push(['Recorded owner addresses',number(row.ownerCount)]);
  openDialog('live-row-detail',row.name,`${service.name} · ${periodLabel(comparisonPeriod)}`,`<div class="definition-list">${fields.map(([label,value])=>`<div class="definition"><strong>${esc(label)}</strong><span>${esc(value)}</span></div>`).join('')}</div><p class="dialog-explanation">${row.availability==='available'?'This group meets the ranking display criteria.':`${earningsEvidenceLabel(row)}. This group is not ranked; the displayed F describes sessions with known payouts.`} Unknown payouts are excluded from both earnings and equal share.${settled?' The coverage shown here describes returned indexed settlements. It does not certify every registered session or total income.':''}</p><div class="dialog-actions"><button class="btn" data-action="live-rank-help">How comparisons work</button><button class="btn primary" data-action="${row.domain?'live-open-domain':'live-open-owner'}" ${row.domain?`data-domain="${esc(row.domain)}"`:`data-owner="${esc(row.ownerAddress)}"`}>Analyse this group ${icon('arrow')}</button></div>`,{drawer:true});
}

function liveCatalogRows(query='') {
  const text=query.trim().toLowerCase(),total=adapter.serviceCatalog().reduce((n,s)=>n+(s.estimatedComputeUnits??0),0);
  const rows=adapter.serviceCatalog().filter(s=>`${s.id} ${s.name}`.toLowerCase().includes(text)).sort((a,b)=>(b.estimatedComputeUnits??0)-(a.estimatedComputeUnits??0)||a.id.localeCompare(b.id));
  return `<div class="table-scroll"><table class="leaderboard-table"><thead><tr><th scope="col">Service</th><th scope="col">Indexed activity share</th><th scope="col">Detailed history</th></tr></thead><tbody>${rows.map(s=>`<tr><td>${esc(s.name)}<small>${esc(s.id)}</small></td><td>${s.estimatedComputeUnits===null?'No indexed activity recorded':percent(s.estimatedComputeUnits/total,2)}</td><td>${badge(productData.services.some(t=>t.id===s.id)?'Collected':'Not collected',productData.services.some(t=>t.id===s.id)?'green':'')}</td></tr>`).join('')}</tbody></table></div>`;
}

function liveCatalogDialog() {
  openDialog('live-catalog','Every service, one directory',`${adapter.snapshotInfo.source.registeredServiceCount} registered service IDs; IDs remain distinct even when display names match.`,`<p>${esc(adapter.snapshotInfo.source.serviceSelection.rule)} The collection budget is ${adapter.snapshotInfo.source.serviceSelection.maxServices} services. The detailed set covers ${percent(adapter.snapshotInfo.source.activityShare,1)} of screening-week estimated compute units; the ${percent(adapter.snapshotInfo.source.serviceSelection.targetShare,0)} target ${adapter.snapshotInfo.source.serviceSelection.targetReached?'was reached':'was not reached within that budget'}.</p><label for="catalog-search" class="small muted">Search name or service ID</label><input id="catalog-search" class="copy-input" placeholder="e.g. Ethereum or eth" value="${esc(discovery.catalogQuery)}"><div id="catalog-results">${liveCatalogRows(discovery.catalogQuery)}</div>`,{drawer:true});
}

function monthlyClaimExplanation(d,compact=false) {
  const m=d.monthlyActivity;
  if(!m)return `<p>${number(d.neverCoveredGroups)} Application/service groups have no comparable sampled payouts. They account for ${number(d.unknownInNeverCoveredGroups)} of ${number(d.unknown)} unknown outcomes. Inspect the evidence before deciding whether to collect more days or more frequent samples.</p>`;
  const summary=`<h3>What the full-month check found</h3><p>Checked ${esc(dateLabel(m.checkedAt))} ${new Date(m.checkedAt).getUTCFullYear()} · UTC · same settlement cutoff. ${number(m.groupsWithoutClaims)} of ${number(m.checkedGroups)} Application/service groups had no indexed settled claims for sessions ending anywhere in the month. The remaining ${number(m.groupsWithClaims)} groups had ${number(m.monthlyClaimRecords)} monthly claim records. Each group's original sampled count agreed with the recheck; the sampled total remains ${number(m.recheckedSampledClaimRecords)}.</p><p>The monthly figure counts claim records. ${settled?'Additional indexed distributions have been reconciled and now supply the separate recorded-earnings views; these original sampled coverage figures are unchanged.':'Additional monthly payout details have not been installed in this snapshot; earnings charts still use the verified sampled payouts.'} A count of no indexed claims does not establish zero income or prove no traffic.</p>`;
  if(compact)return summary;
  return summary+`<div class="definition-list"><div class="definition"><strong>Across all eligible Application groups</strong><span>${number(d.covered)} / ${number(d.sessions)} sampled sessions have comparable payouts (${percent(d.coverage,1)}).</span></div><div class="definition"><strong>Within groups with indexed monthly claims</strong><span>${number(m.coveredInGroupsWithClaims)} / ${number(m.sampledInGroupsWithClaims)} sampled sessions have comparable payouts (${percent(m.coverageInGroupsWithClaims,1)}); ${number(m.unknownInGroupsWithClaims)} remain unknown. This describes a restricted group set. Overall coverage and ranking criteria retain all eligible groups.</span></div></div>`;
}

function liveAboutDialog() {
  const source=adapter.snapshotInfo.source,c=source.coverage,diagnostics=adapter.coverageDiagnostics();
  openDialog('about','Live evidence, saved as a snapshot',`Snapshot produced ${esc(adapter.snapshotInfo.generatedAt)} · mainnet Pocket`, `${settled?`<h3>Reconciled recorded earnings</h3><p>${number(adapter.snapshotInfo.settlement.claims)} indexed claim records across ${number(adapter.snapshotInfo.settlement.sessions)} settled sessions. Membership and payments are checked independently of the selection sample. <button class="text-action" data-action="earnings-scope">Understand the two evidence sets</button></p>`:settlementProof?`<h3>Settlement method: seven-day proof verified</h3><p>Ethereum · ${esc(periodLabel(settlementProof.period))} · ${number(settlementProof.claims)} indexed claims · ${number(settlementProof.sessions)} settled sessions. ${settlementProof.onChainClaims} payments matched the checked on-chain events without differences. This verifies the collection method; the cause of absent-index sessions across the whole group remains unresolved. The earnings views still use the original sample.</p>`:''}<p>This product uses public historical mainnet registries, session rosters and indexed settled Supplier distributions. Opening a fleet reads the saved snapshot. It does not recollect data, and this deployment has no automatic refresh yet.</p><div class="definition-list"><div class="definition"><strong>Observed window · UTC</strong><span>${esc(periodLabel(adapter.snapshotInfo.period))}. The saved collection plan excluded two recent UTC days for settlement.</span></div><div class="definition"><strong>Services</strong><span>${source.registeredServiceCount} metadata entries; ${productData.services.length} detailed services, covering ${percent(source.activityShare,1)} of screening-week indexed estimated compute units.</span></div><div class="definition"><strong>Screening window · UTC</strong><span>${esc(periodLabel(source.activityWindow))}. The ${percent(source.serviceSelection?.targetShare??.95,0)} coverage target ${source.serviceSelection?.targetReached?'was reached':'was not reached within the collection budget'}.</span></div>${source.extension?`<div class="definition"><strong>Collection status</strong><span>Completed ${collectedDays}-day pilot. The ${source.extension.requestedDays}-day expansion is pending. ${esc(source.extension.reason??'Collection must complete before the snapshot can be replaced.')} There is no background refresh.</span></div>`:''}<div class="definition"><strong>Sampling</strong><span>${esc(adapter.snapshotInfo.sampling)}</span></div><div class="definition"><strong>${'Original sampled payout evidence'}</strong><span>${number(c.sessions)} unique sampled sessions; ${number(c.comparableSessions)} with attributable indexed payouts; ${number(c.sessions-c.comparableSessions)} outcomes remain unknown.</span></div><div class="definition"><strong>Fixed indexer cutoff</strong><span>Block ${number(source.cutoff)} · collector ${esc(source.collectorVersion)}</span></div><div class="definition"><strong>Source APIs</strong><span><a href="${esc(source.api)}" target="_blank" rel="noopener noreferrer">Sauron archive</a> · <a href="${esc(source.graphql)}" target="_blank" rel="noopener noreferrer">Pocketdex indexer</a></span></div></div><h3>What does an address group mean?</h3><p>Suppliers are grouped by their recorded owner address at each observation. This can split one operator across wallets or combine shared custody. Domain search spans owner addresses. Each endpoint remains linked to its recorded service and historical observation. Domain labels are associations; they do not verify a business owner, operator or physical backend.</p><h3>What does missing mean?</h3><p>A query with no settled claims is not treated as proof of final zero earnings. ${settled?'The recorded-earnings comparison uses returned indexed settled sessions with reconciled distributions. Absent-index sessions stay unknown in the separate selection sample; complete indexed attribution does not prove all income was indexed.':'Unknown payouts are excluded from both sides of an earnings comparison and reduce coverage.'} Indexed workload measures settled, difficulty-adjusted claims rather than every request.</p>${monthlyClaimExplanation(diagnostics,true)}<h3>How are suggestions and ranks chosen?</h3><p>Suggestions span recorded group sizes with stable domain or address ordering. Switch between endpoint domain groups and owner-address groups. Earnings do not determine inclusion. Comparisons stay within one service and one period; sparse or partial results stay unranked. No names or payouts are invented.</p><div class="dialog-actions"><button class="btn" data-action="live-coverage">Original sampled payout evidence</button><button class="btn" data-action="live-catalog">Browse services</button><button class="btn primary" data-action="method">See methodology</button></div>`,{drawer:true});
}

function liveCoverageDialog() {
  const d=adapter.coverageDiagnostics(),m=d.monthlyActivity,short=id=>id.slice(0,11)+'…'+id.slice(-6);
  const services=d.services.map(s=>`<tr><th scope="row">${esc(s.name)}</th><td>${number(s.covered)} / ${number(s.sessions)}</td><td>${percent(s.coverage,1)}</td><td>${number(s.unknown)}</td><td>${m?s.groupsWithMonthlyClaims:s.neverCoveredGroups} / ${s.applicationGroups}</td></tr>`).join('');
  const groups=d.services.map(s=>`<details class="coverage-detail"><summary>${esc(s.name)} · ${s.applicationGroups} Application groups</summary><div class="table-scroll" tabindex="0" aria-label="Application payout evidence for ${esc(s.name)}"><table class="compact-table"><thead><tr><th scope="col">Application address</th><th scope="col">Covered / sampled</th><th scope="col">Coverage</th><th scope="col">Unknown without claims</th>${m?'<th scope="col">Indexed monthly claims</th>':''}</tr></thead><tbody>${s.applications.map(g=>`<tr><th scope="row" class="address-label" ${tip(g.applicationId)}>${esc(short(g.applicationId))}</th><td>${g.covered} / ${g.sessions}</td><td>${percent(g.coverage,1)}</td><td>${g.noIndexedClaims}</td>${m?`<td>${number(g.monthlyClaimCount)}</td>`:''}</tr>`).join('')}</tbody></table></div></details>`).join('');
  openDialog('live-coverage','Original sampled payout evidence',`${esc(periodLabel(d.period))} · all collected services · full snapshot`, `<p>${settled?'This drawer describes the original selection sample. The recorded-earnings views use the separately reconciled indexed settlements. ':''}All ${number(adapter.snapshotInfo.source.coverage.samplePoints)} scheduled observation points were collected. ${number(d.covered)} of ${number(d.sessions)} sampled sessions have comparable payouts (${percent(d.coverage,1)}); ${number(d.unknown)} remain unknown.</p><div class="subtle-notice warning">${icon('info')}<span>No indexed claim does not establish zero income or an inactive Application. Unknown outcomes stay in coverage counts and are excluded from both sides of F.</span></div><h3>Where the gaps are</h3><p>${number(d.neverCoveredGroups)} of ${number(d.applications.length)} Application/service groups have no comparable sampled payouts. They account for ${number(d.unknownInNeverCoveredGroups)} of ${number(d.unknown)} unknown sessions.${m?'':' This pattern needs investigation; adding more days alone may repeat it.'}</p>${m?monthlyClaimExplanation(d):''}<div class="table-scroll" tabindex="0" aria-label="Payout coverage by service"><table class="compact-table"><caption class="sr-only">Full-snapshot coverage. These are Application groups, not Supplier fleets.</caption><thead><tr><th scope="col">Service</th><th scope="col">Covered / sampled</th><th scope="col">Coverage</th><th scope="col">Unknown</th><th scope="col">${m?'With monthly claims / Application groups':'Never covered / Application groups'}</th></tr></thead><tbody>${services}</tbody></table></div><h3>Inspect Application groups</h3><p>An Application is an on-chain consumer of a service. It is distinct from a Supplier or owner-address fleet.${m?' Monthly counts cover indexed claims for sessions ending within the UTC month, settled through the saved cutoff. Sampled payouts cover the original observation points.':' The table records sampled payout evidence and makes no claim about unsampled traffic.'}</p>${groups}<h3>What can be compared?</h3><p>${settled?'The original sampled comparison describes its covered sessions; recorded earnings use the separate indexed-settlement universe.':'F and sampled earnings describe the same covered sessions.'} Numeric ranks and earnings estimates require adequate evidence, including at least 90% comparable outcomes. Selection analysis uses verified rosters and can remain available when payouts are unknown.</p><div class="dialog-actions"><button class="btn" data-action="live-rank-help">Comparison criteria</button><button class="btn primary" data-action="close-dialog">Back to the analyser</button></div>`,{drawer:true});
}

function searchResults(query) {
  const results=adapter.search(query);
  if(!results.length)return query.trim().length<2?'':live?`<div class="no-results"><strong>No match in the collected services</strong><p>Try a name fragment such as nodefleet, a domain, a hostname, or a full owner or Supplier address. ${adapter.snapshotInfo.source.registeredServiceCount} services are listed; ${productData.services.length} have detailed history.</p></div>`:`<div class="no-results"><strong>No matching fictional fleet</strong><p>Try a name above, an <code>.example</code> domain, or a <code>demo:</code> identity.</p></div>`;
  return results.map((result,index)=>`<button class="search-result" data-action="search-match" data-index="${index}"><span><span class="flex" style="gap:8px"><span class="result-label">${esc(result.label)}</span>${badge(result.kind)}</span><p>${esc(result.description)}</p>${result.fleetNames.length>1?`<p>${esc(result.fleetNames.slice(0,3).join(' · '))}${result.fleetNames.length>3?` · +${result.fleetNames.length-3} more groups`:''}. Shared hosting does not establish one operator.</p>`:''}</span>${icon('arrow')}</button>`).join('');
}

function openScope(scope,serviceId=null) {
  if(live&&!state.scope&&discovery.view==='compare')state.period=discovery.period;
  const services=adapter.servicesFor(scope);
  const fleet=scope.type==='fleet'?adapter.getFleet(scope.value):null;
  state.scope=scope;state.serviceId=services.some(s=>s.id===serviceId)?serviceId:services.some(s=>s.id===fleet?.primary)?fleet.primary:services[0]?.id;
  state.serviceIds=scope.type==='network'||(live&&scope.type==='domain'&&serviceId===null)?services.map(s=>s.id).sort():[state.serviceId];state.scenarioServiceId=state.serviceId;state.chartMetric='difference';
  state.filters=[];state.view='summary';state.diagnostic='selection';state.dimension=live?'hostname':'infrastructure';state.scenarioCount=null;state.minimum=1;state.customMinimum=false;state.target=null;state.error='';state.groupLimit=24;
  if(scope.type==='network')state.dimension='service';
  closeDialog();render({push:true,focus:true});
}

function filterLabel(filter) {
  const base={...queryForView(),filters:state.filters.filter(row=>row.dimension!==filter.dimension)};
  return adapter.getGroups(base,filter.dimension).find(group=>group.value===filter.value)?.label??filter.value;
}

function workspacePage(report) {
  const scope=report.scope,services=adapter.servicesFor(state.scope,state.filters);
  const service=report.services.length===1?report.services[0]:report.service;
  const reference=scenarioReferenceFor(report);
  const parentFleet=scope.fleetId?adapter.getFleet(scope.fleetId):state.scope.type==='supplier'?adapter.getFleet(adapter.getSupplier(state.scope.value)?.fleetId):null;
  const metadata=scope.supplierCount>0?`${number(scope.supplierCount)} ${scope.supplierCount===1?'Supplier identity':'Supplier identities'} · ${report.services.length===1?'1 selected service':`${report.services.length} selected services`}`:`${number(scope.identityCount)} recorded identities · ${settled&&report.rewards.positiveSessions?'no sampled eligibility observations':'none eligible in this period'}`;
  const scopeTypeLabel={'fleet':'Fleet','owner':'Owner address','supplier':'Supplier','hostname':'Hostname','domain':'Domain','network':'Network sample'}[scope.type];
  return shell(`<main id="main-content" tabindex="-1">
    <nav class="breadcrumb" aria-label="Breadcrumb"><button data-action="home">Explore</button>${icon('chevron')}${parentFleet&&state.scope.type!=='fleet'?`<button data-action="open-fleet" data-fleet="${parentFleet.id}">${esc(parentFleet.name)}</button>${icon('chevron')}`:''}<span>${esc(scopeTypeLabel)}</span></nav>
    <div class="fleet-heading"><div><h1 id="workspace-title" tabindex="-1">${esc(scope.label)}</h1><div class="heading-meta"><span>${metadata}</span><span aria-hidden="true">·</span><button class="text-action" data-action="scope">${scope.type==='owner'?'Historical owner membership':'Who is included?'} ${icon('down')}</button></div></div><div class="heading-actions"><button class="btn" data-action="share">${icon('share')} Share view</button><button class="btn ghost" data-action="home">Explore fleets</button></div></div>
    ${scope.sampleNotice?`<div class="subtle-notice sample-notice">${icon('info')}<span>${esc(scope.sampleNotice)}</span></div>`:''}
    <div class="controls-bar"><button id="service-control" class="control-segment" data-action="service" aria-haspopup="dialog"><span class="control-label">Services</span><span class="service-control-value">${report.services.length===1?`<span class="service-symbol">${esc(service.shortName)}</span>`:icon('layers')}<span>${esc(serviceLabel(report))}</span>${icon('down')}</span></button>
    <label class="control-segment" for="period-select"><span class="control-label">Period · UTC</span><select id="period-select" ${periodChoices.length===1?'disabled':''}>${periodOptions(state.period)}</select></label>
    <button class="control-segment" data-action="scope" aria-haspopup="dialog"><span class="control-label">Fleet at reference</span><span style="font-size:14px;font-weight:600">${number(scope.latestEligibleCount)} ${scope.latestEligibleCount===1?'Supplier':'Suppliers'} <span class="muted" style="font-size:11px;font-weight:400">· ${dateLabel(reference.observedAt)}</span></span></button>
    <div class="control-segment evidence-control"><button class="evidence-button" data-action="evidence">${icon('evidence')} Evidence ${icon('chevron')}</button></div></div>
    ${state.filters.length?`<div class="active-filters" aria-label="Active analysis filters">${state.filters.map((filter,index)=>`<span class="filter-chip">${esc(filterLabel(filter))}<button id="remove-filter-${esc(filter.dimension)}" data-action="remove-filter" data-index="${index}" aria-label="Remove ${esc(filterLabel(filter))} filter">${icon('close')}</button></span>`).join('')}<button class="text-action" data-action="clear-filters" style="font-size:11px">Clear filters</button></div>`:''}
    <nav class="analysis-tabs" aria-label="Analysis views" role="tablist">${VIEWS.map(([id,label,glyph])=>`<button id="tab-${id}" role="tab" aria-selected="${state.view===id}" aria-controls="analysis-panel" tabindex="${state.view===id?0:-1}" data-action="view" data-view="${id}" class="${state.view===id?'active':''}">${icon(glyph)} ${label}</button>`).join('')}</nav>
    <div id="analysis-panel" class="analysis-content" role="tabpanel" aria-labelledby="tab-${state.view}">${earningsScopeBanner(report)}${state.view==='summary'?summaryPage(report):state.view==='breakdown'?breakdownPage(report):state.view==='predictions'?predictionsPage(report):diagnosticsPage()}</div><div class="sr-only" id="view-announcement" role="status" aria-live="polite"></div></main>`);
}

function rewardCard(report) {
  const r=report.rewards;
  const noEligible=report.exposure.eligibleRange?.[1]===0&&(!settled||r.positiveSessions===0);
  const networkTotal=settled&&report.scope.type==='network'&&!report.scope.filters.some(f=>['owner','supplier','fleet','domain','hostname'].includes(f.dimension));
  const headline=networkTotal&&r.availability==='available'?'Recorded network earnings':r.availability==='unavailable'?(noEligible?'No eligible Suppliers in this period':earningsEvidenceLabel(r)):r.availability==='limited'?earningsEvidenceLabel(r):r.availability==='partial'?(live?'Some session outcomes are unknown':'Some outcomes are unfinished'):report.trend.variable?'Earnings changed during this period':r.direction==='above'?'Earnings above equal share':r.direction==='below'?'Earnings below equal share':'No clear earnings difference';
  const status=r.availability==='available'?(report.trend.variable?badge('Varies over time','amber'):badge('Observed comparison','green')):badge(earningsEvidenceLabel(r),'amber');
  const fScore=r.ratio!==null?`<button class="f-score" data-action="f-score" aria-label="Explain F score ${number(r.ratio,2)}"><span class="f-score-copy"><span>F score</span><strong>${number(r.ratio,2)}</strong><small>1.00 = equal share</small></span>${icon('info')}</button>`:'';
  const primary=r.availability==='available'?`<div class="earnings-headline-metrics"><div class="reward-number ${r.differencePercent<0?'negative':''}">${signed(r.differencePercent,1)}<span class="suffix">vs equal share</span></div>${fScore}</div>`:'';
  const body=networkTotal&&r.availability==='available'?'All recorded Supplier distributions sum to the payout pool. Actual and equal-share totals coincide by construction; F = 1 is not a network-quality assessment. Compare a fleet or domain to examine relative earnings.':r.availability==='available'?(report.trend.variable?'The month’s overall comparison hides a shift. See the weeks below.':r.direction==='no_clear_difference'?'The estimated range includes equal sharing. It does not establish an exact match.':'Your earnings compared with equal sharing among the Suppliers selected into those sessions.'):
    noEligible?'This service has registrations in the directory, but no eligible Suppliers from this scope during the period.':plainEvidenceReason(r.reason);
  const maximum=Math.max(r.actualPokt??0,r.equalSharePokt??0,1);
  const difference=(r.actualPokt??0)-(r.equalSharePokt??0);
  const bars=r.actualPokt!==null?`<div class="reward-bars" role="img" aria-label="Actual earnings ${money(r.actualPokt)}. Equal-share comparison ${money(r.equalSharePokt)}.">${[['Actual earnings',r.actualPokt,'actual'],['Equal-share amount',r.equalSharePokt,'']].map(([label,value,cls])=>`<div class="money-row"><span>${label}</span><strong>${money(value)}</strong><div class="money-bar-track"><div class="money-bar ${cls}" style="width:${value/maximum*100}%"></div></div></div>`).join('')}<p class="earnings-amount-difference">${difference>=0?'+':'−'}${money(Math.abs(difference))} ${r.availability==='available'?(difference>=0?'above':'below')+' equal share':'difference across covered sessions'}</p></div>`:'';
  const range=r.intervalDifferencePercent?`<div class="range-line">95% range: ${signed(r.intervalDifferencePercent[0],1)} to ${signed(r.intervalDifferencePercent[1],1)}<button data-action="uncertainty" aria-label="Explain the uncertainty range">${icon('info')}</button></div>`:r.availability==='limited'?`<div class="range-line">Uncertainty range unavailable <button data-action="uncertainty" aria-label="Why the range is unavailable">${icon('info')}</button></div>`:'';
  const provisional=r.availability!=='available'&&r.ratio!==null?`<div class="provisional-score">${fScore}<span>${signed(r.differencePercent,1)} across covered sessions.<br>This is not a supported period-wide result.</span></div>`:'';
  const serviceGaps=report.services.length>1?report.perService.filter(row=>row.comparableSessions<row.recordedSessions||(row.availability==='limited'&&row.equalSharePokt>0)):[];
  const context=r.availability==='partial'?`<div class="subtle-notice warning">${icon('info')}<span>Both amounts cover the same ${r.comparableSessions} comparable sessions. Missing and pending outcomes are excluded.${live?` <button class="text-action" data-action="${settled?'earnings-scope':'live-coverage'}">Why is coverage partial?</button>`:''}</span></div>`:serviceGaps.length?`<div class="subtle-notice warning">${icon('info')}<span>${serviceGaps.length===1?esc(serviceGaps[0].label):`${serviceGaps.length} services`} ${serviceGaps.length===1?'has':'have'} incomplete or limited evidence. <button class="text-action" data-action="evidence">Check service coverage</button></span></div>`:'';
  return `<section class="card reward-card" aria-labelledby="reward-title"><div class="card-head"><div class="eyebrow">Earnings · ${esc(periodLabel(report.period))}</div>${status}</div><h2 class="reward-headline" id="reward-title">${headline}</h2>${primary}<p class="reward-summary">${esc(body)}</p>${range}${bars}${provisional}${context}<div class="reward-foot card-divider"><span>${number(r.informativeDays)} informative days · ${number(r.positiveSessions)} reward opportunities</span><button class="text-action" data-action="calculation">How is this compared? ${icon('chevron')}</button></div></section>`;
}

function exposureCard(report) {
  const e=report.exposure;
  const change=report.services.length===1&&e.eligibleRange&&e.eligibleRange[0]!==e.eligibleRange[1];
  const absent=e.verifiedSessions-e.presentSessions;
  const visual=e.presenceFraction!==null?`<div class="presence-visual" role="img" aria-label="${e.presentSessions} verified sessions selected at least one of your Suppliers; ${absent} selected none."><div class="presence-track"><span style="width:${e.presenceFraction*100}%"></span></div><div class="presence-labels"><span><i class="actual-key"></i><strong>${number(e.presentSessions)}</strong> with yours</span><span><i class="reference-key"></i><strong>${number(absent)}</strong> without yours</span></div></div>`:'';
  return `<section class="card exposure-card" aria-labelledby="exposure-title"><div class="card-head"><div><div class="eyebrow">Observed in this period</div><h2 id="exposure-title">How often were you selected?</h2></div><button class="icon-btn quiet" data-action="selection-explain" aria-label="Explain session selection">${icon('info')}</button></div><div class="exposure-stat"><div class="large tabular">${percent(e.presenceFraction,1)}</div><p>of ${settled?'sampled ':''}verified sessions selected<br>at least one of your Suppliers</p>${visual}<small>${number(e.presentSessions)} of ${number(e.verifiedSessions)} verified sessions.${report.services.length>1?` Across ${report.services.length} selected services.`:''}</small></div><div class="secondary-stat"><strong>${number(e.meanSelected,2)}</strong><span>of your Suppliers selected per session<br>on average, including sessions with none</span></div>${change?`<div class="subtle-notice">${icon('info')}<span>Your eligible count ranged from ${e.eligibleRange[0]} to ${e.eligibleRange[1]} during this period.</span></div>`:''}${e.missingRosters?`<div class="subtle-notice warning">${icon('info')}<span>${e.missingRosters} unknown rosters are excluded.</span></div>`:''}<div class="card-divider"><p class="selection-caption">Selection measures access to a session’s requests. It does not measure the traffic served.</p><button class="text-action" data-action="selection-explain">Understand selection ${icon('chevron')}</button></div></section>`;
}

function summaryPage(report) {
  const services=report.services.length>1?`<section class="card service-mix-card"><div class="card-head"><div><h2>One fleet. Different services.</h2><p>The combined result uses POKT totals. A higher-value service has more influence.</p></div><button class="text-action" data-action="dimension-shortcut" data-dimension="service">Compare services ${icon('arrow')}</button></div>${groupChart(report.perService.slice().sort((a,b)=>(b.equalSharePokt??0)-(a.equalSharePokt??0)).slice(0,5),'service',true)}${report.perService.length>5?`<p class="chart-caption">Showing 5 of ${report.perService.length} selected services. Compare services to see every result.</p>`:''}</section>`:'';
  return `<div class="summary-grid">${rewardCard(report)}${exposureCard(report)}</div>${trendCard(report)}${services}${scenarioCard(report)}<div class="summary-followup"><div><h3>Where do the differences come from?</h3><p>Compare groups, or test whether an earlier earnings estimate held up.</p></div><div class="followup-actions"><button class="btn" data-action="view" data-view="breakdown">Explore breakdown ${icon('arrow')}</button><button class="text-action" data-action="view" data-view="predictions">Test an estimate ${icon('chevron')}</button></div></div>`;
}

function scenarioMaximum(reference) {
  const target=countForTarget(reference,.99,state.minimum)??Math.max(reference.ownEligible*3,200);
  return Math.min(100000,Math.max(100,Math.ceil(Math.max(target,reference.ownEligible*2,state.scenarioCount??0)/25)*25));
}

function scenarioCard(report) {
  const reference=scenarioReferenceFor(report);
  if(!reference)return `<section class="card scenario-card"><h2>Fleet size and session selection</h2><p>A dated population reference is needed for this scenario.</p></section>`;
  const own=state.scenarioCount??reference.ownEligible;
  const scenario=exposureScenario(reference,own,state.minimum);
  const base=exposureScenario(reference,reference.ownEligible,state.minimum);
  const maximum=scenarioMaximum(reference);
  const custom=state.customMinimum||![1,2,3,5].includes(state.minimum);
  return `<section class="card scenario-card" aria-labelledby="scenario-title"><div class="card-head"><div><h2 id="scenario-title">What if your fleet changed?</h2><p>Change your eligible Supplier count and see the chance of being selected. Reference: ${dateLabel(reference.observedAt)} ${new Date(reference.observedAt).getUTCFullYear()}.</p></div><button class="btn small ghost" data-action="reset-scenario">${icon('reset')} Reset</button></div>${report.services.length>1?`<div class="scenario-service-context"><label for="scenario-service-select">Selection model for<select id="scenario-service-select">${report.services.map(service=>`<option value="${service.id}" ${service.id===reference.serviceId?'selected':''}>${esc(service.name)}</option>`).join('')}</select></label><span>Selection is calculated separately for each service.</span></div>`:''}<div class="selection-question"><span>What chance do you want to explore?</span><label for="selection-minimum">Select at least <select id="selection-minimum">${[1,2,3,5].map(minimum=>`<option value="${minimum}" ${!custom&&state.minimum===minimum?'selected':''}>${minimum} of yours</option>`).join('')}<option value="custom" ${custom?'selected':''}>Custom count</option></select></label><label class="custom-minimum" for="selection-minimum-custom" ${custom?'':'hidden'}><span>Selected Suppliers</span><input type="number" id="selection-minimum-custom" min="1" max="100000" step="1" value="${state.minimum}"></label></div>${state.minimum>reference.selectionCap?`<p class="minimum-notice" role="status">This service selects up to ${reference.selectionCap} Suppliers per session. Selecting at least ${state.minimum} is impossible under that cap.</p>`:''}<div class="scenario-layout"><div class="scenario-controls"><div class="scenario-label-line"><label for="scenario-count">Your eligible Suppliers</label><input class="count-input" type="number" id="scenario-number" aria-label="Exact eligible Supplier count" min="0" max="100000" step="1" value="${own}"></div><input class="scenario-slider" id="scenario-count" type="range" min="0" max="${maximum}" step="1" value="${own}" aria-label="Your eligible Suppliers" aria-valuetext="${own} eligible Suppliers"><div class="slider-labels"><span>0</span><span id="scenario-max-label">${number(maximum)}</span></div><div class="scenario-metrics" id="scenario-metrics" aria-live="polite">${scenarioMetricContent(scenario,base)}</div><div class="scenario-targets"><span>Find a fleet size for</span>${[.9,.95,.99].map(target=>`<button class="target-button" data-action="scenario-target" data-target="${target}" aria-pressed="${state.target===target}">${targetLabel(target)}</button>`).join('')}</div><form id="scenario-target-form" class="custom-target"><label for="scenario-target-percent">Custom target</label><span class="percent-input"><input type="number" id="scenario-target-percent" min="0.000001" max="100" step="any" value="${state.target?Number((state.target*100).toFixed(6)):95}" aria-label="Custom selection chance, percent" required><span aria-hidden="true">%</span></span><button class="btn small" type="submit">Find count</button></form><p class="target-message" id="target-message" role="status">${state.target?targetMessage(reference,state.target):`Targets refer to selecting at least ${state.minimum} of your Suppliers in a session.`}</p></div><div class="scenario-chart-area"><div id="scenario-chart">${scenarioCurve(reference,scenario,maximum)}</div><div class="chart-legend"><span class="legend-item"><span class="legend-line"></span>Chance of selecting at least ${state.minimum} of yours</span><span class="legend-item"><span class="legend-dot recorded"></span>Recorded count</span><span class="legend-item"><span class="legend-dot"></span>Your scenario</span></div><p class="scenario-formula" id="scenario-formula">${scenarioFormula(scenario)}</p></div></div><div class="scenario-bottom"><span>Other eligible Suppliers stay fixed. Earnings above remain historical.</span><button class="text-action" data-action="scenario-explain">Model assumptions ${icon('info')}</button></div></section>`;
}

function scenarioMetricContent(scenario,base) {
  const change=(scenario.selectionChance-base.selectionChance)*100;
  const unchanged=scenario.ownEligible===base.ownEligible;
  const changeText=unchanged?'At the recorded count':Math.abs(change)<.05?'Similar selection chance':`${change>0?'+':'−'}${number(Math.abs(change),1)} percentage points`;
  const positionChange=scenario.expectedPositions-base.expectedPositions;
  return `<div class="scenario-metric"><strong>${chanceLabel(scenario.selectionChance)}</strong><span>chance of selecting <b>at least ${state.minimum} of yours</b> per session</span><small>${changeText}</small></div><div class="scenario-metric"><strong>${number(scenario.expectedPositions,2)}</strong><span>expected selected per session</span><small>${unchanged?'At the recorded count':Math.abs(positionChange)<.005?'Similar position count':`${positionChange>0?'+':'−'}${number(Math.abs(positionChange),2)} vs recorded count`}</small></div>`;
}

function scenarioFormula(scenario) {
  return `${number(scenario.ownEligible)} yours + ${number(scenario.otherEligible)} other Suppliers = ${number(scenario.totalEligible)} eligible. ${number(scenario.selected)} selected per draw.`;
}

function targetMessage(reference,target) {
  const count=countForTarget(reference,target,state.minimum);
  return count===null?`A ${targetLabel(target)} chance of at least ${state.minimum} selected cannot be reached within the model’s cap and 100,000-Supplier limit.`:`${number(count)} eligible Suppliers are the smallest fleet that reaches a ${targetLabel(target)} chance of at least ${state.minimum} selected.`;
}

function scenarioCurve(reference,scenario,maximum) {
  const width=540,height=238,left=42,right=12,top=15,bottom=38;
  const x=value=>left+value/maximum*(width-left-right),y=value=>top+(1-value)*(height-top-bottom);
  const points=Array.from({length:85},(_,i)=>{const count=Math.round(i/84*maximum);return [count,exposureScenario(reference,count,state.minimum).selectionChance];});
  const path=points.map(([count,chance],i)=>`${i?'L':'M'}${x(count).toFixed(2)},${y(chance).toFixed(2)}`).join(' ');
  const area=`${path} L${x(maximum)},${y(0)} L${x(0)},${y(0)} Z`;
  const recorded=exposureScenario(reference,reference.ownEligible,state.minimum);
  const target=state.target??.95;
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Chance of selecting at least ${state.minimum} of your Suppliers per session, by eligible fleet size. Recorded ${reference.ownEligible} Suppliers: ${chanceLabel(recorded.selectionChance)}. Scenario ${scenario.ownEligible} Suppliers: ${chanceLabel(scenario.selectionChance)}."><defs><linearGradient id="scenario-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#d5e0ff" stop-opacity=".6"/><stop offset="100%" stop-color="#edf1fc" stop-opacity=".15"/></linearGradient></defs>${[0,.25,.5,.75,1].map(value=>`<line x1="${left}" x2="${width-right}" y1="${y(value)}" y2="${y(value)}" class="chart-grid"/><text x="${left-9}" y="${y(value)+3}" text-anchor="end" class="chart-axis">${value*100}%</text>`).join('')}<path d="${area}" fill="url(#scenario-fill)"/><line x1="${left}" x2="${width-right}" y1="${y(target)}" y2="${y(target)}" class="chart-zero"/><text x="${width-right}" y="${Math.max(top+10,y(target)-7)}" text-anchor="end" class="chart-axis" style="font-size:9px">${targetLabel(target)} target</text><path d="${path}" fill="none" stroke="#203ea9" stroke-width="2.5"/>${[0,.25,.5,.75,1].map(value=>`<text x="${x(maximum*value)}" y="${height-bottom+18}" text-anchor="middle" class="chart-axis">${number(Math.round(maximum*value))}</text>`).join('')}<text x="${width/2}" y="${height-3}" text-anchor="middle" class="chart-axis">Your eligible Supplier count</text><circle cx="${x(reference.ownEligible)}" cy="${y(recorded.selectionChance)}" r="4.5" fill="#ffd60a" stroke="white" stroke-width="1.5" ${tip(`Recorded count: ${reference.ownEligible}\nSelection chance: ${chanceLabel(recorded.selectionChance)}`)}/><line x1="${x(scenario.ownEligible)}" x2="${x(scenario.ownEligible)}" y1="${y(scenario.selectionChance)}" y2="${y(0)}" stroke="#8096cf" stroke-width="1" stroke-dasharray="3 4"/><circle cx="${x(scenario.ownEligible)}" cy="${y(scenario.selectionChance)}" r="6" fill="white" stroke="#203ea9" stroke-width="2.5" ${tip(`Your scenario: ${scenario.ownEligible} Suppliers\nSelection chance: ${chanceLabel(scenario.selectionChance)}\nExpected selected: ${number(scenario.expectedPositions,2)}`)}/></svg>`;
}

function updateScenario(count,{save=false,fromNumber=false}={}) {
  const reference=currentReport?scenarioReferenceFor(currentReport):null;
  if(!reference)return;
  state.scenarioCount=Math.max(0,Math.min(100000,Math.round(Number(count)||0)));
  const scenario=exposureScenario(reference,state.scenarioCount,state.minimum),base=exposureScenario(reference,reference.ownEligible,state.minimum);
  const range=document.getElementById('scenario-count'),numeric=document.getElementById('scenario-number');
  if(fromNumber&&state.scenarioCount>Number(range.max)) {range.max=String(scenarioMaximum(reference));document.getElementById('scenario-max-label').textContent=number(Number(range.max));}
  range.value=String(state.scenarioCount);range.setAttribute('aria-valuetext',`${state.scenarioCount} eligible Suppliers`);
  if(!fromNumber || save)numeric.value=String(state.scenarioCount);
  document.getElementById('scenario-metrics').innerHTML=scenarioMetricContent(scenario,base);
  document.getElementById('scenario-chart').innerHTML=scenarioCurve(reference,scenario,Number(range.max));
  document.getElementById('scenario-formula').textContent=scenarioFormula(scenario);
  if(save)writeRoute(false);
}

function trendCard(report) {
  if(live&&collectedDays<7)return `<section class="card trend-card"><div class="card-head"><div><h2>Longer trends need more history</h2><p>This snapshot covers ${collectedDays} ${collectedDays===1?'day':'days'}. Weekly changes and a separate earnings test become useful after more observations are collected.</p></div>${badge('Pilot window','amber')}</div><button class="text-action" data-action="dimension-shortcut" data-dimension="hour">Compare sampled UTC windows ${icon('arrow')}</button></section>`;
  const rows=report.trend.points.map(point=>({...point,label:point.label,id:point.id,description:`${point.informativeDays} informative days`}));
  return `<section class="card trend-card"><div class="card-head"><div><h2>${report.trend.variable?'Earnings changed during this period':'Earnings through the period'}</h2><p>Actual and equal-share POKT by week, using the same covered sessions. Select a week to investigate.</p></div>${report.trend.variable?badge('Time matters','amber'):''}</div>${timeSeriesChart(rows,'week','amounts')}<p class="chart-caption">Higher amounts can reflect more opportunity or a longer week. The point details show the relative difference and evidence.</p><button class="text-action" data-action="dimension-shortcut" data-dimension="week">Compare weeks ${icon('arrow')}</button></section>`;
}

function dimensionExplanation(dimension) {
  if(live&&dimension==='infrastructure')return 'Backend infrastructure has not been independently attributed. Use owner, Supplier or hostname comparisons.';
  if(live&&dimension==='fleet')return `Compare recorded owner-address groups in the same ${settled?'indexed settled':'sampled'} sessions. A group is not a verified business.`;
  if(live&&dimension==='gateway')return 'Gateway attribution is not collected in this snapshot. Unmapped sessions remain visible.';
  return {
    infrastructure:'Compare the explicitly recorded groups within this fictional fleet.',
    service:'See each selected service on its own. The combined F score uses total POKT amounts, not an average of service scores.',
    fleet:live?'Compare historical owner-address groups in the collected sessions. A group is not a verified business.':'Compare the explicitly identified fleets within this fictional sample. These are descriptive comparisons, not a league table.',
    hostname:'Compare recorded endpoint hosts. A Supplier can appear under more than one hostname.',
    domain:'Compare recorded service endpoints by domain. A Supplier can belong to more than one domain; these totals must not be added.',
    owner:settled?'Payments follow the owner in each exact session-end roster.':'Membership follows each owner at the time of the observation.',
    supplier:settled?'Each row follows one Supplier’s recorded payments and selected-session opportunity.':'Each row measures one Supplier identity using its own eligibility and selections.',
    gateway:'Gateway relationships are fictional and explicitly recorded here. Unmapped traffic stays visible.',
    application:live?'Compare the recorded requesting Application addresses. Gateway attribution is not inferred.':'Explore requesting identities within Gateway traffic. Each row retains its own coverage.',
    week:'Compare the weekly periods shown within this collection. Short periods can have weaker evidence.',
    hour:settled?'Compare four six-hour UTC windows by recorded session end. These associations do not establish a cause.':'Compare four six-hour UTC windows. Differences describe associations, not their cause.',
    selected_count:'Group sessions by how many of this scope’s Suppliers were actually selected. This is separate from changing fleet size.',
    session_value:'Group by the recorded gross payout pool. It measures settled payouts, not all possible demand.'
  }[dimension];
}

function breakdownPage(report) {
  currentBreakdown=adapter.getBreakdown(queryForView(),state.dimension,{limit:state.groupLimit});
  const rows=currentBreakdown.rows;
  const totalGroups=currentBreakdown.totalGroups??rows.length;
  const shown=rows.slice(0,state.groupLimit);
  const title=DIMENSIONS.find(([id])=>id===state.dimension)?.[1]??'Fleet groups';
  return `<div class="breakdown-heading"><label class="dimension-label" for="dimension-select">Compare by<select id="dimension-select">${DIMENSIONS.filter(([id])=>id!=='fleet'||report.scope.fleetNames.length>1).map(([id,label])=>`<option value="${id}" ${state.dimension===id?'selected':''}>${label}</option>`).join('')}</select></label><div class="breakdown-summary">${badge(`${totalGroups} ${totalGroups===1?'group':'groups'}`)}<span>${esc(report.service.name)} · ${esc(periodLabel(report.period))}</span></div></div><section class="card"><div class="breakdown-title"><div><h2>${esc(title)}</h2><p>${esc(dimensionExplanation(state.dimension))}</p></div><div class="chart-switch" role="group" aria-label="Chart measure">${[['difference','Vs equal share'],['amounts','POKT amounts']].map(([id,label])=>`<button data-action="chart-metric" data-metric="${id}" aria-pressed="${state.chartMetric===id}" class="${state.chartMetric===id?'active':''}">${label}</button>`).join('')}</div></div>${rows.length?groupChart(shown,state.dimension):`<div class="empty-panel"><h3>No groups in this view</h3><p>Try a different dimension, remove a filter or choose another service.</p></div>`}${totalGroups>shown.length?`<button class="btn small show-more" data-action="more-groups">Show ${Math.min(24,totalGroups-shown.length)} more groups</button>`:''}<p class="chart-caption">${state.chartMetric==='amounts'?'Dots show actual and equal-share amounts on a shared POKT scale.':'0% means equal share. Right of the reference means higher earnings; left means lower.'} The percentage and F score describe the same comparison. Select a group to explore it.</p>${currentBreakdown.note?`<div class="subtle-notice">${icon('info')}<span>${esc(currentBreakdown.note)}</span></div>`:''}</section><details class="details"><summary>Exact amounts and group evidence</summary><div class="details-body">${groupTable(shown)}${totalGroups>shown.length?`<p class="chart-caption">Showing ${shown.length} of ${totalGroups} groups. Use Show more groups to continue; the JSON export includes every group.</p>`:''}</div></details><div class="analysis-next"><span>Want to examine the underlying sessions?</span><button class="text-action" data-action="view" data-view="diagnostics">Open diagnostics ${icon('arrow')}</button></div>`;
}

function rowEvidence(row) {
  const range=row.intervalDifferencePercent?`95% range: ${row.intervalDifferencePercent.map(value=>signed(value,1)).join(' to ')}`:'95% range unavailable';
  return `${row.label}\nActual: ${money(row.actualPokt)}\nEqual share: ${money(row.equalSharePokt)}\nF score: ${number(row.ratio,2)} · ${signed(row.differencePercent,1)}\n${range}\n${row.informativeDays} days with opportunity · ${row.positiveSessions} earnings opportunities\n${settled?'Verified recorded settlements':'Original sampled payout evidence'}: ${row.comparableSessions} / ${row.recordedSessions}\n${plainEvidenceReason(row.reason)||'Historical earnings comparison'}`;
}

function groupChart(rows,dimension,compact=false) {
  if(dimension==='week'||dimension==='hour')return timeSeriesChart(rows,dimension,compact?'difference':state.chartMetric);
  const metric=compact?'difference':state.chartMetric;
  const maximum=Math.max(1,...rows.flatMap(row=>[row.actualPokt??0,row.equalSharePokt??0]));
  const extent=Math.max(10,...rows.map(row=>Math.abs(row.differencePercent??0)))*1.1;
  const pos=value=>metric==='amounts'?8+value/maximum*284:150+value/extent*142;
  const legend=metric==='amounts'?`<div class="comparison-legend"><span><i class="actual-key"></i>Actual earnings</span><span><i class="reference-key"></i>Equal-share amount</span><span class="comparison-scale">Shared scale · 0 to ${money(maximum)}</span></div>`:`<div class="comparison-legend"><span>Difference versus equal share</span><span class="comparison-scale">Shared scale · ${signed(-extent,0)} to ${signed(extent,0)} · centre = 0%</span></div>`;
  return `${legend}<div class="comparison-chart">${rows.map(row=>{
    const info=rowEvidence(row),colour=row.differencePercent<0?'#805300':'#203ea9';
    const visual=metric==='amounts'?`<svg class="comparison-dots" viewBox="0 0 300 36" aria-hidden="true"><line x1="8" x2="292" y1="18" y2="18" stroke="#edf0f4" stroke-width="3"/>${row.actualPokt===null?'':`<line x1="${pos(Math.min(row.actualPokt,row.equalSharePokt))}" x2="${pos(Math.max(row.actualPokt,row.equalSharePokt))}" y1="18" y2="18" stroke="#b6c3df" stroke-width="3"/><circle cx="${pos(row.equalSharePokt)}" cy="18" r="5" fill="#98a6b4"/><circle cx="${pos(row.actualPokt)}" cy="18" r="5" fill="#203ea9"/>`}</svg>`:`<svg class="comparison-difference" viewBox="0 0 300 36" aria-hidden="true"><line x1="8" x2="292" y1="18" y2="18" stroke="#edf0f4" stroke-width="3"/><line x1="150" x2="150" y1="4" y2="32" stroke="#98a6b4" stroke-dasharray="3 3"/>${row.ratio===null?'':`<line x1="150" x2="${pos(row.differencePercent)}" y1="18" y2="18" stroke="${colour}" stroke-width="3"/><circle cx="${pos(row.differencePercent)}" cy="18" r="5" fill="${colour}"/>`}</svg>`;
    const quality=earningsEvidenceLabel(row,`${row.informativeDays} days with opportunity`);
    return `<button class="comparison-row ${row.availability==='available'?'':'constrained'}" data-action="filter-group" data-dimension="${dimension}" data-value="${esc(row.id)}" aria-label="Explore ${esc(info)}" ${tip(info)}><span class="comparison-label">${esc(dimension==='owner'?shortId(row.label):row.label)}<small>${esc(quality)}</small>${row.description?`<small>${esc(row.description)}</small>`:''}</span><span class="comparison-body">${visual}<span class="comparison-amounts"><span>Actual <b>${money(row.actualPokt)}</b></span><span>Equal share <b>${money(row.equalSharePokt)}</b></span></span></span><span class="comparison-value"><strong style="color:${colour}">${row.ratio===null?'—':signed(row.differencePercent,1)}</strong><small>${row.ratio===null?'No score yet':'vs equal share'}</small><span class="comparison-ratio">F score ${number(row.ratio,2)}</span></span></button>`;
  }).join('')}</div>`;
}

function timeSeriesChart(rows,dimension,metric='amounts') {
  const width=680,height=252,left=55,right=19,top=24,bottom=44;
  const values=rows.flatMap(row=>metric==='amounts'?[row.actualPokt,row.equalSharePokt]:[row.differencePercent]).filter(value=>value!==null);
  const low=metric==='amounts'?0:Math.min(-10,...values)*1.15,high=Math.max(1,...values)*1.15;
  const x=index=>left+(rows.length>1?index/(rows.length-1):.5)*(width-left-right),y=value=>height-bottom-(value-low)/(high-low)*(height-top-bottom);
  const path=field=>{let open=false;return rows.map((row,index)=>{const value=row[field];if(value===null){open=false;return '';}const command=open?'L':'M';open=true;return `${command}${x(index).toFixed(1)},${y(value).toFixed(1)}`;}).join(' ');};
  const mainField=metric==='amounts'?'actualPokt':'differencePercent';
  const firstPoint=rows.findIndex(row=>row[mainField]!==null);
  const chart=`<svg class="time-chart" viewBox="0 0 ${width} ${height}" role="group" aria-label="${metric==='amounts'?'Actual earnings and equal share':'Earnings difference'} over ${dimension==='week'?'the weeks':'UTC time windows'}. Select a point to explore that period.">
    ${[0,.5,1].map(value=>{const v=low+(high-low)*value;return `<line x1="${left}" x2="${width-right}" y1="${y(v)}" y2="${y(v)}" class="chart-grid"/><text x="${left-9}" y="${y(v)+4}" text-anchor="end" class="chart-axis">${metric==='amounts'?number(v,0):signed(v,0)}</text>`;}).join('')}
    ${metric==='difference'?`<line x1="${left}" x2="${width-right}" y1="${y(0)}" y2="${y(0)}" class="chart-zero"/><text x="${width-right}" y="${y(0)-7}" text-anchor="end" class="chart-axis">Equal share</text>`:`<path d="${path('equalSharePokt')}" fill="none" stroke="#98a6b4" stroke-width="2.4" stroke-dasharray="5 4"/>`}
    <path d="${path(mainField)}" fill="none" stroke="#203ea9" stroke-width="2.8"/>
    ${rows.map((row,index)=>`${row[mainField]!==null?`<g class="time-point" tabindex="${index===firstPoint?'0':'-1'}" role="button" data-action="filter-group" data-dimension="${dimension}" data-value="${esc(row.id)}" aria-label="Explore ${esc(rowEvidence(row))}" ${tip(rowEvidence(row))}><circle class="time-hit" cx="${x(index)}" cy="${y(row[mainField])}" r="18" fill="transparent" pointer-events="all"/><circle class="time-dot" cx="${x(index)}" cy="${y(row[mainField])}" r="5" fill="white" stroke="#203ea9" stroke-width="2.5" pointer-events="none"/></g>`:''}<text x="${x(index)}" y="${height-bottom+22}" text-anchor="middle" class="chart-axis">${esc(row.label.replace(' UTC','').replace(':00','').replace(':00',''))}</text>`).join('')}
    <text x="${left}" y="13" class="chart-axis">${metric==='amounts'?'POKT':'Difference · %'}</text></svg>`;
  return `<div class="comparison-legend"><span><i class="actual-key"></i>${metric==='amounts'?'Actual earnings':'Earnings difference'}</span>${metric==='amounts'?'<span><i class="reference-key"></i>Equal share</span>':''}<span class="comparison-scale">Hover or focus for values · select to explore</span></div>${chart}`;
}

function groupTable(rows) {
  return `<div class="table-scroll"><table><thead><tr><th scope="col">Group</th><th scope="col">Actual · POKT</th><th scope="col">Equal share · POKT</th><th scope="col">Difference</th><th scope="col">F score</th><th scope="col">95% range</th><th scope="col">Informative days / opportunities</th><th scope="col">Coverage</th></tr></thead><tbody>${rows.map(row=>`<tr><td>${esc(row.label)}</td><td>${number(row.actualPokt,3)}</td><td>${number(row.equalSharePokt,3)}</td><td>${signed(row.differencePercent,2)}</td><td>${number(row.ratio,3)}</td><td>${row.intervalDifferencePercent?row.intervalDifferencePercent.map(value=>signed(value,2)).join(' to '):'Unavailable'}</td><td>${row.informativeDays} / ${row.positiveSessions}</td><td>${row.comparableSessions} / ${row.recordedSessions}</td></tr>`).join('')}</tbody></table></div><p style="margin-top:10px">Ratios are recalculated from each group’s totals. Group differences are descriptive; intervals alone are not a formal comparison test.</p>`;
}

function selectionDiagnosticView() {
  const d=adapter.getSelectionDiagnostic(queryForView());
  if(!d.sessions)return `<p>No verified selection evidence is available in this scope.</p>`;
  const width=650,height=225,left=42,bottom=34,top=14,right=15;
  const maximum=Math.max(1,...d.bins.flatMap(bin=>[bin.observed,bin.expected,bin.simulationInterval[1]]));
  const y=value=>height-bottom-value/maximum*(height-top-bottom),slot=(width-left-right)/d.bins.length;
  const chart=`<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Observed and modelled selected-count frequencies, with descriptive simulation ranges.">${[0,.5,1].map(value=>`<line x1="${left}" x2="${width-right}" y1="${y(value*maximum)}" y2="${y(value*maximum)}" class="chart-grid"/><text x="${left-7}" y="${y(value*maximum)+3}" text-anchor="end" class="chart-axis">${number(Math.round(value*maximum))}</text>`).join('')}${d.bins.map((bin,index)=>{
    const x=left+index*slot+slot*.17;
    return `<g ${tip(`${bin.label} selected\nObserved: ${number(bin.observed)} sessions\nModel: ${number(bin.expected,1)} sessions\n95% simulation guide: ${number(bin.simulationInterval[0],0)}–${number(bin.simulationInterval[1],0)}`)}><rect x="${x}" y="${y(bin.observed)}" width="${slot*.28}" height="${height-bottom-y(bin.observed)}" fill="#203ea9" rx="2"/><rect x="${x+slot*.32}" y="${y(bin.expected)}" width="${slot*.28}" height="${height-bottom-y(bin.expected)}" fill="#aab5c4" rx="2"/><line x1="${x+slot*.46}" x2="${x+slot*.46}" y1="${y(bin.simulationInterval[0])}" y2="${y(bin.simulationInterval[1])}" stroke="#7e8fa8" stroke-width="1.5"/><text x="${x+slot*.31}" y="${height-13}" text-anchor="middle" class="chart-axis">${bin.label}</text></g>`;
  }).join('')}</svg>`;
  return `<div class="diagnostic-plot">${chart}</div><div class="chart-legend"><span class="legend-item"><span class="legend-dot"></span>Observed sessions</span><span class="legend-item"><span class="legend-dot" style="background:#aab5c4"></span>Model and simulation guide</span></div><p>${esc(d.method)}</p><div class="table-scroll" style="margin-top:13px"><table><thead><tr><th scope="col">Selected count</th><th scope="col">Observed sessions</th><th scope="col">Model expectation</th><th scope="col">95% simulation guide</th></tr></thead><tbody>${d.bins.map(bin=>`<tr><td>${bin.label}</td><td>${bin.observed}</td><td>${number(bin.expected,2)}</td><td>${bin.simulationInterval.map(value=>number(value,0)).join('–')}</td></tr>`).join('')}</tbody></table></div>`;
}

function scatterDiagnosticView() {
  const all=adapter.getSessionPoints(queryForView());
  if(!all.length)return `<p>No covered sessions with positive equal-share opportunity are available.</p>`;
  const extrema=[all.reduce((a,b)=>a.actual/a.reference<b.actual/b.reference?a:b),all.reduce((a,b)=>a.actual/a.reference>b.actual/b.reference?a:b),all.reduce((a,b)=>a.actual>b.actual?a:b),all.reduce((a,b)=>a.reference>b.reference?a:b)];
  const points=all.length<=160?all:[...new Map([...extrema,...Array.from({length:156},(_,index)=>all[Math.floor(index*(all.length-1)/155)])].map(point=>[point.sessionId,point])).values()].sort((a,b)=>a.startedAt.localeCompare(b.startedAt)||a.sessionId.localeCompare(b.sessionId));
  const serviceName=point=>currentReport.services.find(service=>service.id===point.serviceId)?.name??point.serviceId;
  const width=650,height=300,left=53,right=18,top=20,bottom=43;
  const maxX=Math.max(...all.flatMap(point=>[point.reference,point.actual]))*1.05,maxY=maxX;
  const x=value=>left+value/maxX*(width-left-right),y=value=>height-bottom-value/maxY*(height-top-bottom);
  const lineLimit=Math.min(maxX,maxY);
  const chart=`<svg viewBox="0 0 ${width} ${height}" role="group" aria-label="Session payouts versus the value of selected opportunity. Use arrow keys between points, then Enter to inspect a session.">${[0,.5,1].map(v=>`<line x1="${left}" x2="${width-right}" y1="${y(maxY*v)}" y2="${y(maxY*v)}" class="chart-grid"/><text x="${left-8}" y="${y(maxY*v)+3}" text-anchor="end" class="chart-axis">${number(maxY*v,0)}</text><text x="${x(maxX*v)}" y="${height-bottom+18}" text-anchor="middle" class="chart-axis">${number(maxX*v,0)}</text>`).join('')}<line x1="${x(0)}" y1="${y(0)}" x2="${x(lineLimit)}" y2="${y(lineLimit)}" class="chart-zero"/>${points.map((point,index)=>`<circle class="scatter-point" cx="${x(point.reference)}" cy="${y(point.actual)}" r="3.2" fill="#203ea9" fill-opacity=".65" tabindex="${index===0?0:-1}" role="button" data-action="inspect-session" data-session="${esc(point.sessionId)}" aria-label="${esc(serviceName(point))} · ${dateLabel(point.startedAt)}: ${money(point.actual)} actual, ${money(point.reference)} equal share. Inspect this session." ${tip(`${serviceName(point)}\n${dateLabel(point.startedAt)} · ${new Date(point.startedAt).toISOString().slice(11,16)} UTC\nActual: ${money(point.actual)}\nEqual share: ${money(point.reference)}\nSelected Suppliers: ${point.X}`)}/>`).join('')}<text x="${width/2}" y="${height-4}" text-anchor="middle" class="chart-axis">Equal-share opportunity · POKT</text><text transform="translate(13 ${height/2}) rotate(-90)" text-anchor="middle" class="chart-axis">Actual earnings · POKT</text></svg>`;
  return `<div class="diagnostic-plot">${chart}</div><p>The dashed line represents equal sharing. ${all.length>points.length?`Showing ${points.length} sampled observations, including the extremes, from ${all.length} covered reward opportunities. Both axes use the complete set.`:`Showing all ${all.length} covered reward opportunities.`} Totals use every included session.</p><p style="margin-top:9px">Hover for values; select a point to inspect the session. Keyboard users can use the arrow keys and Enter.</p><details class="details"><summary>First 30 session records</summary><div class="details-body"><div class="table-scroll"><table><thead><tr><th scope="col">UTC time</th><th scope="col">Service</th><th scope="col">Selected</th><th scope="col">Actual · POKT</th><th scope="col">Equal share · POKT</th></tr></thead><tbody>${all.slice(0,30).map(point=>`<tr><td><button data-action="inspect-session" data-session="${esc(point.sessionId)}">${esc(point.startedAt.slice(0,16).replace('T',' '))}</button></td><td>${esc(serviceName(point))}</td><td>${point.X}</td><td>${number(point.actual,3)}</td><td>${number(point.reference,3)}</td></tr>`).join('')}</tbody></table></div><p style="margin-top:9px">The result download includes all session records.</p></div></details>`;
}


function predictionRange(period) {
  return `${dateLabel(period.start)} – ${dateLabel(new Date(+new Date(period.endExclusive)-1))}`;
}

function predictionChart(result) {
  const rows=result.daily,width=700,height=280,left=55,right=18,top=24,bottom=42;
  const maximum=Math.max(1,...rows.flatMap(day=>[day.actualPokt,day.equalSharePokt,day.earlierEstimatePokt]))*1.12;
  const first=+new Date(rows[0].date),last=+new Date(rows.at(-1).date);
  const x=day=>left+(last===first ? .5 : (+new Date(day.date)-first)/(last-first))*(width-left-right);
  const y=value=>height-bottom-value/maximum*(height-top-bottom);
  const path=field=>rows.map((day,i)=>`${i?'L':'M'}${x(day).toFixed(2)},${y(day[field]).toFixed(2)}`).join(' ');
  const pointInfo=day=>`${dateLabel(day.date)}\nActual earnings: ${money(day.actualPokt)}\nEarlier estimate: ${money(day.earlierEstimatePokt)}\nEqual-share amount: ${money(day.equalSharePokt)}\n${day.comparableSessions} comparable sessions`;
  return `<div class="comparison-legend prediction-legend"><span><i class="actual-key"></i>Actual earnings</span><span><i class="estimate-key"></i>Earlier estimate</span><span><i class="reference-key"></i>Equal share</span><span class="comparison-scale">Daily POKT · hover or select a day</span></div><svg class="prediction-chart" viewBox="0 0 ${width} ${height}" role="group" aria-label="Later daily earnings compared with an estimate fitted only to earlier outcomes and with equal sharing. Use arrow keys to move between days, then Enter for values.">${[0,.5,1].map(v=>`<line x1="${left}" x2="${width-right}" y1="${y(v*maximum)}" y2="${y(v*maximum)}" class="chart-grid"/><text x="${left-9}" y="${y(v*maximum)+4}" text-anchor="end" class="chart-axis">${number(v*maximum,0)}</text>`).join('')}<text x="${left}" y="13" class="chart-axis">POKT per day</text><path d="${path('equalSharePokt')}" fill="none" stroke="#98a6b4" stroke-width="2" stroke-dasharray="3 5"/><path d="${path('earlierEstimatePokt')}" fill="none" stroke="#805300" stroke-width="2.5" stroke-dasharray="7 4"/><path d="${path('actualPokt')}" fill="none" stroke="#203ea9" stroke-width="2.8"/>${rows.map((day,index)=>`<g class="prediction-point" tabindex="${index===0?0:-1}" role="button" data-action="prediction-day" data-date="${day.date}" aria-label="${esc(pointInfo(day))}. Inspect this day." ${tip(pointInfo(day))}><circle class="prediction-hit" cx="${x(day)}" cy="${y(day.actualPokt)}" r="16" fill="transparent" pointer-events="all"/><circle class="prediction-dot" cx="${x(day)}" cy="${y(day.actualPokt)}" r="4" fill="white" stroke="#203ea9" stroke-width="2" pointer-events="none"/></g>${index===0||index===rows.length-1||index%5===0?`<text x="${x(day)}" y="${height-17}" text-anchor="middle" class="chart-axis">${dateLabel(day.date)}</text>`:''}`).join('')}</svg><label class="prediction-day-picker" for="prediction-day-select">Inspect a day<select id="prediction-day-select"><option value="">Choose a day</option>${rows.map(day=>`<option value="${day.date}">${dateLabel(day.date)} · ${money(day.actualPokt)} actual</option>`).join('')}</select></label>`;
}

function persistenceDiagnosticView() {
  const result=adapter.getPersistenceDiagnostic(queryForView());
  if(result.availability!=='available')return `<div class="empty-panel" style="margin-top:0"><h3>${state.period!=='30'?'Use 30 days for this test':'Separate earlier and later evidence needed'}</h3><p>${esc(plainEvidenceReason(result.reason))}</p>${state.period!=='30'?`<button class="btn" data-action="prediction-full-month">Use the full month ${icon('arrow')}</button>`:''}<p class="prediction-limit">The recorded earnings and fleet-size selection model remain available in Summary.</p></div>`;
  const improvement=result.improvementFraction;
  const conclusion=improvement===null?'Equal sharing already matched the later daily results.':Math.abs(improvement)<.005?'Both estimates had similar daily errors.':improvement>0?`The earlier estimate reduced the average daily error by ${percent(improvement,1)}.`:`The earlier estimate had ${percent(-improvement,1)} more daily error than equal sharing.`;
  return `<div class="prediction-timeline" aria-label="Separate fitting and evaluation periods"><div><span class="eyebrow">1 · Learn the pattern</span><strong>${predictionRange(result.trainingPeriod)}</strong><small>Earlier F score ${number(result.earlierRatio,2)} · ${result.trainingDays} informative days</small></div><div class="timeline-gap"><span class="eyebrow">Leave a gap</span><strong>${predictionRange(result.gapPeriod)}</strong><small>No fitting or evaluation</small></div><div><span class="eyebrow">2 · Test it later</span><strong>${predictionRange(result.testPeriod)}</strong><small>Later F ${number(result.laterRatio,2)} · ${result.testDays} days · ${percent(result.testCoverage,0)} coverage</small></div></div>${predictionChart(result)}<div class="prediction-results"><div><span>Average daily miss · earlier estimate</span><strong>${money(result.earlierDailyErrorPokt)}</strong></div><div><span>Average daily miss · equal share</span><strong>${money(result.equalDailyErrorPokt)}</strong></div><p>${conclusion}<small>Smaller is better. A miss is the absolute difference between estimated and actual daily earnings.</small></p></div><div class="subtle-notice"><span>Later opportunity is known in this test. The estimate applies the earlier F score to that opportunity, capped at each session’s payout pool. It does not forecast future traffic or guarantee earnings.</span></div><div class="prediction-actions"><button class="text-action" data-action="prediction-method">How is this tested? ${icon('info')}</button><button class="text-action" data-action="view" data-view="summary">Back to Summary ${icon('arrow')}</button></div>`;
}

function predictionsPage(report) {
  return `<section class="card predictions-card"><div class="card-head"><div><div class="eyebrow">Past performance · tested on saved observations</div><h2>Does an earlier estimate hold up?</h2><p>Learn an earnings pattern from earlier sessions, then compare it with later daily results.</p></div>${badge('Historical test','outline')}</div>${persistenceDiagnosticView()}</section>`;
}

function diagnosticsPage() {
  return `<div class="diagnostics-heading"><div><h2>A closer look at the sessions</h2><p>Use these checks to investigate selection and individual earnings.</p></div><nav class="diagnostic-nav" role="tablist" aria-label="Diagnostic views">${[['selection','Selections'],['scatter','Session earnings']].map(([id,label])=>`<button id="diagnostic-${id}" role="tab" aria-selected="${state.diagnostic===id}" aria-controls="diagnostic-panel" tabindex="${state.diagnostic===id?0:-1}" data-action="diagnostic-view" data-diagnostic="${id}" class="${state.diagnostic===id?'active':''}">${label}</button>`).join('')}</nav></div><section class="card" id="diagnostic-panel" role="tabpanel" aria-labelledby="diagnostic-${state.diagnostic}"><h3>${state.diagnostic==='selection'?'Did selection resemble the model?':'How did individual payouts compare?'}</h3><p class="diagnostic-intro">${state.diagnostic==='selection'?'Compare how many of your Suppliers were selected in each verified session with the uniform-selection model.':'Each point is one session. Select it to inspect the underlying amounts and service.'}</p><div id="diagnostic-host"><div class="diagnostic-loading" role="status">Calculating this diagnostic…</div></div></section>`;
}

function loadDiagnosticView() {
  const host=document.getElementById('diagnostic-host');
  if(!host)return;
  const diagnostic=state.diagnostic;
  setTimeout(()=>{
    if(!host.isConnected)return;
    host.innerHTML=diagnostic==='selection'?selectionDiagnosticView():scatterDiagnosticView();
  },20);
}

function predictionDayDialog(date) {
  const result=adapter.getPersistenceDiagnostic(queryForView());
  const day=result.daily?.find(row=>row.date===date);
  if(!day)return;
  openDialog('prediction-day',`Earnings on ${dateLabel(day.date)}`,'One later day in the historical test',`<div class="definition-list">${[['Actual gross earnings',money(day.actualPokt)],['Earlier estimate',money(day.earlierEstimatePokt)],['Equal-share amount',money(day.equalSharePokt)],['Compared sessions',number(day.comparableSessions)],['Estimate’s daily miss',money(Math.abs(day.actualPokt-day.earlierEstimatePokt))],['Equal-share daily miss',money(Math.abs(day.actualPokt-day.equalSharePokt))]].map(([label,value])=>`<div class="definition"><strong>${label}</strong><span>${value}</span></div>`).join('')}</div><p class="dialog-explanation">The estimate uses the earlier F score, the later recorded opportunity and each session’s payout cap. Missing outcomes are excluded from both compared amounts.</p>`);
}

function predictionMethodDialog() {
  const result=adapter.getPersistenceDiagnostic(queryForView());
  openDialog('prediction-method','A historical estimate you can check','Earlier evidence, separate later results',`<p>${esc(result.method??result.reason)}</p><div class="definition-list" style="margin-top:20px"><div class="definition"><strong>Earlier estimate</strong><span>The F score is fitted only to earlier payouts available before the test starts. For each later session, estimated earnings are earlier F × equal-share amount, capped at that session’s gross payout pool.</span></div><div class="definition"><strong>Fair comparison</strong><span>Actual, estimated and equal-share amounts use the same later covered sessions. Daily absolute errors are averaged; lower is better.</span></div><div class="definition"><strong>Interpretation</strong><span>A good historical fit does not establish service quality, profitability, future demand or future earnings. Changing services or filters reruns the test for that scope.</span></div></div>`);
}

function applyScenarioTarget(target) {
  const reference=scenarioReferenceFor(currentReport);
  if(!Number.isFinite(target)||target<=0||target>1){document.getElementById('target-message').textContent='Enter a target greater than 0% and no higher than 100%.';return;}
  state.target=target;
  const count=countForTarget(reference,target,state.minimum);
  if(count!==null)updateScenario(count,{fromNumber:true});
  else document.getElementById('scenario-chart').innerHTML=scenarioCurve(reference,exposureScenario(reference,state.scenarioCount??reference.ownEligible,state.minimum),Number(document.getElementById('scenario-count').max));
  document.getElementById('scenario-target-percent').value=String(Number((target*100).toFixed(6)));
  document.getElementById('target-message').textContent=targetMessage(reference,target);
  document.querySelectorAll('[data-action="scenario-target"]').forEach(button=>button.setAttribute('aria-pressed',Number(button.dataset.target)===target?'true':'false'));
  writeRoute(false);
}

function clearScenarioTarget() {
  state.target=null;
  document.querySelectorAll('[data-action="scenario-target"]').forEach(button=>button.setAttribute('aria-pressed','false'));
  document.getElementById('target-message').textContent=`Targets refer to selecting at least ${state.minimum} of your Suppliers in a session.`;
}

function updateMinimum(value) {
  const minimum=Number(value);
  if(!Number.isInteger(minimum)||minimum<1||minimum>100000){document.getElementById('selection-minimum-custom').value=String(state.minimum);toast('Use a whole number from 1 to 100,000.');return;}
  state.minimum=minimum;state.target=null;render();
}

function openDialog(kind,title,subtitle,body,{drawer=false}={}) {
  if(!productDialog.open)dialogReturnFocus=document.activeElement;
  modalKind=kind;
  productDialog.className=drawer?'drawer':'';
  productDialog.innerHTML=`<div class="dialog-header"><div><h2 id="dialog-title">${title}</h2>${subtitle?`<p>${subtitle}</p>`:''}</div><button class="icon-btn" data-action="close-dialog" aria-label="Close dialog">${icon('close')}</button></div><div class="dialog-body">${body}</div>`;
  if(!productDialog.open)productDialog.showModal();
  (productDialog.querySelector('[autofocus]')??productDialog.querySelector('.icon-btn'))?.focus();
}

function finishDialog() {
  modalKind=null;hideTooltip();
  const origin=dialogReturnFocus;dialogReturnFocus=null;
  if(origin?.isConnected)origin.focus({preventScroll:true});
}

function closeDialog() {
  if(productDialog.open){productDialog.close();finishDialog();}
  else {modalKind=null;hideTooltip();}
}

function serviceOptions(query='') {
  const lower=query.trim().toLowerCase();
  const services=adapter.servicesFor(state.scope,state.filters).filter(service=>`${service.name} ${service.id} ${service.shortName}`.toLowerCase().includes(lower));
  if(!services.length)return `<div class="no-results"><strong>No service matches</strong><p>Try its name, abbreviation or service ID.</p></div>`;
  return services.map(service=>`<div class="service-choice ${pendingServiceIds.has(service.id)?'selected':''}"><label for="service-check-${service.id}"><input id="service-check-${service.id}" type="checkbox" data-service-checkbox="${service.id}" ${pendingServiceIds.has(service.id)?'checked':''}><span class="service-symbol">${esc(service.shortName)}</span><span class="service-choice-name"><strong>${esc(service.name)}</strong><small>${service.latestEligibleCount} eligible at reference</small></span>${service.availability==='not_eligible'?badge('Not eligible','amber'):service.availability==='recorded_only'?badge('Recorded settlements','outline'):''}</label><button class="text-action" data-action="choose-service" data-service="${service.id}" aria-label="Analyse only ${esc(service.name)}">Only</button></div>`).join('');
}

function updateServiceSelection() {
  const summary=document.getElementById('service-selection-summary'),apply=document.getElementById('apply-services');
  if(summary)summary.textContent=pendingServiceIds.size?`${pendingServiceIds.size} ${pendingServiceIds.size===1?'service':'services'} selected`:'Choose at least one service';
  if(apply)apply.disabled=pendingServiceIds.size===0;
}

function serviceDialog() {
  pendingServiceIds=new Set(state.serviceIds);
  openDialog('service','Choose your services','One service, a few, or the whole fleet. Uncheck any service to exclude it.',
    `<label class="modal-search" for="service-search">${icon('search')}<input id="service-search" type="search" placeholder="Search service name or ID" autocomplete="off" autofocus></label><div class="service-selection-actions"><button class="text-action" data-action="all-services">All services</button><button class="text-action" data-action="clear-services">Clear selection</button></div><div id="service-options">${serviceOptions()}</div><div class="service-selection-footer"><span id="service-selection-summary" role="status" aria-live="polite"></span><button class="btn primary" id="apply-services" data-action="apply-services">Apply selection ${icon('check')}</button></div>`);
  updateServiceSelection();
}

function applyServiceSelection(ids) {
  const valid=adapter.servicesFor(state.scope).map(service=>service.id);
  const selected=[...new Set(ids)].filter(id=>valid.includes(id)).sort();
  if(!selected.length)return;
  state.serviceIds=selected;state.serviceId=selected.includes(state.serviceId)?state.serviceId:selected[0];
  state.scenarioServiceId=selected.includes(state.scenarioServiceId)?state.scenarioServiceId:state.serviceId;
  state.filters=state.filters.filter(filter=>filter.dimension!=='service');state.scenarioCount=null;state.target=null;state.groupLimit=24;
  closeDialog();render({push:true});document.getElementById('service-control')?.focus({preventScroll:true});toast(`Showing ${serviceLabel(currentReport)}`);
}

function supplierList(query='') {
  const lower=query.toLowerCase();
  const suppliers=adapter.suppliersFor(queryForView()).map(supplier=>{
    const histories=live?adapter.getEndpoints(supplier.id,queryForView()):[];
    const hosts=live?[...new Set(histories.flatMap(h=>h.endpoints.map(e=>e.hostname)).filter(Boolean))]:supplier.endpointHosts;
    return {...supplier,displayHosts:hosts};
  }).filter(supplier=>`${supplier.name} ${supplier.id} ${supplier.currentOwner} ${supplier.displayHosts.join(' ')} ${supplier.groupName}`.toLowerCase().includes(lower));
  const shown=suppliers.slice(0,40);
  return `${shown.map(supplier=>`<div class="identity-row"><div class="between"><strong>${esc(supplier.name)} <span class="muted" style="font-weight:400">· ${currentReport.scope.fleetNames.length>1?`${esc(supplier.fleetName)} · `:''}${live?'Supplier identity':esc(supplier.groupName)}</span></strong>${badge(supplier.registeredForService?'Registered':'Other services')}</div><p><code>${esc(supplier.id)}</code></p><p>Owner at reference: <code>${esc(supplier.currentOwner)}</code></p><p>${supplier.displayHosts.slice(0,4).map(host=>esc(host)).join(' · ')}${supplier.displayHosts.length>4?` · +${supplier.displayHosts.length-4} more hostnames`:''}</p>${supplier.ownerHistory.length>1?`<p>Owner changed on ${supplier.ownerHistory.slice(1).map(row=>dateLabel(row.start)).join(', ')}. Historical owner views follow the dated membership.</p>`:''}<div class="identity-actions"><button class="btn small" data-action="open-supplier" data-supplier="${esc(supplier.id)}">Analyse this Supplier ${icon('arrow')}</button>${live?`<button class="btn small ghost" data-action="supplier-endpoints" data-supplier="${esc(supplier.id)}">Inspect endpoints ${icon('info')}</button>`:''}</div></div>`).join('')}${suppliers.length>shown.length?`<p class="small" style="margin-top:15px">Showing ${shown.length} of ${suppliers.length}. Search a name, address or hostname to narrow the list.</p>`:''}${!shown.length?`<p class="small">No recorded identities match this search.</p>`:''}`;
}

function endpointDialog(supplierId) {
  const supplier=adapter.getSupplier(supplierId);if(!supplier)return;
  const histories=adapter.getEndpoints(supplierId,queryForView());
  const records=histories.flatMap(h=>h.endpoints.map(endpoint=>({endpoint,history:h})));
  const rows=records.map(({endpoint:e,history:h})=>{
    const fields=e.parseStatus==='parsed'?[
      ['Recorded service',`${productData.services.find(s=>s.id===e.serviceId)?.name??e.serviceId} (${e.serviceId}) · ${e.rpcType??'Transport type not recorded'}`],
      ['URL',e.url],['Scheme / port',`${e.scheme} · ${e.port===null?`default${e.effectivePort?' '+e.effectivePort:''}`:e.port}`],
      ['Hostname',e.hostname],['Registrable domain',e.registrableDomain??`No registrable domain (${e.hostKind})`],
      ['Public suffix',e.publicSuffix??'—'],['Subdomain labels',e.subdomainLabels.length?e.subdomainLabels.join(' · '):'None'],
      ['Naming tokens',(e.subdomainTokenGroups??[]).length?e.subdomainTokenGroups.map(tokens=>tokens.join(' / ')).join(' · '):'None'],
      ['Path',e.path||'/ (empty URL path)'],['Query keys',e.queryKeys.length?e.queryKeys.join(', '):'None'],
      ['Observed association',h.sourceKind==='settled-session-roster'?`${h.start} → ${h.lastObservedAt} · discrete selected-session observations`:`${h.start} → ${h.end??'last sample in this snapshot'}`],
      ['Observation source',h.sourceKind==='settled-session-roster'?`${number(h.observedSessions)} selected-session end rosters; no continuous association inferred`:'Dated registry observations'],
      ['Archive heights',`${number(h.firstObservedHeight)} → ${number(h.lastObservedHeight)}`],
      ['Source URL hash',e.sourceUrlSha256]
    ]:[['Recorded service',e.serviceId],['Parsing status',e.reason],['Source URL hash',e.sourceUrlSha256]];
    return `<details class="details endpoint-details"><summary>${esc(e.serviceId)} · ${esc(e.hostname??'Invalid endpoint URL')}${h.end?' · historical':''}</summary><div class="details-body"><div class="definition-list">${fields.map(([label,value])=>`<div class="definition"><strong>${esc(label)}</strong><span class="endpoint-url">${esc(value)}</span></div>`).join('')}</div>${e.redactedParts?.length?'<p>Credentials, query values and fragments are omitted from this public view. The original hashed registry response retains the source URL.</p>':''}</div></details>`;
  }).join('');
  openDialog('supplier-endpoints','Endpoint details',supplier.name,`<p>Each endpoint is linked to its recorded service and observation period. The service ID comes from the chain configuration. Selected-session records add exact owner and endpoint observations at session-end heights; they do not fill gaps between observations. Subdomain labels are shown as recorded; their business or geographic meaning has not been inferred.</p><p class="endpoint-url"><strong>Supplier operator address</strong><br><code>${esc(supplier.id)}</code></p>${rows||'<p>No structured endpoints recorded for the selected services and period.</p>'}<p>Domains use a pinned Public Suffix List, including private hosting suffixes. An endpoint is an association; it does not establish a physical server or business owner.</p><div class="dialog-actions"><button class="btn" data-action="scope">Back to included Suppliers</button></div>`,{drawer:true});
}

function scopeDialog() {
  const report=currentReport,reference=scenarioReferenceFor(report);
  const references=report.services.length>1?`<h3>Eligibility by service</h3><div class="table-scroll"><table><thead><tr><th scope="col">Service</th><th scope="col">Yours</th><th scope="col">All eligible</th></tr></thead><tbody>${report.scenarioReferences.map(ref=>`<tr><td>${esc(ref.serviceName)}</td><td>${ref.ownEligible}</td><td>${number(ref.totalEligible)}</td></tr>`).join('')}</tbody></table></div><p>The same Supplier can be eligible for more than one service. The fleet count includes each identity once.</p>`:'';
  openDialog('scope','Who is included?',esc(report.scope.label),`<div class="scope-summary"><strong>${number(report.scope.supplierCount)} identities observed across ${esc(serviceLabel(report))}</strong><p>${esc(report.scope.membershipRule)}</p>${settled?'<p>Recorded earnings separately follow ownership and service endpoints in each exact session-end roster.</p>':''}<p>${number(report.scope.latestEligibleCount)} unique identities eligible at the ${dateLabel(reference.observedAt)} reference. Historical counts can differ.</p>${live?`<p class="address-label"><code>${esc(report.scope.value.startsWith('owner:')?report.scope.value.slice(6):report.scope.value)}</code></p>`:''}</div><p>${live?'Historical on-chain owner addresses and endpoint associations define these groups. Business names and backend infrastructure are not independently attributed.':'This fictional directory links Supplier identities to fleets and endpoints.'} Shared hosting identifies endpoint matches; it does not prove one operator.</p><button class="text-action" data-action="terminology">Who is who? ${icon('info')}</button>${references}<h3>Recorded Supplier identities</h3><label class="modal-search" for="supplier-search">${icon('search')}<input id="supplier-search" type="search" placeholder="Search Supplier, owner or hostname" autocomplete="off"></label><div id="supplier-options">${supplierList()}</div>`,{drawer:true});
}

function terminologyDialog() {
  const definitions=[
    ['Fleet','An explicitly defined group of Supplier identities you want to analyse. It can span owners, hosts and services.'],
    ['Operator / node runner','The person or organisation running the infrastructure. One operator can manage many Supplier identities and addresses.'],
    ['Operator address','The on-chain account that operates a Supplier. This can differ from the owner address.'],
    ['Supplier','A registered service-serving identity. It can offer several services, and several identities can share infrastructure.'],
    ['Owner address','The account that controls a Supplier’s staked funds and receives rewards by default. Revenue sharing can direct payouts elsewhere.'],
    ['Endpoint / hostname','An endpoint is the public service URL. Its hostname is the host part, such as relay.alder.example. Sharing a hostname is an association, not proof of common ownership.'],
    ['Domain','A wider name such as alder.example. Domain search includes recorded subdomains with a strict name boundary.'],
    ['Fleet group','An explicitly recorded subdivision, such as North or hosted infrastructure. A host name alone does not establish a physical backend.'],
    ['Service','The registered offering identified by a service ID, such as Ethereum RPC. Selection populations are service-specific.'],
    ['Application / Gateway','An Application is the requesting on-chain identity. A Gateway can route and sign requests on its behalf. One session belongs to an Application, service and time window.'],
    ['Session / relay','A session assigns a set of Suppliers for a particular service, Application and block window. A relay is an individual request and response. Selection into a session does not promise traffic.'],
    ['F score','Our earnings ratio: gross actual POKT divided by the equal-share amount. F = 1.24 means 24% above equal share. It is not a protocol quality grade.']
  ];
  openDialog('terminology','Who is who?','The identities and relationships behind a fleet',`<div class="definition-list">${definitions.map(([label,meaning])=>`<div class="definition"><strong>${label}</strong><span>${meaning}</span></div>`).join('')}</div><p class="dialog-explanation">${live?'This snapshot groups historical owner addresses and preserves Supplier operator addresses. Gross Supplier distributions include all revenue-share recipients; these are not owner profit.':'This preview uses fictional Supplier IDs and relationships. Separate real operator accounts and revenue-share recipient records belong to the later data integration.'}</p>`);
}

function evidenceDialog() {
  const report=currentReport,e=report.evidence,reference=scenarioReferenceFor(report);
  const availability=report.rewards.availability;
  const body=`<div class="evidence-grid">${[[`${e.verifiedRosters} / ${e.recordedSessions}`,'Verified session rosters'],[`${e.comparableOutcomes} / ${e.recordedSessions}`,settled?'Verified recorded settlements':'Original sampled payout evidence'],[number(e.informativeDays),'Days with reward opportunity'],[number(e.positiveOpportunities),'Positive reward opportunities']].map(([value,label])=>`<div class="evidence-box"><strong>${value}</strong><span>${label}</span></div>`).join('')}</div>${availability!=='available'?`<div class="subtle-notice warning" style="margin-top:0;margin-bottom:22px">${icon('info')}<span>${esc(plainEvidenceReason(report.rewards.reason)||'No earnings opportunity recorded.')}</span></div>`:''}<h3>Scope and time</h3><div class="definition-list">${[
    ['Membership',settled?'Earnings: exact session-end selected rosters. Selection: original sampled historical membership.':report.scope.membershipRule],['Services',report.services.map(service=>`${service.name} (${service.id})`).join(', ')],
    ['Period',`${report.period.start.slice(0,10)} inclusive to ${report.period.endExclusive.slice(0,10)} exclusive · UTC`],
    ['Selection reference',`${reference.serviceName} · ${reference.observedAt} · ${reference.ownEligible} yours, ${reference.totalEligible} total eligible`],
    ['Snapshot',report.snapshotId],['Created',report.generatedAt],['Data source',live?`Archived mainnet registries and indexed payouts; cutoff ${adapter.snapshotInfo.source.cutoff}`:'Controlled fictional observations; no live requests']
  ].map(([label,value])=>`<div class="definition"><strong>${label}</strong><span>${esc(value)}</span></div>`).join('')}</div>${report.services.length>1?`<h3>Coverage by service</h3><p>${settled?'Verified recorded settlements for earnings. Sessions absent from the index remain unknown in the separate original sample.':'Original sampled payout evidence; unknown outcomes remain unknown.'}</p><div class="table-scroll"><table><thead><tr><th scope="col">Service</th><th scope="col">Covered sessions</th><th scope="col">Earnings evidence</th></tr></thead><tbody>${report.perService.map(row=>`<tr><td>${esc(row.label)}</td><td>${row.comparableSessions} / ${row.recordedSessions}</td><td>${esc(earningsEvidenceLabel(row))}</td></tr>`).join('')}</tbody></table></div>`:''}${settled?`<h3>Original sampled payout evidence</h3><p>${number(e.selectionSampleSessions)} sampled sessions; ${number(e.sampledComparableOutcomes)} with comparable sampled payouts. Unknown sampled outcomes have not been replaced by zeros. <button class="text-action" data-action="live-coverage">Inspect the original gaps</button></p>`:''}<h3>Missing, pending and zero</h3><div class="definition-list">${[[number(e.missingOutcomes),'Missing earnings outcomes'],[number(e.pendingOutcomes),'Pending earnings outcomes'],[number(e.recordedSessions-e.verifiedRosters),'Unknown rosters'],[number(e.zeroPoolSessions),'Verified sessions with a zero payout pool']].map(([value,label])=>`<div class="definition"><strong>${value}</strong><span>${label}</span></div>`).join('')}</div><p style="font-size:12px;margin-top:13px">Verified zeros remain zeros. Unknown rosters and missing or unfinished payouts are excluded from both compared earnings totals.</p><h3>What the evidence can support</h3><p style="font-size:12px">${report.rewards.largestDayShare===null?'No positive comparison amount is available.':`The largest day contributes ${percent(report.rewards.largestDayShare,1)} of the comparison amount.`} Complete retrieval within this sample is separate from having enough informative reward observations.</p><p style="font-size:12px;margin-top:12px">${esc(e.limitations.join(' '))}</p><details class="details"><summary>Display rules and uncertainty</summary><div class="details-body"><p>A supported earnings classification requires at least 7 informative days, 24 positive opportunities, 90% comparable outcomes, no single day above 40% of opportunity, and a usable 95% day-resampling range. These are exploratory product safeguards, not certified reliability thresholds.</p><p>The estimate divides total gross Supplier earnings by the total equal-share comparison. It is not an average of session ratios.</p></div></details><div class="dialog-actions"><button class="btn" data-action="method">How it is calculated</button><button class="btn primary" data-action="download-result">${icon('download')} Download this result</button></div>`;
  openDialog('evidence','Evidence for this view',`${esc(report.scope.label)} · ${esc(report.service.name)}`,body,{drawer:true});
}

function calculationDialog() {
  const r=currentReport.rewards;
  openDialog('calculation','One comparison, the same sessions','Selected positions → equal-share amount → actual earnings',
    `<p>Each covered session has a recorded gross Supplier payout pool. Your selected positions receive an equal-sized slice of that pool for the comparison.</p><div class="method-step"><span class="step-number">1</span><div><strong>Give the selected positions a value</strong><p>For each session: total payout pool × your selected Suppliers ÷ all selected Suppliers.</p></div></div><div class="method-step"><span class="step-number">2</span><div><strong>Add the same covered sessions</strong><p>Add these equal-share amounts. Add the gross payouts attributed to your Suppliers from the same sessions.</p></div></div><div class="method-step"><span class="step-number">3</span><div><strong>Compare the totals</strong><p>Divide total actual earnings by total equal-share amount. A ratio of 1.5 is 50% above equal share.</p></div></div><h3>Your current view</h3><div class="example-equation"><div><strong>${number(r.actualPokt,1)}</strong><span>Actual · POKT</span></div><div><strong>${number(r.equalSharePokt,1)}</strong><span>Equal share · POKT</span></div><div><strong>${r.ratio===null?'—':`${number(r.ratio,2)}×`}</strong><span>Ratio of totals</span></div></div><p>${r.ratio===null?'A ratio needs a positive comparison amount. Zero opportunity does not mean poor performance.':`${signed(r.differencePercent,1)} relative to equal share across ${r.comparableSessions} comparable sessions.`}</p><h3>A simple worked example</h3><p>2 of 50 selected positions in a session paying 1,000 POKT give a 40 POKT equal-share amount. Actual earnings of 60 POKT are 50% above that amount.</p><p>Both sides use gross Supplier payouts across revenue-share recipients. The comparison does not measure owner profit or pure technical QoS.</p><div class="dialog-actions"><button class="btn" data-action="evidence">Check the evidence</button></div>`);
}

function fScoreDialog() {
  const r=currentReport.rewards;
  openDialog('f-score','Your earnings, on two scales','F score and percentage describe the same comparison.',
    `<div class="example-equation"><div><strong>${number(r.ratio,2)}</strong><span>F score</span></div><div><strong>${signed(r.differencePercent,1)}</strong><span>vs equal share</span></div></div><p><strong>F = 1.00</strong> means earnings equal the equal-share amount. F = 1.20 means 20% above; F = 0.80 means 20% below.</p><p>F divides actual gross earnings by the equal-share amount from the same covered sessions. The percentage is (F − 1) × 100.</p>${r.intervalRatio?`<p>The current 95% range for F is ${number(r.intervalRatio[0],2)}–${number(r.intervalRatio[1],2)}.</p>`:''}${r.availability!=='available'?`<div class="subtle-notice warning">${icon('info')}<span>${esc(r.reason)} The covered-session score does not establish a complete period-wide result.</span></div>`:''}<p>F describes historical earnings. It is not a technical quality rating or a future earnings forecast.</p><div class="dialog-actions"><button class="btn" data-action="calculation">See the calculation</button><button class="btn primary" data-action="evidence">Check the evidence</button></div>`);
}

function uncertaintyDialog() {
  const r=currentReport.rewards;
  openDialog('uncertainty','What does the range mean?','Uncertainty in the historical earnings comparison',
    `<p>We resample whole UTC days with replacement 2,000 times. Each selected day carries all its covered payouts and equal-share amounts together. We recalculate the ratio of totals for every resampled period.</p><p>The middle 95% of usable ratios forms the displayed range. Fewer informative days, variable outcomes or concentrated opportunity can make it wider.</p>${r.intervalDifferencePercent?`<div class="scope-summary" style="margin-top:18px"><strong>${signed(r.intervalDifferencePercent[0],1)} to ${signed(r.intervalDifferencePercent[1],1)}</strong><p>Current view’s 95% earnings-difference range.</p></div>`:`<div class="subtle-notice warning">${icon('info')}<span>${esc(r.reason??'The range cannot be estimated from this evidence.')}</span></div>`}<p>A range that includes 0% does not establish a difference from equal sharing. A narrow range does not repair missing evidence or source bias.</p><p>This range is not a forecast for future earnings. Days can remain dependent even when sessions from the same day stay together.</p><div class="dialog-actions"><button class="btn" data-action="evidence">View evidence</button></div>`);
}

function selectionExplanationDialog() {
  const e=currentReport.exposure;
  openDialog('selection-explain','Selection and opportunity','Observed sessions and a historical selection model',
    `<p>A session selects Supplier identities from those eligible for the service. Being selected allows participation; it does not reserve requests or rewards.</p><div class="example-equation"><div><strong>${percent(e.presenceFraction,1)}</strong><span>Observed presence</span></div><div><strong>${percent(e.expectedPresenceFraction,1)}</strong><span>Modelled presence</span></div><div><strong>${number(e.expectedMeanSelected,2)}</strong><span>Model mean selected</span></div></div><p>The observed share uses ${e.verifiedSessions} verified rosters from the selected period. The model uses each session’s own historical eligible population, fleet membership and selected count.</p><p>The fleet-size tool below uses a separately dated population reference. Its results describe an assumed fair selection draw at that reference; they are not the historical observed share.</p><div class="dialog-actions"><button class="btn" data-action="selection-shortcut">Inspect selection distribution</button><button class="btn" data-action="evidence">View evidence</button></div>`);
}

function scenarioExplanationDialog() {
  const ref=scenarioReferenceFor(currentReport);
  openDialog('scenario-explain','What changes in this scenario?','A selection model, using a dated population',
    `<p>The tool changes your eligible Supplier count while holding the other ${number(ref.totalEligible-ref.ownEligible)} eligible Suppliers and the ${ref.selectionCap}-position cap fixed. Your count and the total network population both change.</p><p>Every proposed identity is assumed eligible for this service. A session selects the smaller of the cap and the total eligible population, uniformly without replacement.</p><p><strong>Selection chance</strong> means the probability of reaching the chosen minimum. <strong>Expected selected</strong> means the average number of your Suppliers occupying positions per draw.</p><p>When almost every session already contains one of yours, additional Suppliers can still increase the number of positions. Presence alone does not describe the whole opportunity.</p><p>The reference is ${esc(ref.observedAt)}. Historical earnings and their estimate remain attached to the selected observed period.</p><details class="details"><summary>Exact equations</summary><div class="details-body"><p>Let N be all eligible Suppliers, n yours and K selected. X follows Hypergeometric(N, n, K).</p><p>P(X ≥ 1) = 1 − C(N − n, K) / C(N, K). Expected selected positions = K × n / N.</p><p>For additional Suppliers, N = other Suppliers + proposed n, and K = min(cap, N).</p></div></details>`);
}

function methodDialog() {
  if(live)return liveMethodDialog();
  openDialog('method','How results are calculated','Simple product views over explicitly recorded evidence',
    `<h3>Who is being measured?</h3><p>A named fleet follows the explicit fictional directory. An owner follows membership at each observation. A Supplier view follows one fixed identity. Hostname and domain views follow the recorded endpoint associations.</p><h3>Which sessions count for selection?</h3><p>Selection statistics use verified rosters. Earnings comparisons use the same sessions on both sides and require a known roster, completed payout outcome and nonempty selected pool.</p><h3>How is equal share calculated?</h3><p>For session j, Bⱼ = Vⱼ × Xⱼ / Kⱼ. Actual gross Supplier earnings are Yⱼ. F = ΣYⱼ / ΣBⱼ. The displayed percentage difference is (F − 1) × 100. F = 1 means equal share.</p><h3>How are multiple services combined?</h3><p>Earnings and equal-share amounts are summed across the selected services before F is calculated. Service percentages are not averaged. A session belongs to one service; each is counted once. Supplier identities across services are counted once in the fleet total. The same UTC day stays together across services in each uncertainty draw.</p><h3>How does uncertainty work?</h3><p>Whole observed UTC days are resampled with replacement 2,000 times. The 2.5th and 97.5th percentiles of usable ratios give the range. The range describes this historical estimate.</p><h3>How are groups compared?</h3><p>Every group gets its own totals, coverage and uncertainty calculation. Supplier partitions change the measured identities; traffic and time partitions change the included sessions. Hostname groups can overlap.</p><h3>How is the scenario calculated?</h3><p>Uniform selection without replacement uses the dated service population. Other eligible Suppliers and the selection cap stay fixed. Proposed Suppliers change both your count and the network total.</p><h3>What does this product not establish?</h3><p>Earnings differences can mix routing, request mix, infrastructure, geography, claiming and settlement. On-chain ownership and shared hosting do not automatically identify a business or backend. Sample coverage is separate from complete network coverage. The network view covers the eight fictional fleets in this sample; anonymous eligible population counts do not supply earnings evidence for those unobserved Suppliers.</p><div class="dialog-actions"><button class="btn" data-action="about">About the fictional examples</button>${state.scope?'<button class="btn primary" data-action="evidence">Evidence for this view</button>':''}</div>`,{drawer:true});
}

function liveMethodDialog() {
  openDialog('method','How results are calculated','Recorded historical evidence with explicit missingness',`${settled?'<h3>Recorded earnings and sampled selection</h3><p>Recorded earnings use all returned indexed settled sessions in the selected service and UTC session-end window. Payments, ownership and endpoints use their exact historical selected rosters. Sessions absent from the index stay unknown in the original selection sample. The settlement cohort does not supply the eligible population or registered-session presence.</p>':''}<h3>Who is being measured?</h3><p>${settled?'For recorded earnings, an owner-address group follows each exact session-end roster. For selection it follows the sampled historical heights.':'An owner-address group follows membership at each sampled historical height.'} A Supplier view follows its operator address. Hostnames and domains follow recorded endpoint associations at those observations. Partial names search observed domains and hostnames. URL components retain service-specific, dated associations; business ownership and geography are not inferred.</p><h3>Which sessions count for selection?</h3><p>Four fixed UTC samples per day cover every historically registered Application for each collected service. Registries and rosters use the same archive height. Repeated session IDs count once. This is a session sample, not all traffic or monthly income.</p><h3>How are payouts attributed?</h3><p>Each settled claim is linked to its Supplier and session. We sum upokt transfers across every recipient for the Supplier-shareholder relay and global-mint distribution reasons. Whole-claim settled amounts are not substituted. Unknown operation reasons, missing transfers and absent claims make the outcome unknown.</p><h3>How is equal share calculated?</h3><p>For covered session j: Bⱼ = Vⱼ × Xⱼ / Kⱼ, where V is indexed gross Supplier distributions, X yours selected and K all selected. F = ΣYⱼ / ΣBⱼ. Percentage difference = (F − 1) × 100. Both totals use the same covered sessions.</p><h3>How are services combined?</h3><p>We sum POKT actual and equal-share amounts before calculating F. We do not average service percentages. Fleet identities are counted once across services; service-level comparisons remain available.</p><h3>What do ranges and ranks mean?</h3><p>Whole observed UTC days are resampled 2,000 times. The central 95% of ratios is a descriptive range. A rank requires adequate observed days, opportunities and coverage within one service and one period. Source bias, missing records and dependence are not fixed by a narrow range. No overall cross-service league table is produced.</p><h3>What is predicted?</h3><p>The fleet-size tool models uniform selection without replacement using a dated population and cap. The earnings test fits an earlier F score and applies it to later observed opportunity, with a two-day gap. Historical indexer ingestion dates are unknown; it uses settlement timestamps. It does not forecast demand or earnings.</p><div class="dialog-actions"><button class="btn" data-action="about">Source and coverage</button>${state.scope?'<button class="btn primary" data-action="evidence">Evidence for this view</button>':''}</div>`,{drawer:true});
}

function aboutDialog() {
  if(live)return liveAboutDialog();
  openDialog('about','A product preview with fictional data','Phase 1 · all results are illustrative',
    `<p>This preview demonstrates a finished node-runner analysis experience. It includes eight fictional fleets, eighteen service examples and internally consistent session evidence.</p><p>Fleet names, addresses, endpoint domains, Gateway relationships, network counts and payout amounts are invented. They are not observations of real operators or the live POKT network.</p><p>The examples deliberately include one-Supplier fleets, shared hosting, changing membership, uncertain results and missing outcomes. The calculations use the same underlying fictional records across views.</p><p>Dates are UTC. The saved observation period is ${esc(periodLabel(adapter.snapshotInfo.period))}. Opening this product does not start collection or make live chain requests.</p><div class="dialog-actions"><button class="btn" data-action="method">See the methodology</button><button class="btn primary" data-action="close-dialog">Explore the product</button></div>`);
}

function sessionDialog(id) {
  const session=adapter.getSession(queryForView(),id);
  if(!session)return;
  const rows=[['Service',session.serviceName],['UTC start',session.startedAt],['Session ID',session.sessionId],['Gateway',session.gatewayName],['Application',session.applicationName],
    ['Eligible network / yours',session.evidenceUniverse==='indexed-settled-sessions'?'Not inferred here; see sampled selection in Summary':`${session.N} / ${session.n}`],['Selected positions / yours',`${session.K} / ${session.X??'unknown'}`],
    ['Total Supplier payout pool',money(session.pool)],['Equal-share amount',money(session.reference)],['Actual gross earnings',money(session.actual)],
    ['Payout status',session.payoutStatus],['Roster status',session.rosterStatus]];
  if(live)rows[1][0]=session.evidenceUniverse==='indexed-settled-sessions'?'UTC session end':'UTC sampled observation';
  if(session.evidenceUniverse==='indexed-settled-sessions')rows.push(['Session end block',number(session.sessionEndHeight)],['Indexed claim records',number(session.indexedClaimCount)]);
  openDialog('session','One recorded session',live?'Indexed evidence in the current scope':'Fictional evidence in the current scope',`<div class="definition-list">${rows.map(([label,value])=>`<div class="definition"><strong>${label}</strong><span>${esc(value)}</span></div>`).join('')}</div>`);
}

function toast(message) {
  clearTimeout(toastTimer);
  const node=document.getElementById('toast');node.textContent=message;node.classList.add('visible');
  toastTimer=setTimeout(()=>node.classList.remove('visible'),3200);
}

function routeParams() {
  const params=new URLSearchParams();
  if(!state.scope){
    if(live){
      if(discovery.view==='compare'){
        params.set('discover','compare');params.set('service',discovery.service);params.set('period',discovery.period);
        params.set('grouping',discovery.grouping);params.set('order',discovery.sort);
      }else if(discovery.grouping==='owner')params.set('grouping','owner');
    }
    return params;
  }
  params.set('snapshot',adapter.snapshotInfo.snapshotId);params.set('scope',state.scope.type);params.set('id',state.scope.value);
  if(state.scope.fleetId)params.set('fleet',state.scope.fleetId);
  params.set('service',state.serviceId);params.set('period',state.period);params.set('view',state.view);
  if(state.serviceIds.length>1)params.set('services',JSON.stringify(state.serviceIds));
  if(state.serviceIds.length>1&&state.scenarioServiceId)params.set('model-service',state.scenarioServiceId);
  params.set('chart',state.chartMetric);
  if(state.view==='diagnostics')params.set('diagnostic',state.diagnostic);
  if(state.view==='breakdown')params.set('by',state.dimension);
  if(state.filters.length)params.set('filters',JSON.stringify(state.filters));
  if(state.scenarioCount!==null)params.set('count',String(state.scenarioCount));
  if(state.minimum!==1)params.set('minimum',String(state.minimum));
  if(state.target!==null)params.set('target',String(state.target));
  return params;
}

function writeRoute(push=false) {
  const hash=routeParams().toString();
  const next=hash?`#${hash}`:location.pathname+location.search;
  if((location.hash.slice(1)||'')===hash)return;
  history[push?'pushState':'replaceState'](null,'',next);
}

function restoreRoute() {
  const params=new URLSearchParams(location.hash.slice(1));
  if(!params.has('scope')){
    state.scope=null;
    if(live){
      discovery.view=params.get('discover')==='compare'?'compare':'explore';
      discovery.grouping=params.get('grouping')==='owner'?'owner':'domain';
      discovery.sort=params.get('order')==='score'?'score':'earnings';
      discovery.service=productData.services.some(s=>s.id===params.get('service'))?params.get('service'):(adapter.snapshotInfo.source.screeningSelectedServices??adapter.snapshotInfo.source.selectedServices)?.find(id=>productData.services.some(s=>s.id===id))??productData.services[0].id;
      discovery.period=periodChoices.some(([id])=>id===params.get('period'))?params.get('period'):'30';
      discovery.limit=20;
    }
    return;
  }
  const scope={type:params.get('scope'),value:params.get('id')};
  if(params.has('fleet'))scope.fleetId=params.get('fleet');
  if(params.get('snapshot')!==adapter.snapshotInfo.snapshotId){state.scope=null;state.error='This link belongs to another snapshot. Choose a fleet from the current directory.';return;}
  if(!scopeTypes.includes(scope.type)||!scope.value||!adapter.servicesFor(scope).length){state.scope=null;state.error='The linked scope is unavailable in this snapshot. Choose a fleet from this snapshot.';return;}
  const registered=adapter.servicesFor(scope);
  let selected;
  try {selected=params.has('services')?JSON.parse(params.get('services')):[params.get('service')];
    if(!Array.isArray(selected)||!selected.length||selected.length>registered.length||selected.some(id=>typeof id!=='string'||!registered.some(service=>service.id===id)))throw new Error();
    selected=[...new Set(selected)].sort();
  }catch {state.scope=null;state.error='The linked services are unavailable for this scope.';return;}
  const service=registered.find(s=>s.id===(selected.includes(params.get('service'))?params.get('service'):selected[0]));
  if(!service){state.scope=null;state.error='The linked service is unavailable for this scope.';return;}
  let filters=[];
  try {
    const parsed=JSON.parse(params.get('filters')??'[]');
    if(!Array.isArray(parsed)||parsed.length>DIMENSIONS.length||parsed.some(f=>!DIMENSIONS.some(([id])=>id===f.dimension)||typeof f.value!=='string')||new Set(parsed.map(f=>f.dimension)).size!==parsed.length)throw new Error();
    filters=parsed;
  }catch{state.scope=null;state.error='The linked filters are invalid. Choose a fleet from this snapshot.';return;}
  state.scope=scope;state.serviceId=service.id;state.period=periodChoices.some(([id])=>id===params.get('period'))?params.get('period'):'30';
  state.serviceIds=selected;state.scenarioServiceId=selected.includes(params.get('model-service'))?params.get('model-service'):service.id;
  state.chartMetric=params.get('chart')==='amounts'?'amounts':'difference';
  state.view=VIEWS.some(([id])=>id===params.get('view'))?params.get('view'):'summary';
  state.diagnostic=params.get('diagnostic')==='scatter'?'scatter':'selection';
  state.dimension=DIMENSIONS.some(([id])=>id===params.get('by'))?params.get('by'):live?'hostname':'infrastructure';state.filters=filters;
  state.scenarioCount=params.has('count')?Math.max(0,Math.min(100000,Math.round(Number(params.get('count'))||0))):null;
  const minimum=Number(params.get('minimum')),target=Number(params.get('target'));
  state.minimum=Number.isInteger(minimum)&&minimum>=1&&minimum<=100000?minimum:1;
  state.customMinimum=![1,2,3,5].includes(state.minimum);
  state.target=params.has('target')&&Number.isFinite(target)&&target>0&&target<=1?target:null;state.error='';
}

function render({push=false,focus=false}={}) {
  const active=document.activeElement;
  const activeId=active?.id;
  const activeData=active?.dataset?.action?Object.entries(active.dataset).filter(([key])=>key!=='tip'):null;
  const scrollY=window.scrollY;
  dismissedTooltipTarget=null;hideTooltip();
  currentReport=state.scope?adapter.getReport(queryForView()):null;
  app.innerHTML=currentReport?workspacePage(currentReport):homePage();
  loadDiagnosticView();
  document.title=currentReport?`${currentReport.scope.label} · ${currentReport.service.shortName} | Pocket fleet analysis`:'Pocket Network · Fleet analysis';
  writeRoute(push);
  if(focus) {window.scrollTo({top:0,behavior:'instant'});(document.getElementById('workspace-title')??document.getElementById('fleet-search')??document.getElementById('discovery-title'))?.focus({preventScroll:true});}
  else {
    const replacement=activeId?document.getElementById(activeId):activeData?[...document.querySelectorAll('[data-action]')].find(node=>activeData.every(([key,value])=>node.dataset[key]===value)):null;
    replacement?.focus({preventScroll:true});window.scrollTo({top:scrollY,behavior:'instant'});
  }
}

async function shareView() {
  writeRoute(false);
  const link=location.href;
  try {await navigator.clipboard.writeText(link);toast('View link copied');}
  catch {openDialog('share','Share this view','The link preserves scope, services, filters and scenario.',`<label for="share-link" class="small muted">Copy this link</label><input id="share-link" class="copy-input" value="${esc(link)}" readonly autofocus><p style="font-size:12px;margin-top:13px">A downloaded offline file must be hosted before its view links can be shared.</p>`);document.getElementById('share-link').select();}
}

let downloadBusy=false;
async function downloadResult() {
  if(downloadBusy)return;
  downloadBusy=true;
  const query=queryForView(),dimension=state.dimension,service=currentReport.service.id,compressed=settled;
  document.querySelectorAll('[data-action="download-result"]').forEach(button=>button.disabled=true);
  toast('Preparing the complete result. Large fleet exports take a little longer.');
  try {
    // Let the preparing message paint before calculating every requested row.
    await new Promise(resolve=>setTimeout(resolve,50));
    const blob=await resultDownloadBlob(adapter.exportResult(query,dimension),compressed);
    const url=URL.createObjectURL(blob),link=document.createElement('a');
    link.href=url;link.download=`pokt-${live?'live':'illustrative'}-${service}-result.json${compressed?'.gz':''}`;link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
    toast(compressed?'Complete result downloaded as compressed JSON (.json.gz)':'Fictional result downloaded');
  } catch(error) {toast(`Could not prepare the result: ${error.message}`);}
  finally {downloadBusy=false;document.querySelectorAll('[data-action="download-result"]').forEach(button=>button.disabled=false);}
}

function addFilter(dimension,value) {
  state.filters=[...state.filters.filter(filter=>filter.dimension!==dimension),{dimension,value}];
  state.scenarioCount=null;state.target=null;state.groupLimit=24;
  render({push:true});
  document.getElementById(`remove-filter-${dimension}`)?.focus();
  toast(`Filtered to ${filterLabel({dimension,value})}`);
}

function focusFilters(index=0) {
  const filter=state.filters[index]??state.filters.at(-1);
  (document.getElementById(filter?`remove-filter-${filter.dimension}`:'dimension-select')??document.getElementById('service-control'))?.focus();
}

document.addEventListener('click',event=>{
  if(event.target.closest('.skip-link')) {event.preventDefault();const main=document.getElementById('main-content');main?.focus({preventScroll:true});main?.scrollIntoView({block:'start'});return;}
  const button=event.target.closest('[data-action]');
  if(!button||button.disabled)return;
  const action=button.dataset.action;
  if(action==='home'){closeDialog();state.scope=null;state.error='';state.query='';discovery.view='explore';render({push:true,focus:true});}
  else if(action==='open-fleet'){const fleet=adapter.getFleet(button.dataset.fleet);if(fleet)openScope({type:'fleet',value:fleet.id},fleet.primary);}
  else if(action==='open-network')openScope({type:'network',value:adapter.snapshotInfo.networkScopeValue});
  else if(action==='live-discovery-view'){discovery.view=button.dataset.view==='compare'?'compare':'explore';render({push:true});document.getElementById(`discovery-tab-${discovery.view}`)?.focus({preventScroll:true});}
  else if(action==='live-sort'){discovery.sort=button.dataset.sort==='score'?'score':'earnings';discovery.limit=20;render({push:true});}
  else if(action==='live-more'){discovery.limit+=20;render();}
  else if(action==='live-more-suggestions'){discovery.suggestedLimit=8;render();}
  else if(action==='live-coverage')return liveCoverageDialog();
  else if(action==='earnings-scope')return earningsScopeDialog();
  else if(action==='live-rank-help')liveRankHelp();
  else if(action==='live-row-detail')liveRowDetail(button.dataset.groupKey);
  else if(action==='live-open-owner')openScope({type:'owner',value:button.dataset.owner},discovery.service);
  else if(action==='live-open-domain')openScope({type:'domain',value:button.dataset.domain},button.dataset.allServices==='true'?null:discovery.service);
  else if(action==='live-grouping'){const context=button.dataset.groupingContext??'discovery';discovery.grouping=button.dataset.grouping==='owner'?'owner':'domain';discovery.limit=20;discovery.suggestedLimit=4;render({push:true});document.querySelector(`[data-grouping-context="${context}"][data-grouping="${discovery.grouping}"]`)?.focus({preventScroll:true});}
  else if(action==='live-catalog')liveCatalogDialog();
  else if(action==='example-query'){state.query=button.dataset.value;document.getElementById('fleet-search').value=state.query;document.getElementById('search-results').innerHTML=searchResults(state.query);document.getElementById('fleet-search').focus();}
  else if(action==='search-match'){const match=adapter.search(state.query)[Number(button.dataset.index)];if(match)openScope(match.scope,live&&match.scope.type==='domain'?null:match.primaryService);}
  else if(action==='supplier-endpoints')endpointDialog(button.dataset.supplier);
  else if(action==='open-supplier'){const supplier=adapter.getSupplier(button.dataset.supplier);if(supplier)openScope({type:'supplier',value:supplier.id},state.serviceId);}
  else if(action==='view'){state.view=button.dataset.view;closeDialog();render({push:true});document.getElementById(`tab-${state.view}`)?.focus({preventScroll:true});}
  else if(action==='service')serviceDialog();
  else if(action==='choose-service')applyServiceSelection([button.dataset.service]);
  else if(action==='all-services'){pendingServiceIds=new Set(adapter.servicesFor(state.scope).map(service=>service.id));document.getElementById('service-options').innerHTML=serviceOptions(document.getElementById('service-search').value);updateServiceSelection();}
  else if(action==='clear-services'){pendingServiceIds.clear();document.getElementById('service-options').innerHTML=serviceOptions(document.getElementById('service-search').value);updateServiceSelection();}
  else if(action==='apply-services')applyServiceSelection([...pendingServiceIds]);
  else if(action==='chart-metric'){state.chartMetric=button.dataset.metric==='difference'?'difference':'amounts';render({push:true});document.querySelector(`[data-action="chart-metric"][data-metric="${state.chartMetric}"]`)?.focus({preventScroll:true});}
  else if(action==='scope')scopeDialog();
  else if(action==='terminology')terminologyDialog();
  else if(action==='evidence')evidenceDialog();
  else if(action==='calculation')calculationDialog();
  else if(action==='f-score')fScoreDialog();
  else if(action==='uncertainty')uncertaintyDialog();
  else if(action==='selection-explain')selectionExplanationDialog();
  else if(action==='scenario-explain')scenarioExplanationDialog();
  else if(action==='method')methodDialog();
  else if(action==='about')aboutDialog();
  else if(action==='close-dialog')closeDialog();
  else if(action==='share')shareView();
  else if(action==='download-result')downloadResult();
  else if(action==='reset-scenario'){state.scenarioCount=scenarioReferenceFor(currentReport).ownEligible;state.target=null;render();toast('Scenario reset to the recorded eligible count');}
  else if(action==='scenario-target')applyScenarioTarget(Number(button.dataset.target));
  else if(action==='filter-group')addFilter(button.dataset.dimension,button.dataset.value);
  else if(action==='remove-filter'){const index=Number(button.dataset.index);state.filters.splice(index,1);state.scenarioCount=null;state.target=null;render({push:true});focusFilters(index);}
  else if(action==='clear-filters'){state.filters=[];state.scenarioCount=null;state.target=null;render({push:true});focusFilters();}
  else if(action==='dimension-shortcut'){state.view='breakdown';state.dimension=button.dataset.dimension;render({push:true});}
  else if(action==='selection-shortcut'){closeDialog();state.view='diagnostics';state.diagnostic='selection';render({push:true});document.getElementById('diagnostic-selection')?.focus();}
  else if(action==='more-groups'){const previous=state.groupLimit;state.groupLimit+=24;render();document.querySelectorAll('.comparison-row')[previous]?.focus();}
  else if(action==='inspect-session')sessionDialog(button.dataset.session);
  else if(action==='diagnostic-view'){state.diagnostic=button.dataset.diagnostic==='scatter'?'scatter':'selection';render({push:true});document.getElementById(`diagnostic-${state.diagnostic}`)?.focus();}
  else if(action==='prediction-day')predictionDayDialog(button.dataset.date);
  else if(action==='prediction-method')predictionMethodDialog();
  else if(action==='prediction-full-month'){state.period='30';render({push:true});document.getElementById('tab-predictions')?.focus();}
});

document.addEventListener('submit',event=>{
  if(event.target.id==='scenario-target-form'){event.preventDefault();applyScenarioTarget(Number(document.getElementById('scenario-target-percent').value)/100);return;}
  if(event.target.id!=='fleet-search-form')return;
  event.preventDefault();state.query=document.getElementById('fleet-search').value.trim();
  const matches=adapter.search(state.query);
  if(matches.length===1)openScope(matches[0].scope,live&&matches[0].scope.type==='domain'?null:matches[0].primaryService);
  else document.getElementById('search-results').innerHTML=searchResults(state.query);
});

document.addEventListener('input',event=>{
  const node=event.target;
  if(node.id==='fleet-search'){state.query=node.value;document.getElementById('search-results').innerHTML=node.value.trim().length>1?searchResults(node.value):'';}
  else if(node.id==='service-search')document.getElementById('service-options').innerHTML=serviceOptions(node.value);
  else if(node.id==='supplier-search')document.getElementById('supplier-options').innerHTML=supplierList(node.value);
  else if(node.id==='catalog-search'){discovery.catalogQuery=node.value;document.getElementById('catalog-results').innerHTML=liveCatalogRows(node.value);}
  else if(node.id==='scenario-count'){clearScenarioTarget();updateScenario(node.value);}
  else if(node.id==='scenario-number'){clearScenarioTarget();updateScenario(node.value,{fromNumber:true});}
});

document.addEventListener('change',event=>{
  const node=event.target;
  if(node.dataset?.serviceCheckbox){if(node.checked)pendingServiceIds.add(node.dataset.serviceCheckbox);else pendingServiceIds.delete(node.dataset.serviceCheckbox);updateServiceSelection();}
  else if(node.id==='scenario-service-select'){state.scenarioServiceId=node.value;state.scenarioCount=null;state.target=null;render({push:true});}
  else if(node.id==='period-select'){state.period=node.value;state.target=null;render({push:true});}
  else if(node.id==='leaderboard-service'){discovery.service=node.value;discovery.limit=20;render({push:true});}
  else if(node.id==='leaderboard-period'){discovery.period=node.value;discovery.limit=20;render({push:true});}
  else if(node.id==='dimension-select'){state.dimension=node.value;state.groupLimit=24;render({push:true});}
  else if(node.id==='selection-minimum'){state.customMinimum=node.value==='custom';if(state.customMinimum){render();const input=document.getElementById('selection-minimum-custom');input?.focus();input?.select();}else updateMinimum(node.value);}
  else if(node.id==='selection-minimum-custom')updateMinimum(node.value);
  else if(node.id==='prediction-day-select'){if(node.value)predictionDayDialog(node.value);}
  else if(node.id==='scenario-count')updateScenario(node.value,{save:true});
  else if(node.id==='scenario-number')updateScenario(node.value,{save:true,fromNumber:true});
});

document.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&!chartTooltip.hidden){dismissedTooltipTarget=tooltipTarget;hideTooltip();}
  if(event.target.getAttribute('role')==='tab'&&['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) {
    event.preventDefault();
    if(event.target.dataset.action==='live-discovery-view'){
      const options=['explore','compare'],index=event.key==='Home'?0:event.key==='End'?1:(options.indexOf(discovery.view)+(event.key==='ArrowLeft'?-1:1)+2)%2;
      discovery.view=options[index];render({push:true});document.getElementById(`discovery-tab-${discovery.view}`)?.focus({preventScroll:true});return;
    }
    const diagnostic=event.target.dataset.action==='diagnostic-view';
    const options=diagnostic?['selection','scatter']:VIEWS.map(([id])=>id),current=diagnostic?state.diagnostic:state.view;
    const index=event.key==='Home'?0:event.key==='End'?options.length-1:(options.indexOf(current)+(event.key==='ArrowLeft'?-1:1)+options.length)%options.length;
    if(diagnostic)state.diagnostic=options[index];else state.view=options[index];
    render({push:true});document.getElementById(diagnostic?`diagnostic-${state.diagnostic}`:`tab-${state.view}`)?.focus();
  } else if(event.target.id==='service-search'&&event.key==='Enter') {
    event.preventDefault();document.querySelector('#service-options [data-service-checkbox]')?.focus();
  } else if(event.target.classList.contains('scatter-point')||event.target.classList.contains('time-point')||event.target.classList.contains('prediction-point')) {
    if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key)) {
      event.preventDefault();const points=[...document.querySelectorAll(event.target.classList.contains('time-point')?'.time-point':event.target.classList.contains('prediction-point')?'.prediction-point':'.scatter-point')],index=points.indexOf(event.target);
      const next=event.key==='Home'?0:event.key==='End'?points.length-1:(index+(['ArrowLeft','ArrowUp'].includes(event.key)?-1:1)+points.length)%points.length;
      points.forEach((point,i)=>point.setAttribute('tabindex',i===next?'0':'-1'));points[next].focus();
    } else if(event.key==='Enter'||event.key===' '){event.preventDefault();if(event.target.classList.contains('time-point'))addFilter(event.target.dataset.dimension,event.target.dataset.value);else if(event.target.classList.contains('prediction-point'))predictionDayDialog(event.target.dataset.date);else sessionDialog(event.target.dataset.session);}
  }
});

function hideTooltip() {chartTooltip.hidden=true;tooltipTarget=null;}

function positionTooltip(target,clientX,clientY) {
  if(target===dismissedTooltipTarget)return;
  dismissedTooltipTarget=null;tooltipTarget=target;
  chartTooltip.textContent=target.dataset.tip;chartTooltip.hidden=false;
  chartTooltip.style.left=`${Math.max(8,Math.min(window.innerWidth-chartTooltip.offsetWidth-8,clientX+14))}px`;
  chartTooltip.style.top=`${Math.max(8,Math.min(window.innerHeight-chartTooltip.offsetHeight-8,clientY+14))}px`;
}
document.addEventListener('pointermove',event=>{if(event.target.closest('#chart-tooltip'))return;const target=event.target.closest('[data-tip]');if(target)positionTooltip(target,event.clientX,event.clientY);else {dismissedTooltipTarget=null;hideTooltip();}});
document.addEventListener('pointerout',event=>{if(!event.relatedTarget){dismissedTooltipTarget=null;hideTooltip();}});
document.addEventListener('focusin',event=>{const target=event.target.closest('[data-tip]');if(target){const rect=target.getBoundingClientRect();positionTooltip(target,rect.left,rect.bottom);}else {dismissedTooltipTarget=null;hideTooltip();}});
document.addEventListener('focusout',()=>{dismissedTooltipTarget=null;hideTooltip();});
document.addEventListener('scroll',hideTooltip,{passive:true});
productDialog.addEventListener('close',()=>{if(!productDialog.open)finishDialog();});
productDialog.addEventListener('click',event=>{if(event.target===productDialog){const box=productDialog.getBoundingClientRect();if(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom)closeDialog();}});
window.addEventListener('popstate',()=>{closeDialog();restoreRoute();render({focus:true});});
window.addEventListener('hashchange',()=>{if(location.hash.slice(1)!==routeParams().toString()){closeDialog();restoreRoute();render({focus:true});}});
restoreRoute();render();
