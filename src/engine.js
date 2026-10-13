import {dayBootstrap, stringSeed, selectionDistribution, seededRandom, quantile} from './math.js';

export function ownerAt(supplier, date) {
  return supplier.ownerHistory.find(row => row.start <= date && (!row.end || date < row.end))?.ownerId ?? null;
}

const endpointHistoryHosts=new WeakMap();

export function hostsAt(supplier, date, serviceId=null, endpointById=null) {
  const history=supplier.endpointHistory?.find(row=>row.start<=date&&(!row.end||date<row.end));
  if(history?.endpointIds&&endpointById) {
    let cached=endpointHistoryHosts.get(history);
    if(!cached||cached.endpointById!==endpointById) {
      const all=new Set(),byService=new Map();
      for(const id of history.endpointIds){const endpoint=endpointById.get(id);if(!endpoint?.hostname)continue;
        all.add(endpoint.hostname);if(!byService.has(endpoint.serviceId))byService.set(endpoint.serviceId,new Set());
        byService.get(endpoint.serviceId).add(endpoint.hostname);}
      cached={endpointById,all:Object.freeze([...all]),byService:new Map([...byService].map(([id,hosts])=>[id,Object.freeze([...hosts])]))};
      endpointHistoryHosts.set(history,cached);
    }
    return serviceId?cached.byService.get(serviceId)??[]:cached.all;
  }
  return history?.hosts ?? (supplier.endpointHistory?[]:supplier.endpointHosts);
}

export function normaliseHost(input) {
  try {
    const text = String(input).trim();
    const address=text.includes(':')&&!text.includes('://')&&!text.startsWith('[')&&/^[0-9a-f:]+$/i.test(text)?`[${text}]`:text;
    const url = new URL(address.includes('://') ? address : `https://${address}`);
    if (!['http:', 'https:', 'ws:', 'wss:', 'grpc:', 'grpcs:'].includes(url.protocol) || url.username || url.password) return null;
    return url.hostname.toLowerCase().replace(/^\[|\]$/g,'').replace(/\.$/, '');
  } catch { return null; }
}

export function hostMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

export function createAnalysisEngine(data, settlements=null) {
  const supplierById = new Map(data.suppliers.map(row => [row.id, row]));
  const populationById = new Map(data.populations.map(row => [row.id, row]));
  // Dated references do not depend on the input array's order.
  const latestPopulationByService = new Map();
  for (const population of data.populations) {
    const previous = latestPopulationByService.get(population.serviceId);
    if (!previous || +new Date(population.observedAt) > +new Date(previous.observedAt)) latestPopulationByService.set(population.serviceId, population);
  }
  const fleetById = new Map(data.fleets.map(row => [row.id, row]));
  const gatewayById = new Map(data.gateways.map(row => [row.id, row]));
  const applicationById = new Map(data.applications.map(row => [row.id, row]));
  const serviceById = new Map(data.services.map(row => [row.id, row]));
  const endpointById = new Map((data.endpointCatalog??[]).map(row=>[row.id,row]));
  const sessionsByService = new Map(data.services.map(service => [service.id, data.sessions.filter(s => s.serviceId === service.id)]));
  const reportCache = new Map();
  const frameCache = new Map();
  const candidateCache=new Map(),filteredCandidateCache=new Map(),populationSets=new WeakMap();
  const queryFilters = query => query.filters ?? (query.filter ? [query.filter] : []);
  const serviceIdsFor = query => [...new Set(query.serviceIds??[query.serviceId])].filter(Boolean).sort();
  const analysisKey = query => JSON.stringify({scope:settlements&&query.scope.type==='fleet'&&fleetById.get(query.scope.value)?.ownerAddress?{type:'owner',value:fleetById.get(query.scope.value).ownerAddress,...(query.scope.fleetId?{fleetId:query.scope.fleetId}:{})}:query.scope,services:serviceIdsFor(query),period:String(query.period??'30'),filters:queryFilters(query).slice().sort((a,b)=>a.dimension.localeCompare(b.dimension)||a.value.localeCompare(b.value))});

  function matchesFleet(supplier, fleetId, date) {
    const fleet=fleetById.get(fleetId);
    return fleet?.ownerAddress?ownerAt(supplier,date)===fleet.ownerAddress:supplier.fleetId===fleetId;
  }

  function everInFleet(supplier, fleetId) {
    const fleet=fleetById.get(fleetId);
    return fleet?.ownerAddress?supplier.ownerHistory.some(h=>h.ownerId===fleet.ownerAddress):supplier.fleetId===fleetId;
  }

  function endpointHistoriesFor(supplier,scope) {
    const owner=scope.fleetId?fleetById.get(scope.fleetId)?.ownerAddress:null;
    return (supplier.endpointHistory??[]).filter(h=>(!owner||supplier.ownerHistory.some(o=>o.ownerId===owner&&
      Math.max(+new Date(h.start),+new Date(o.start))<Math.min(+new Date(h.end??data.period.endExclusive),+new Date(o.end??data.period.endExclusive))))&&
      (h.endpointIds?h.endpointIds.some(id=>{const e=endpointById.get(id);return e?.hostname&&(scope.type==='hostname'?e.hostname===scope.value:hostMatches(e.hostname,scope.value));}):
        h.hosts.some(host=>scope.type==='hostname'?host===scope.value:hostMatches(host,scope.value))));
  }

  function scopedEndpoints(scope) {
    return candidateSuppliers(scope).flatMap(s=>endpointHistoriesFor(s,scope).flatMap(h=>(h.endpointIds??[]).map(id=>endpointById.get(id))))
      .filter(e=>e?.hostname&&(scope.type==='hostname'?e.hostname===scope.value:hostMatches(e.hostname,scope.value)));
  }

  function matchesScope(supplier, scope, date, serviceId=null) {
    if (scope.fleetId && !matchesFleet(supplier,scope.fleetId,date)) return false;
    if (scope.type === 'network') return scope.value === (data.networkScopeValue??'illustrative-sample');
    if (scope.type === 'fleet') return fleetById.get(scope.value)?.ownerAddress ? ownerAt(supplier,date)===fleetById.get(scope.value).ownerAddress : supplier.fleetId === scope.value;
    if (scope.type === 'supplier') return supplier.id === scope.value;
    if (scope.type === 'owner') return ownerAt(supplier, date) === scope.value;
    if (scope.type === 'hostname') return hostsAt(supplier,date,serviceId,endpointById).includes(scope.value);
    if (scope.type === 'domain') return hostsAt(supplier,date,serviceId,endpointById).some(host => hostMatches(host, scope.value));
    return false;
  }

  function matchesSupplierFilter(supplier, filter, date, serviceId=null) {
    if (!filter || !['infrastructure', 'hostname', 'domain', 'owner', 'supplier', 'fleet'].includes(filter.dimension)) return true;
    if (filter.dimension === 'infrastructure') return supplier.groupId === filter.value;
    if (filter.dimension === 'hostname') return hostsAt(supplier,date,serviceId,endpointById).includes(filter.value);
    if (filter.dimension === 'domain') return hostsAt(supplier,date,serviceId,endpointById).some(host => hostMatches(host, filter.value));
    if (filter.dimension === 'owner') return ownerAt(supplier, date) === filter.value;
    if (filter.dimension === 'supplier') return supplier.id === filter.value;
    return fleetById.get(filter.value)?.ownerAddress ? ownerAt(supplier,date)===fleetById.get(filter.value).ownerAddress : supplier.fleetId === filter.value;
  }

  function periodFor(query) {
    const end = data.period.endExclusive;
    const days = ['7','14','30'].includes(String(query.period)) ? Number(query.period) : 30;
    const start = new Date(Math.max(+new Date(data.period.start), +new Date(end) - days * 86400000)).toISOString();
    return {start, endExclusive:end, timezone:'UTC', requestedDays:days};
  }

  function candidateSuppliers(scope) {
    const key=JSON.stringify(scope);
    if(candidateCache.has(key))return candidateCache.get(key);
    const original=findCandidates(scope),ids=new Set(original.map(s=>s.id));
    const result=[...original,...(settlements?.candidateIds(scope)??[]).filter(id=>!ids.has(id)).map(id=>supplierById.get(id)).filter(Boolean)];
    candidateCache.set(key,result);return result;
  }

  function findCandidates(scope) {
    if(scope.type==='owner') return data.suppliers.filter(supplier=>(!scope.fleetId || everInFleet(supplier,scope.fleetId)) && supplier.ownerHistory.some(row=>row.ownerId===scope.value));
    if(scope.type==='fleet'&&fleetById.get(scope.value)?.ownerAddress) return candidateSuppliers({type:'owner',value:fleetById.get(scope.value).ownerAddress});
    if(scope.type==='hostname') return data.suppliers.filter(s=>(!scope.fleetId||everInFleet(s,scope.fleetId))&&s.endpointHosts.includes(scope.value)&&(!scope.fleetId||!endpointById.size||endpointHistoriesFor(s,scope).length));
    if(scope.type==='domain') return data.suppliers.filter(s=>(!scope.fleetId||everInFleet(s,scope.fleetId))&&s.endpointHosts.some(h=>hostMatches(h,scope.value))&&(!scope.fleetId||!endpointById.size||endpointHistoriesFor(s,scope).length));
    return data.suppliers.filter(supplier => matchesScope(supplier, scope, data.period.start.slice(0,10)));
  }

  function eligibleIds(population, query) {
    const date = population.observedAt;
    const filters=queryFilters(query).filter(f=>['infrastructure','hostname','domain','owner','supplier','fleet'].includes(f.dimension));
    if(query.scope.type==='network'&&query.scope.value===(data.networkScopeValue??'illustrative-sample')&&!query.scope.fleetId&&!filters.length)return population.eligibleSupplierIds;
    const key=JSON.stringify([query.scope,filters]);
    if(!filteredCandidateCache.has(key))filteredCandidateCache.set(key,candidateSuppliers(query.scope).filter(s=>filters.every(f=>
      f.dimension==='supplier'?s.id===f.value:f.dimension==='hostname'?s.endpointHosts.includes(f.value):f.dimension==='domain'?s.endpointHosts.some(h=>hostMatches(h,f.value)):f.dimension==='owner'?s.ownerHistory.some(h=>h.ownerId===f.value):true)));
    if(!populationSets.has(population.eligibleSupplierIds))populationSets.set(population.eligibleSupplierIds,new Set(population.eligibleSupplierIds));
    const eligible=populationSets.get(population.eligibleSupplierIds);
    return filteredCandidateCache.get(key).filter(supplier=>eligible.has(supplier.id)&&matchesScope(supplier,query.scope,date,population.serviceId)&&filters.every(filter=>matchesSupplierFilter(supplier,filter,date,population.serviceId))).map(s=>s.id);
  }

  function selectedCountKey(count) {
    return count <= 2 ? String(count) : count <= 5 ? '3–5' : '6+';
  }

  function valueKey(value) {
    return value < 250 ? 'low' : value <= 500 ? 'medium' : 'high';
  }

  function hourKey(startedAt) {
    return String(Math.floor(new Date(startedAt).getUTCHours() / 6) * 6);
  }

  function weekKey(date) {
    return String(Math.floor((+new Date(`${date}T00:00:00.000Z`)- +new Date(data.period.start))/604800000));
  }

  function weekLabel(key,query) {
    const period=periodFor(query);
    const start=new Date(Math.max(+new Date(period.start), +new Date(data.period.start)+Number(key)*604800000));
    const end=new Date(Math.min(+new Date(period.endExclusive)-86400000, +new Date(data.period.start)+(Number(key)+1)*604800000-86400000));
    const label=date=>date.toLocaleDateString('en-GB',{day:'numeric',month:'short',timeZone:'UTC'});
    return start.getUTCMonth()===end.getUTCMonth()?`${start.getUTCDate()}–${end.getUTCDate()} ${end.toLocaleDateString('en-GB',{month:'short',timeZone:'UTC'})}`:`${label(start)}–${label(end)}`;
  }

  function matchesSessionFilter(frame, filter) {
    if (!filter) return true;
    if (filter.dimension === 'service') return frame.serviceId === filter.value;
    if (filter.dimension === 'gateway') return (frame.gatewayId ?? 'unknown') === filter.value;
    if (filter.dimension === 'application') return frame.applicationId === filter.value;
    if (filter.dimension === 'hour') return hourKey(frame.startedAt) === filter.value;
    if (filter.dimension === 'week') return weekKey(frame.date) === filter.value;
    if (filter.dimension === 'selected_count') return frame.selectionReady && selectedCountKey(frame.X) === filter.value;
    if (filter.dimension === 'session_value') return frame.pool !== null && valueKey(frame.pool) === filter.value;
    return true;
  }

  function framesFor(query) {
    const cacheKey = analysisKey(query);
    if (frameCache.has(cacheKey)) return frameCache.get(cacheKey);
    const period = periodFor(query);
    const eligibilityCache = new Map();
    const frames = [];
    const sessions=serviceIdsFor(query).flatMap(id=>sessionsByService.get(id)??[]).sort((a,b)=>a.startedAt.localeCompare(b.startedAt)||a.id.localeCompare(b.id));
    for (const session of sessions) {
      if (session.startedAt < period.start || session.startedAt >= period.endExclusive) continue;
      const population = populationById.get(session.populationId);
      if (!eligibilityCache.has(population.id)) eligibilityCache.set(population.id, new Set(eligibleIds(population, query)));
      const own = eligibilityCache.get(population.id);
      const selectionReady = session.rosterStatus === 'complete';
      const X = selectionReady ? session.selectedSupplierIds.filter(id => own.has(id)).length : null;
      const comparisonReady = selectionReady && session.payoutStatus === 'complete' && session.selectedCount > 0;
      const frame = {sessionId:session.id, serviceId:session.serviceId, date:session.startedAt.slice(0,10), startedAt:session.startedAt,
        gatewayId:session.gatewayId, applicationId:session.applicationId, populationId:population.id,
        N:population.totalEligible, n:own.size, K:session.selectedCount, X,
        selectionReady, comparisonReady, payoutStatus:session.payoutStatus, rosterStatus:session.rosterStatus,
        pool:session.totalPayoutPokt, actual:comparisonReady ? session.supplierPayouts.filter(p=>own.has(p.supplierId)).reduce((sum,p)=>sum+p.pokt,0) : null,
        reference:comparisonReady ? session.totalPayoutPokt * X / session.selectedCount : null,
        availableAt:session.outcomeAvailableAt};
      if (queryFilters(query).every(filter=>matchesSessionFilter(frame, filter))) frames.push(frame);
    }
    if (frameCache.size > 80) frameCache.clear();
    frameCache.set(cacheKey, frames);
    return frames;
  }

  const earningsFramesFor = query => settlements ? settlements.framesFor(query) : framesFor(query);

  function summariseRewards(frames, seed) {
    const comparable = frames.filter(row=>row.comparisonReady);
    const actual = comparable.reduce((sum,row)=>sum+row.actual,0);
    const reference = comparable.reduce((sum,row)=>sum+row.reference,0);
    const dailyMap = new Map();
    for (const row of comparable) {
      if (!dailyMap.has(row.date)) dailyMap.set(row.date,{date:row.date,actual:0,reference:0,sessions:0,positiveSessions:0});
      const day = dailyMap.get(row.date);
      day.actual += row.actual; day.reference += row.reference; day.sessions++;
      if (row.reference > 0) day.positiveSessions++;
    }
    const daily = [...dailyMap.values()].sort((a,b)=>a.date.localeCompare(b.date));
    return summariseRewardDaily(daily,frames.length,comparable.length,seed,{actual,reference});
  }

  function latestReference(query) {
    const ids=serviceIdsFor(query);
    if(ids.length!==1)return null;
    const population = latestPopulationByService.get(ids[0]);
    if (!population) return null;
    return {observedAt:population.observedAt, totalEligible:population.totalEligible,
      ownEligible:eligibleIds(population,query).length, selectionCap:population.selectionCap,
      populationId:population.id, assumption:'Other eligible Suppliers and the selection cap remain fixed.'};
  }

  function scenarioReferences(query) {
    return serviceIdsFor(query).map(serviceId=>({serviceId,serviceName:serviceById.get(serviceId).name,
      ...latestReference({...query,serviceIds:[serviceId],serviceId})}));
  }

  function scopeContext(query, frames) {
    const candidates = candidateSuppliers(query.scope);
    const scope = query.scope;
    const fleet = fleetById.get(scope.type==='fleet'?scope.value:scope.fleetId);
    const supplier = scope.type==='supplier'?supplierById.get(scope.value):null;
    let label = scope.type==='network' ? 'Network overview' : scope.type==='fleet' ? fleet?.name : scope.type==='supplier' ? `${fleetById.get(supplier?.fleetId)?.name} · ${supplier?.name}` : scope.value;
    if (!label) label = 'Selected Suppliers';
    const rule = scope.type==='hostname'||scope.type==='domain' ? `Recorded ${data.dataKind==='live'?'service-specific ':''}endpoint associations${fleet?.ownerAddress?' and owner membership':''} at each historical observation` : scope.type==='owner' || fleet?.ownerAddress || queryFilters(query).some(filter=>filter.dimension==='owner') ? 'Owner membership at each observation' : scope.type==='supplier' ? 'Fixed Supplier identity with historical eligibility' : 'Recorded fleet directory with historical eligibility';
    const ids = new Set();
    for (const frame of frames) for (const id of eligibleIds(populationById.get(frame.populationId),query)) ids.add(id);
    const latestIds=new Set();
    for(const serviceId of serviceIdsFor(query)) {
      const population=latestPopulationByService.get(serviceId);
      if(population)for(const id of eligibleIds(population,query))latestIds.add(id);
    }
    const fleetIds = [...new Set(candidates.flatMap(row=>data.dataKind==='live'?row.ownerHistory.map(h=>'owner:'+h.ownerId):[row.fleetId]))];
    return {type:scope.type,value:scope.value,label,fleetId:fleet?.id??null,
      fleetNames:fleetIds.map(id=>fleetById.get(id).name),supplierCount:ids.size,
      identityCount:candidates.length,latestEligibleCount:latestIds.size,
      membershipRule:rule,fictional:data.dataKind==='illustrative',filters:queryFilters(query),
      sampleNotice:scope.type==='network'?(data.networkNotice??'Eight fictional fleets form this sample. It is not a whole-network census.'):fleet?.ownerAddress?'Grouped by historical owner address. A verified business name has not been assigned.':null};
  }

  function exposureSummary(frames) {
    const known = frames.filter(row=>row.selectionReady);
    const positions = known.reduce((sum,row)=>sum+row.X,0);
    const present = known.filter(row=>row.X>0).length;
    const nValues = frames.map(row=>row.n);
    let expectedPresence = 0, expectedPositions = 0;
    const probabilityCache = new Map();
    for (const row of known) {
      const key = `${row.N}:${row.n}:${row.K}`;
      if (!probabilityCache.has(key)) probabilityCache.set(key,selectionDistribution(row.N,row.n,row.K));
      expectedPresence += 1 - probabilityCache.get(key)[0];
      expectedPositions += row.N ? row.K * row.n / row.N : 0;
    }
    return {availability:known.length?'available':'unavailable',reason:known.length?null:'No verified session rosters in this view.',
      recordedSessions:frames.length,verifiedSessions:known.length,presentSessions:present,
      presenceFraction:known.length?present/known.length:null,meanSelected:known.length?positions/known.length:null,
      expectedPresenceFraction:known.length?expectedPresence/known.length:null,expectedMeanSelected:known.length?expectedPositions/known.length:null,
      eligibleRange:nValues.length?[Math.min(...nValues),Math.max(...nValues)]:null,
      missingRosters:frames.length-known.length,selectedPositions:positions};
  }

  function trendSummary(frames, query) {
    const weeks = [...new Set(frames.map(row=>weekKey(row.date)))];
    const points = weeks.map(key=>{
      const group = frames.filter(row=>weekKey(row.date)===key);
      const rewards = summariseRewards(group,stringSeed(`trend:${analysisKey(query)}:${key}`));
      return {id:key,label:weekLabel(key,query),...rewards};
    });
    const midpoint = new Date((+new Date(periodFor(query).start)+ +new Date(periodFor(query).endExclusive))/2).toISOString();
    const earlier = summariseRewards(frames.filter(row=>row.startedAt<midpoint),stringSeed(`earlier:${analysisKey(query)}`));
    const later = summariseRewards(frames.filter(row=>row.startedAt>=midpoint),stringSeed(`later:${analysisKey(query)}`));
    const variable = earlier.positiveSessions>=12 && later.positiveSessions>=12 && earlier.ratio>0 && later.ratio>0 &&
      Math.abs(Math.log(later.ratio/earlier.ratio)) > Math.log(1.6);
    return {points,variable,earlierRatio:earlier.ratio,laterRatio:later.ratio};
  }

  function report(query) {
    const serviceIds=serviceIdsFor(query);
    if (!serviceIds.length || serviceIds.some(id=>!serviceById.has(id))) throw new Error('Unknown or empty service selection.');
    const key = JSON.stringify(query);
    if (reportCache.has(key)) return reportCache.get(key);
    const frames = framesFor(query);
    const financialFrames=earningsFramesFor(query);
    const rewards = summariseRewards(financialFrames,stringSeed(analysisKey(query)));
    const exposure = exposureSummary(frames);
    const services=serviceIds.map(id=>serviceById.get(id));
    const service=services.length===1?services[0]:{id:'selected-services',name:`${services.length} services`,shortName:`${services.length} services`};
    const perService=services.map(service=>{
      const subset=financialFrames.filter(row=>row.serviceId===service.id);
      return {id:service.id,label:service.name,...summariseRewards(subset,stringSeed(analysisKey({...query,serviceIds:[service.id],serviceId:service.id}))),exposure:exposureSummary(frames.filter(row=>row.serviceId===service.id))};
    });
    const result = {schemaVersion:1,dataKind:data.dataKind,snapshotId:settlements?.info.snapshotId??data.snapshotId,generatedAt:settlements?.info.receipt.completedAt??data.generatedAt,
      earningsUniverse:settlements?'indexed-settled-sessions':'sampled-sessions',
      query:{...query,serviceIds,serviceId:serviceIds.includes(query.serviceId)?query.serviceId:serviceIds[0]},scope:scopeContext(query,frames),service,services,period:periodFor(query),
      rewards,exposure,scenarioReference:latestReference(query),scenarioReferences:scenarioReferences(query),
      perService,trend:trendSummary(financialFrames,query),
      evidence:{recordedSessions:financialFrames.length,verifiedRosters:financialFrames.filter(row=>row.selectionReady).length,
        selectionSampleSessions:frames.length,sampledComparableOutcomes:frames.filter(row=>row.comparisonReady).length,
        earningsUniverse:settlements?'indexed-settled-sessions':'sampled-sessions',settlementNotice:settlements?.info.notice??null,
        comparableOutcomes:rewards.comparableSessions,missingOutcomes:financialFrames.filter(row=>row.payoutStatus==='missing').length,
        pendingOutcomes:financialFrames.filter(row=>row.payoutStatus==='pending').length,
        zeroPoolSessions:financialFrames.filter(row=>row.comparisonReady&&row.pool===0).length,
        informativeDays:rewards.informativeDays,positiveOpportunities:rewards.positiveSessions,
        largestDayShare:rewards.largestDayShare,membershipRule:scopeContext(query,frames).membershipRule,
        sourceNotice:data.description,sampling:data.sampling,
        thresholdNotice:'Exploratory display rules, not certified reliability thresholds.',
        limitations:['Selection does not reserve traffic.','The equal-share amount is a comparison, not promised income.',
          'Earnings differences can reflect routing, request mix, infrastructure, geography, claiming and settlement.',
          'Uncertainty ranges do not correct missing data, source bias or dependence between days.']}};
    if (reportCache.size>60) reportCache.clear();
    reportCache.set(key,result);
    return result;
  }

  function groupDefinitions(query, dimension) {
    const settledGroups=settlements?.groupDefinitions(query,dimension);
    if(settledGroups)return settledGroups;
    const candidates = candidateSuppliers(query.scope);
    const unique = entries=>[...new Map(entries.map(row=>[row.value,row])).values()];
    if (dimension==='service') return serviceIdsFor(query).map(id=>({value:id,label:serviceById.get(id).name}));
    if (dimension==='infrastructure') return unique(candidates.map(s=>({value:s.groupId,label:s.groupName,description:fleetById.get(s.fleetId).name})));
    if (dimension==='fleet') return unique(candidates.flatMap(s=>data.dataKind==='live'?s.ownerHistory.map(h=>({value:'owner:'+h.ownerId,label:fleetById.get('owner:'+h.ownerId).name})):[{value:s.fleetId,label:fleetById.get(s.fleetId).name}]));
    if (dimension==='hostname'||dimension==='domain') {
      const serviceIds=new Set(serviceIdsFor(query)),period=periodFor(query);
      if(endpointById.size)return unique(candidates.flatMap(s=>(s.endpointHistory??[])
        .filter(h=>h.start<period.endExclusive&&(!h.end||h.end>period.start))
        .flatMap(h=>(h.endpointIds??[]).map(id=>endpointById.get(id)))
        .filter(e=>e&&serviceIds.has(e.serviceId))
        .map(e=>dimension==='domain'?e.registrableDomain:e.hostname).filter(Boolean)
        .map(value=>({value,label:value}))));
      if(dimension==='hostname')return unique(candidates.flatMap(s=>s.endpointHosts.map(host=>({value:host,label:host}))));
      return [];
    }
    if (dimension==='owner') return unique(candidates.flatMap(s=>s.ownerHistory.map(h=>({value:h.ownerId,label:h.ownerId}))));
    if (dimension==='supplier') return candidates.map(s=>({value:s.id,label:`${s.name} · ${fleetById.get(s.fleetId).name}`}));
    if (dimension==='gateway') return [...data.gateways.map(g=>({value:g.id,label:g.name})),{value:'unknown',label:'Gateway not recorded'}];
    if (dimension==='application') return data.applications.map(a=>({value:a.id,label:a.name,description:gatewayById.get(a.gatewayId)?.name??'Gateway not recorded'}));
    if (dimension==='hour') return [0,6,12,18].map(hour=>({value:String(hour),label:`${String(hour).padStart(2,'0')}:00–${String(hour+6).padStart(2,'0')}:00 UTC`}));
    if (dimension==='week') return [...new Set(earningsFramesFor(query).map(row=>weekKey(row.date)))].map(key=>({value:key,label:weekLabel(key,query)}));
    if (dimension==='selected_count') return ['0','1','2','3–5','6+'].map(value=>({value,label:`${value} selected`}));
    if (dimension==='session_value') return [{value:'low',label:'Under 250 POKT'},{value:'medium',label:'250–500 POKT'},{value:'high',label:'Over 500 POKT'}];
    return [];
  }

  function breakdown(query, dimension, options={}) {
    // A grouping replaces the same dimension's filter; other active filters are retained.
    const base = {...query,filter:null,filters:queryFilters(query).filter(filter=>filter.dimension!==dimension)};
    const definitions=groupDefinitions(base,dimension);
    // Supplier-level views share the same session frame when no session filter
    // is active. Only compute the requested visible page; exports omit a limit.
    const identityDimension=['supplier','owner','fleet','hostname','domain','infrastructure'].includes(dimension);
    const canPage=identityDimension&&(settlements||!base.filters.some(f=>!['supplier','owner','fleet','hostname','domain','infrastructure'].includes(f.dimension)));
    const limit=canPage&&Number.isInteger(options.limit)&&options.limit>0?options.limit:definitions.length;
    const active=earningsFramesFor(base).length>0||framesFor(base).length>0;
    const bulk=settlements?.groupRewards(base,dimension);
    const rows = (active?definitions.slice(0,limit):[]).map(group=>{
      const child = {...base,filters:[...base.filters,{dimension,value:group.value}]};
      const aggregate=bulk?.get(group.value),frames=aggregate?null:earningsFramesFor(child);
      const recorded=aggregate?.recordedSessions??frames.length;
      if (!recorded && !(settlements&&dimension==='application')) return null;
      const rewards=aggregate?summariseRewardDaily(aggregate.daily,aggregate.recordedSessions,aggregate.comparableSessions,stringSeed(analysisKey(child)),aggregate.totals):summariseRewards(frames,stringSeed(analysisKey(child)));
      return {id:group.value,label:group.label,description:group.description??null,query:child,...rewards,
        ...(!recorded&&settlements?{reason:'No indexed settlements for this Application in this view. Sampled payouts remain unknown.'}:{}),
        // Financial rows use the settlement universe. Selection is calculated
        // from the separate original sample when this group is opened.
        exposure:settlements?null:exposureSummary(framesFor(child)),
        ...(settlements?{exposureNotice:'Selection is calculated from the separate sampled sessions in this group’s Summary.'}:{})};
    }).filter(Boolean);
    return {dimension,rows,totalGroups:canPage&&active?definitions.length:rows.length,overlapping:['hostname','domain'].includes(dimension),
      note:['hostname','domain'].includes(dimension)?`A Supplier can have more than one ${dimension}. These groups can overlap; their totals should not be added.`:null};
  }

  function selectionDiagnostic(query) {
    const frames = framesFor(query).filter(row=>row.selectionReady);
    const maximum = Math.max(0,...frames.map(row=>row.K));
    const observed = Array(maximum+1).fill(0), expected=Array(maximum+1).fill(0);
    const distributions = new Map();
    for (const frame of frames) {
      observed[frame.X]++;
      const key=`${frame.N}:${frame.n}:${frame.K}`;
      if (!distributions.has(key)) distributions.set(key,selectionDistribution(frame.N,frame.n,frame.K));
      distributions.get(key).forEach((probability,index)=>expected[index]+=probability);
    }
    const bins = [0,1,2,3,4,5,6].map(x=>({label:x===6?'6+':String(x),observed:x===6?observed.slice(6).reduce((a,b)=>a+b,0):observed[x]??0,
      expected:x===6?expected.slice(6).reduce((a,b)=>a+b,0):expected[x]??0}));
    const random = seededRandom(stringSeed(`selection:${analysisKey(query)}`));
    const cumulative = frames.map(frame=>{
      const p=distributions.get(`${frame.N}:${frame.n}:${frame.K}`);
      let sum=0;return p.map(value=>sum+=value);
    });
    const simulations = bins.map(()=>[]);
    for (let repetition=0;repetition<2000;repetition++) {
      const counts=Array(7).fill(0);
      for (const cdf of cumulative) {
        const draw=random();let x=0;
        while(x<cdf.length-1 && cdf[x]<draw)x++;
        counts[Math.min(6,x)]++;
      }
      counts.forEach((count,index)=>simulations[index].push(count));
    }
    bins.forEach((bin,index)=>bin.simulationInterval=[quantile(simulations[index],.025),quantile(simulations[index],.975)]);
    return {bins,sessions:frames.length,repetitions:2000,
      method:'Each verified session uses its own historical population. Pointwise ranges simulate independent uniform draws without replacement; they are descriptive guides, not a protocol pass/fail test.'};
  }

  function persistenceDiagnostic(query) {
    const frames=earningsFramesFor(query),period=periodFor(query);
    const collectedDays=(+new Date(settlements?.info.period.endExclusive??data.period.endExclusive)- +new Date(settlements?.info.period.start??data.period.start))/86400000;
    if(data.dataKind==='live'&&collectedDays<30)return {availability:'unavailable',reason:`Collect at least 30 days of comparable observations before testing an earnings estimate. This snapshot covers ${collectedDays} ${collectedDays===1?'day':'days'}.`};
    if (period.requestedDays<30) return {availability:'unavailable',reason:'Use the full month for a separate earlier and later comparison.'};
    const shift=days=>new Date(+new Date(data.period.start)+days*86400000).toISOString();
    const trainEnd=shift(13),testStart=shift(15);
    // Keep unavailable or late outcomes in the training coverage denominator.
    const training=frames.filter(row=>row.startedAt<trainEnd).map(row=>
      row.comparisonReady && row.availableAt && +new Date(row.availableAt)<+new Date(testStart)
        ? row : {...row,comparisonReady:false,actual:null,reference:null});
    const test=frames.filter(row=>row.startedAt>=testStart);
    const fit=summariseRewards(training,stringSeed(`training:${analysisKey(query)}`));
    const later=summariseRewards(test,stringSeed(`test:${analysisKey(query)}`));
    if (fit.availability!=='available' || later.informativeDays<7 || later.coverage<.9) return {availability:'unavailable',
      reason:`Earlier period: ${fit.informativeDays} informative days, ${fit.positiveSessions} opportunities, ${Math.round(fit.coverage*100)}% comparable. Later period: ${later.informativeDays} informative days, ${later.positiveSessions} opportunities, ${Math.round(later.coverage*100)}% comparable. ${fit.reason??'The later period needs at least 7 informative days and 90% comparable outcomes.'}`,
      earningsUniverse:settlements?'indexed-settled-sessions':'sampled-sessions'};
    const daily=new Map();
    for(const frame of test.filter(row=>row.comparisonReady)) {
      if(!daily.has(frame.date))daily.set(frame.date,{date:frame.date,actual:0,reference:0,adjusted:0,sessions:0});
      const day=daily.get(frame.date);day.actual+=frame.actual;day.reference+=frame.reference;
      day.adjusted+=Math.min(frame.pool,fit.ratio*frame.reference);
      day.sessions++;
    }
    const rows=[...daily.values()];
    const equalError=rows.reduce((sum,day)=>sum+Math.abs(day.actual-day.reference),0)/rows.length;
    const earlierError=rows.reduce((sum,day)=>sum+Math.abs(day.actual-day.adjusted),0)/rows.length;
    return {availability:'available',earlierRatio:fit.ratio,laterRatio:later.ratio,equalDailyErrorPokt:equalError,
      earlierDailyErrorPokt:earlierError,improvementFraction:equalError>0?1-earlierError/equalError:null,testDays:rows.length,
      trainingPeriod:{start:data.period.start.slice(0,10),endExclusive:trainEnd.slice(0,10)},
      gapPeriod:{start:trainEnd.slice(0,10),endExclusive:testStart.slice(0,10)},
      testPeriod:{start:testStart.slice(0,10),endExclusive:data.period.endExclusive.slice(0,10)},
      trainingDays:fit.informativeDays,trainingSessions:fit.comparableSessions,testCoverage:later.coverage,
      daily:rows.map(day=>({date:day.date,actualPokt:day.actual,equalSharePokt:day.reference,earlierEstimatePokt:day.adjusted,comparableSessions:day.sessions})),
      method:`Fit ${data.period.start.slice(0,10)} to ${trainEnd.slice(0,10)} (end excluded), allow a two-day gap, and evaluate ${testStart.slice(0,10)} to ${data.period.endExclusive.slice(0,10)} (end excluded). ${data.dataKind==='live'?'Training payouts must have settled before the test; historical indexer ingestion times are not known.':'Only training outcomes available before the test are used.'} Later opportunity is observed; this is not advance revenue forecasting.`};
  }

  function sessionDetails(query,id) {
    const frame=earningsFramesFor(query).find(row=>row.sessionId===id)??framesFor(query).find(row=>row.sessionId===id);
    if(!frame)return null;
    return {...frame,gatewayName:gatewayById.get(frame.gatewayId)?.name??'Gateway not recorded',
      serviceName:serviceById.get(frame.serviceId)?.name??frame.serviceId,
      applicationName:applicationById.get(frame.applicationId)?.name??frame.applicationId};
  }

  return {report,breakdown,framesFor,earningsFramesFor,periodFor,candidateSuppliers,latestReference,groupDefinitions,
    selectionDiagnostic,persistenceDiagnostic,sessionDetails,supplierById,fleetById,serviceById,matchesScope,
    eligibleIds,matchesSupplierFilter,serviceIdsFor,endpointById,scopedEndpoints};
}

export function summariseRewardDaily(daily,recordedSessions,comparableSessions,seed,totals=null) {
  const actual=totals?.actual??daily.reduce((n,day)=>n+day.actual,0);
  const reference=totals?.reference??daily.reduce((n,day)=>n+day.reference,0);
    const informativeDays = daily.filter(day=>day.reference>0).length;
    const positiveSessions = daily.reduce((n,day)=>n+day.positiveSessions,0);
    const coverage = recordedSessions ? comparableSessions / recordedSessions : 0;
    const largestDayShare = reference > 0 ? Math.max(...daily.map(day=>day.reference/reference)) : null;
    const ratio = reference > 0 ? actual / reference : null;
    let availability = 'available', reason = null;
    if (ratio === null) {availability='unavailable';reason=recordedSessions ? 'No positive equal-share comparison amount in this scope.' : 'No recorded sessions match this view.';}
    else if (coverage < .9) {availability='partial';reason=`${recordedSessions-comparableSessions} of ${recordedSessions} sessions lack comparable outcomes.`;}
    else if (informativeDays < 7 || positiveSessions < 24) {availability='limited';reason=`${informativeDays} informative days and ${positiveSessions} reward opportunities; more observations are needed.`;}
    else if (largestDayShare > .4) {availability='limited';reason='More than 40% of the comparison amount comes from one day.';}
    const bootstrap = ratio !== null && informativeDays >= 7 && positiveSessions >= 24 ? dayBootstrap(daily,seed) : {interval:null,definedDraws:0,repetitions:2000};
    if (availability === 'available' && !bootstrap.interval) {availability='limited';reason='A stable uncertainty range could not be estimated from these days.';}
    const interval = bootstrap.interval;
    const direction = availability === 'available' && interval ? interval[0] > 1 ? 'above' : interval[1] < 1 ? 'below' : 'no_clear_difference' : 'not_assessed';
    return {availability, reason, actualPokt:comparableSessions?actual:null, equalSharePokt:comparableSessions?reference:null,
      ratio, differencePercent:ratio===null?null:(ratio-1)*100, intervalRatio:interval,
      intervalDifferencePercent:interval?interval.map(value=>(value-1)*100):null, direction,
      informativeDays, positiveSessions, comparableSessions:comparableSessions, recordedSessions,
      coverage, largestDayShare, daily, bootstrap:{definedDraws:bootstrap.definedDraws,repetitions:bootstrap.repetitions}};

}
