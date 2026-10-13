import {createAnalysisEngine,normaliseHost,hostMatches,ownerAt} from './engine.js';
import {createSettlementSource} from './settlements.js';

/** The UI talks to this interface. A future real adapter can return the same models. */
export function createIllustrativeAdapter(data) {
  if(data.dataKind!=='illustrative') throw new Error('The Phase 1 adapter requires explicitly illustrative data.');
  return createSnapshotAdapter(data);
}

export function createLiveAdapter(data,monthlyCheck=null,settlementWire=null,settlementReceipt=null,settlementTables=null) {
  if(data.dataKind!=='live'||!data.liveSource?.cutoff) throw new Error('The live adapter requires recorded mainnet evidence and an indexer cutoff.');
  if(monthlyCheck)validateMonthlyCheck(data,monthlyCheck);
  if(data.wireCodec==='supplier-indices-v1') {
    const ids=data.suppliers.map(s=>s.id);
    const shared=new Map();
    for(const p of data.populations){
      const indices=p.eligibleSupplierIndices;
      if(!Array.isArray(indices)||indices.some(i=>!Number.isInteger(i)||i<0||i>=ids.length)||new Set(indices).size!==indices.length)throw new Error('Invalid encoded historical Supplier population.');
      const key=indices.join(',');
      if(!shared.has(key))shared.set(key,indices.map(i=>ids[i]));
      p.eligibleSupplierIds=shared.get(key);delete p.eligibleSupplierIndices;
    }
    delete data.wireCodec;
  }
  const settlements=settlementWire?createSettlementSource(data,settlementWire,settlementReceipt):null;
  if(settlementTables&&(!settlements||settlementTables.cutoff!==data.liveSource.cutoff||settlementTables.claims!==settlements.info.claims||settlementTables.sessions!==settlements.info.sessions))throw new Error('Settlement comparison tables belong to another collection.');
  return createSnapshotAdapter(data,monthlyCheck,settlements,settlementTables);
}

function validateMonthlyCheck(data,check) {
  if(check.snapshotId!==data.snapshotId||check.cutoff!==data.liveSource.cutoff||check.period.start!==data.period.start||check.period.endExclusive!==data.period.endExclusive)
    throw new Error('Monthly claim check belongs to a different snapshot or cutoff.');
  const groups=new Map();
  for(const s of data.sessions){const key=JSON.stringify([s.serviceId,s.applicationId]);if(!groups.has(key))groups.set(key,{claims:0,sessions:0,covered:0});const g=groups.get(key);g.claims+=s.settledClaimCount??0;g.sessions++;if(s.payoutStatus==='complete'&&s.rosterStatus==='complete'&&s.selectedCount>0)g.covered++;}
  const seen=new Set();
  for(const row of check.groups){
    const key=JSON.stringify([row.serviceId,row.applicationId]),g=groups.get(key);
    if(!g||seen.has(key)||row.sampledSessions!==g.sessions||row.originalCoveredSessions!==g.covered||row.originalSampledClaimCount!==g.claims||row.recheckedSampledClaimCount!==g.claims||row.sampledClaimCountDifference!==0||!Number.isSafeInteger(row.monthlyClaimCount)||row.monthlyClaimCount<g.claims)
      throw new Error('Monthly claim counts do not reconcile with the original sampled evidence.');
    seen.add(key);
  }
  if(seen.size!==groups.size||check.summary.checkedGroups!==groups.size||check.summary.monthlyClaimRecords!==check.groups.reduce((n,g)=>n+g.monthlyClaimCount,0)||check.summary.recheckedSampledClaimRecords!==check.groups.reduce((n,g)=>n+g.recheckedSampledClaimCount,0)||check.indexerMetadata.lastProcessedHeight<check.cutoff)
    throw new Error('Monthly claim check is incomplete or inconsistent.');
}

function createSnapshotAdapter(data,monthlyCheck=null,settlements=null,settlementTables=null) {
  const engine=createAnalysisEngine(data,settlements);
  const sortService=(a,b)=>a.name.localeCompare(b.name);
  const fleetScope = fleetId => ({type:'fleet',value:fleetId});
  const snapshotInfo = {snapshotId:settlements?.info.snapshotId??data.snapshotId,dataKind:data.dataKind,generatedAt:settlements?.info.receipt.completedAt??data.generatedAt,period:data.period,
    source:data.liveSource??null,networkScopeValue:data.networkScopeValue??'illustrative-sample',sampling:data.sampling,monthlyCheck,settlement:settlements?.info??null};
  const populationById = new Map(data.populations.map(pop=>[pop.id,pop]));
  const endpointById=engine.endpointById;
  let cachedDomains;
  const coverageCache=new Map();

  function coverageDiagnostics(period='30') {
    if(coverageCache.has(period))return coverageCache.get(period);
    const window=engine.periodFor({period}),groups=new Map();
    const rows=data.sessions.filter(s=>s.startedAt>=window.start&&s.startedAt<window.endExclusive);
    for(const row of rows) {
      const key=JSON.stringify([row.serviceId,row.applicationId]);
      if(!groups.has(key))groups.set(key,{serviceId:row.serviceId,applicationId:row.applicationId,sessions:0,covered:0,noIndexedClaims:0,unverifiedClaims:0});
      const g=groups.get(key);g.sessions++;
      if(row.rosterStatus==='complete'&&row.payoutStatus==='complete'&&row.selectedCount>0)g.covered++;
      else if(row.settledClaimCount>0)g.unverifiedClaims++;
      else g.noIndexedClaims++;
    }
    const applications=[...groups.values()].map(g=>({...g,unknown:g.sessions-g.covered,coverage:g.covered/g.sessions}))
      .sort((a,b)=>a.serviceId.localeCompare(b.serviceId)||a.coverage-b.coverage||a.applicationId.localeCompare(b.applicationId));
    const services=data.services.map(s=>{
      const apps=applications.filter(g=>g.serviceId===s.id),sum=field=>apps.reduce((n,g)=>n+g[field],0);
      const sessions=sum('sessions'),covered=sum('covered');
      return {...s,sessions,covered,unknown:sessions-covered,coverage:sessions?covered/sessions:null,
        noIndexedClaims:sum('noIndexedClaims'),unverifiedClaims:sum('unverifiedClaims'),
        applicationGroups:apps.length,neverCoveredGroups:apps.filter(g=>g.covered===0).length,applications:apps};
    });
    const covered=services.reduce((n,s)=>n+s.covered,0),never=applications.filter(g=>g.covered===0);
    const result={period:window,sessions:rows.length,covered,unknown:rows.length-covered,
      coverage:rows.length?covered/rows.length:null,services,applications,neverCoveredGroups:never.length,
      unknownInNeverCoveredGroups:never.reduce((n,g)=>n+g.unknown,0)};
    if(monthlyCheck&&+new Date(window.start)===+new Date(monthlyCheck.period.start)&&+new Date(window.endExclusive)===+new Date(monthlyCheck.period.endExclusive)){
      const monthlyByGroup=new Map(monthlyCheck.groups.map(g=>[JSON.stringify([g.serviceId,g.applicationId]),g]));
      for(const g of applications)g.monthlyClaimCount=monthlyByGroup.get(JSON.stringify([g.serviceId,g.applicationId])).monthlyClaimCount;
      const withClaims=applications.filter(g=>g.monthlyClaimCount>0),sampled=withClaims.reduce((n,g)=>n+g.sessions,0),covered=withClaims.reduce((n,g)=>n+g.covered,0);
      result.monthlyActivity={...monthlyCheck.summary,checkedAt:monthlyCheck.completedAt,requestCount:monthlyCheck.requestCount,
        groupsWithClaims:withClaims.length,groupsWithoutClaims:applications.length-withClaims.length,
        sampledInGroupsWithClaims:sampled,coveredInGroupsWithClaims:covered,unknownInGroupsWithClaims:sampled-covered,
        coverageInGroupsWithClaims:sampled?covered/sampled:null};
      for(const s of services){s.groupsWithMonthlyClaims=s.applications.filter(g=>g.monthlyClaimCount>0).length;s.monthlyClaimRecords=s.applications.reduce((n,g)=>n+g.monthlyClaimCount,0);}
    }
    coverageCache.set(period,result);return result;
  }

  function domainDirectory() {
    if(cachedDomains)return cachedDomains;
    const groups=new Map();
    for(const supplier of data.suppliers)for(const history of supplier.endpointHistory??[])for(const id of history.endpointIds??[]) {
      const endpoint=endpointById.get(id),domain=endpoint?.registrableDomain;
      if(!domain)continue;
      if(!groups.has(domain))groups.set(domain,{id:domain,name:domain,domain,scope:{type:'domain',value:domain},
        suppliers:new Set(),owners:new Set(),services:new Set(),hosts:new Set()});
      const group=groups.get(domain);
      group.suppliers.add(supplier.id);group.services.add(endpoint.serviceId);group.hosts.add(endpoint.hostname);
      for(const h of supplier.ownerHistory)if(Math.max(+new Date(history.start),+new Date(h.start))<
        Math.min(+new Date(history.end??data.period.endExclusive),+new Date(h.end??data.period.endExclusive)))group.owners.add(h.ownerId);
    }
    for(const association of settlements?.domainAssociations()??[]) {
      const domain=association.domain;
      if(!groups.has(domain))groups.set(domain,{id:domain,name:domain,domain,scope:{type:'domain',value:domain},
        suppliers:new Set(),owners:new Set(),services:new Set(),hosts:new Set()});
      const group=groups.get(domain);group.suppliers.add(association.supplierId);group.owners.add(association.ownerId);
      group.services.add(association.serviceId);group.hosts.add(association.hostname);
    }
    cachedDomains=[...groups.values()].map(g=>({id:g.id,name:g.name,domain:g.domain,scope:g.scope,
      supplierCount:g.suppliers.size,ownerCount:g.owners.size,serviceCount:g.services.size,
      serviceIds:[...g.services].sort(),hostnames:[...g.hosts].sort(),
      primary:[...g.services].sort()[0],tag:'Endpoint domain',
      note:'Suppliers with recorded endpoints under this domain. Business ownership is not verified.'}));
    return cachedDomains;
  }

  function directory() {
    return data.fleets.map(fleet=>({...fleet,scope:fleetScope(fleet.id),
      supplierCount:engine.candidateSuppliers(fleetScope(fleet.id)).length,
      serviceCount:new Set(engine.candidateSuppliers(fleetScope(fleet.id)).flatMap(s=>s.serviceIds).filter(id=>engine.serviceById.has(id))).size})).filter(fleet=>fleet.serviceCount>0);
  }

  function search(input) {
    const text=String(input).trim(),lower=text.toLowerCase();
    if(!lower)return [];
    const results=[];
    const seen=new Set();
    const add=(scope,label,description,kind,primary)=>{
      const candidates=engine.candidateSuppliers(scope);
      if(!candidates.length)return;
      if(!candidates.some(s=>s.serviceIds.some(id=>engine.serviceById.has(id))))return;
      const key=JSON.stringify(scope);if(seen.has(key))return;seen.add(key);
      const fleets=[...new Set(candidates.flatMap(s=>data.dataKind==='live'?s.ownerHistory.map(h=>'owner:'+h.ownerId):[s.fleetId]))];
      results.push({scope,label,description,kind,supplierCount:candidates.length,
        primaryService:primary??servicesFor(scope)[0]?.id??engine.fleetById.get(fleets[0]).primary,fleetNames:fleets.map(id=>engine.fleetById.get(id).name)});
    };
    for(const fleet of data.fleets.filter(f=>f.name.toLowerCase().includes(lower)||f.id===lower||f.ownerAddress?.toLowerCase().includes(lower))) {
      add(fleetScope(fleet.id),fleet.name,`${fleet.exampleCount} Supplier identities · ${fleet.services.length} services`,'Fleet',fleet.primary);
    }
    const exactSupplier=data.suppliers.find(s=>s.id.toLowerCase()===lower);
    if(exactSupplier) add({type:'supplier',value:exactSupplier.id},`${engine.fleetById.get(exactSupplier.fleetId).name} · ${exactSupplier.name}`,'Measure this Supplier identity','Supplier');
    const owners=[...new Set(data.suppliers.flatMap(s=>s.ownerHistory.map(h=>h.ownerId)))];
    const owner=owners.find(id=>id.toLowerCase()===lower);
    if(owner)add({type:'owner',value:owner},owner,'Follow this owner’s membership at each historical observation','Owner address');
    const host=normaliseHost(text);
    const matchingDomains=domainDirectory().filter(g=>g.domain.includes(lower)||(host&&g.domain===host))
      .sort((a,b)=>(a.domain!==lower)-(b.domain!==lower)||b.supplierCount-a.supplierCount||a.domain.localeCompare(b.domain));
    for(const group of matchingDomains)add(group.scope,group.name,
      `${group.supplierCount} matching Suppliers · ${group.ownerCount} owner addresses · ${group.serviceCount} collected services`,'Endpoint domain',group.primary);
    if(host && (host.includes('.')||host.includes(':')||data.suppliers.some(s=>s.endpointHosts.includes(host)))) {
      const exactHosts=engine.candidateSuppliers({type:'hostname',value:host});
      const domainMatches=engine.candidateSuppliers({type:'domain',value:host});
      const matches=domainMatches.length?domainMatches:exactHosts;
      if(matches.length) {
        const type=exactHosts.length===domainMatches.length?'hostname':'domain';
        const fleetIds=[...new Set(matches.flatMap(s=>data.dataKind==='live'?s.ownerHistory.map(h=>'owner:'+h.ownerId):[s.fleetId]))];
        add({type,value:host},host,`${matches.length} matching Suppliers across ${fleetIds.length} ${fleetIds.length===1?'fleet':'fleets'} · endpoint match` ,type==='hostname'?'Hostname':'Domain');
        if(fleetIds.length>1)for(const id of fleetIds) {
          const count=engine.candidateSuppliers({type,value:host,fleetId:id}).length;
          add({type,value:host,fleetId:id},`${engine.fleetById.get(id).name} · ${host}`,`${count} matching Suppliers from this fleet`,'Fleet subset',engine.fleetById.get(id).primary);
        }
      }
    }
    if(!text.includes('://'))for(const hostname of [...new Set([...data.suppliers.flatMap(s=>s.endpointHosts),...domainDirectory().flatMap(g=>g.hostnames)])]
      .filter(h=>h.includes(lower)&&h!==host).sort()) {
      add({type:'hostname',value:hostname},hostname,'Recorded endpoint hostname; membership follows the service and observation.','Hostname');
      if(results.length>=10)break;
    }
    return results.slice(0,10);
  }

  function servicesFor(scope,filters=[]) {
    const candidates=engine.candidateSuppliers(scope);
    const registered=new Set(['domain','hostname'].includes(scope.type)&&endpointById.size?
      engine.scopedEndpoints(scope).map(e=>e.serviceId):
      candidates.flatMap(s=>s.serviceIds));
    const recordedServices=new Set(settlements?.servicesForScope(scope)??[]);
    for(const id of recordedServices)registered.add(id);
    return data.services.filter(service=>registered.has(service.id)).map(service=>{
      const populations=data.populations.filter(pop=>pop.serviceId===service.id);
      const query={scope,serviceId:service.id,period:'30',filters};
      const reference=engine.latestReference(query);
      const everEligible=populations.some(pop=>engine.eligibleIds(pop,query).length>0);
      return {...service,latestEligibleCount:reference.ownEligible,availability:everEligible?'available':recordedServices.has(service.id)?'recorded_only':'not_eligible'};
    }).sort(sortService);
  }

  function suppliersFor(query) {
    const frames=engine.framesFor(query);
    const period=engine.periodFor(query);
    const serviceIds=engine.serviceIdsFor(query);
    const dates=[...new Set(data.populations.filter(pop=>serviceIds.includes(pop.serviceId)&&pop.observedAt>=period.start&&pop.observedAt<period.endExclusive).map(pop=>pop.observedAt))];
    const candidates=engine.candidateSuppliers(query.scope).filter(supplier=>dates.some(date=>
      serviceIds.some(serviceId=>engine.matchesScope(supplier,query.scope,date,serviceId)&&(query.filters??[]).every(filter=>engine.matchesSupplierFilter(supplier,filter,date,serviceId)))));
    const eligible=new Set(frames.flatMap(frame=>engine.eligibleIds(populationById.get(frame.populationId),query)));
    const snapshotDate=data.populations.reduce((date,p)=>+new Date(p.observedAt)>+new Date(date)?p.observedAt:date,data.period.start);
    return candidates.map(supplier=>({...supplier,currentOwner:ownerAt(supplier,snapshotDate),
      registeredForService:supplier.serviceIds.some(id=>serviceIds.includes(id)),
      eligibleInPeriod:eligible.has(supplier.id),
      fleetName:engine.fleetById.get(supplier.fleetId).name,period}));
  }

  function exportResult(query,dimension) {
    return {purpose:data.dataKind==='live'?(settlements?'Indexed settlement earnings with separate sampled selection':'Sampled historical mainnet fleet analysis'):'Fictional POKT fleet analysis for product review',...engine.report(query),
      breakdown:engine.breakdown(query,dimension),
      earningsEstimate:engine.persistenceDiagnostic(query),
      sessionEvidence:engine.earningsFramesFor(query),
      selectionEvidence:settlements?engine.framesFor(query):undefined,
      recordedSettlementEvidence:settlements?.exportEvidence(query),
      endpointEvidence:data.dataKind==='live'?suppliersFor(query).map(s=>({supplierId:s.id,ownerHistory:s.ownerHistory,
        endpointHistory:s.endpointHistory.filter(h=>h.start<engine.periodFor(query).endExclusive&&(!h.end||h.end>engine.periodFor(query).start)).map(h=>({...h,endpoints:(h.endpointIds??[]).map(id=>endpointById.get(id))
          .filter(e=>e&&engine.serviceIdsFor(query).includes(e.serviceId))})).filter(h=>h.endpoints.length)})):undefined,
      source:data.liveSource??null,settlementReceipt:settlements?.info.receipt??null,
      disclosure:settlements?settlements.info.notice:data.description};
  }

  const leaderboardCache=new Map();
  function leaderboard(serviceId,period='30',grouping='owner') {
    if(!settlements)return (grouping==='domain'?data.liveSource?.domainLeaderboards:data.liveSource?.leaderboards)?.[period]?.[serviceId]??[];
    if(settlementTables)return settlementTables.periods?.[period]?.[serviceId]?.[grouping]??[];
    const key=JSON.stringify([serviceId,period,grouping]);
    if(leaderboardCache.has(key))return leaderboardCache.get(key);
    const query={scope:{type:'network',value:snapshotInfo.networkScopeValue},serviceId,serviceIds:[serviceId],period,filters:[]};
    const old=(grouping==='domain'?data.liveSource?.domainLeaderboards:data.liveSource?.leaderboards)?.[period]?.[serviceId]??[];
    const oldById=new Map(old.map(row=>[row.domain??row.ownerAddress,row]));
    const rows=engine.groupDefinitions(query,grouping).map(group=>{
      const scope={type:grouping,value:group.value},report=engine.report({...query,scope}),previous=oldById.get(group.value);
      return {...previous,...(grouping==='domain'?{domain:group.value}:{ownerAddress:group.value}),name:previous?.name??group.label,
        eligibleSuppliers:report.scope.latestEligibleCount,...report.rewards,earningsUniverse:'indexed-settled-sessions'};
    });
    if(leaderboardCache.size>=6)leaderboardCache.delete(leaderboardCache.keys().next().value);
    leaderboardCache.set(key,rows);return rows;
  }

  return {snapshotInfo,directory,domainDirectory,search,servicesFor,suppliersFor,coverageDiagnostics,
    serviceCatalog:()=>data.liveSource?.serviceCatalog??data.services,
    leaderboard,
    getReport:engine.report,getBreakdown:engine.breakdown,getGroups:engine.groupDefinitions,
    getSelectionDiagnostic:engine.selectionDiagnostic,getPersistenceDiagnostic:engine.persistenceDiagnostic,
    getSession:engine.sessionDetails,getSessionPoints:query=>engine.earningsFramesFor(query).filter(row=>row.comparisonReady&&row.reference>0),
    getEndpoints:(supplierId,query)=>{
      const supplier=engine.supplierById.get(supplierId);if(!supplier)return [];
      const period=engine.periodFor(query),services=new Set(engine.serviceIdsFor(query));
      const historical=supplier.endpointHistory.filter(h=>h.start<period.endExclusive&&(!h.end||h.end>period.start))
        .map(h=>({...h,endpoints:(h.endpointIds??[]).map(id=>endpointById.get(id)).filter(e=>e&&services.has(e.serviceId))}));
      return [...historical,...(settlements?.endpointsFor(supplierId,query)??[])];
    },
    exportResult,getSupplier:id=>engine.supplierById.get(id),getFleet:id=>engine.fleetById.get(id)};
}
