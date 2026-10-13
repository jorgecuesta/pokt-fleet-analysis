/** Recorded settlements have a different denominator from the selection sample. */
export function createSettlementSource(sampled, wire, receipt) {
  const fail = message => { throw new Error(`Invalid settlement evidence: ${message}`); };
  const config = wire?.config;
  if (wire?.codec !== 'membership-indices-v2' || wire.dataKind !== 'live') fail('unsupported codec');
  if (!config || config.cutoff !== sampled.liveSource.cutoff ||
      config.referenceProductSha256 !== '059ffa4dba60e0c4e3f0f3810cdf778c87d09560c65a701735de5777b84b3b57' ||
      !Number.isFinite(+new Date(config.start)) || !Number.isFinite(+new Date(config.endExclusive)) ||
      +new Date(config.start) < +new Date(sampled.period.start) ||
      +new Date(config.endExclusive) !== +new Date(sampled.period.endExclusive) ||
      +new Date(config.start) >= +new Date(config.endExclusive)) fail('source window or cutoff differs');
  if (!receipt || receipt.status !== 'reconciled' || receipt.overlap?.passed !== true ||
      JSON.stringify(receipt.config) !== JSON.stringify(config)) fail('missing reconciled receipt');
  const services = new Set(sampled.services.map(s => s.id));
  if (!Array.isArray(config.services) || !config.services.length || new Set(config.services).size !== config.services.length ||
      config.services.some(id => !services.has(id))) fail('unknown or duplicate service');
  const checkIds = (ids, name) => {
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) fail(`${name} identities`);
  };
  checkIds(wire.supplierIds, 'Supplier'); checkIds(wire.ownerIds, 'owner');
  const supplierById = new Map(sampled.suppliers.map(s => [s.id, s]));
  const ownerSet = new Set(sampled.suppliers.flatMap(s => s.ownerHistory.map(h => h.ownerId)));
  if (wire.supplierIds.some(id => !supplierById.has(id)) || wire.ownerIds.some(id => !ownerSet.has(id))) fail('unmapped identity requires a directory update');
  const endpoints = wire.endpointCatalog;
  if (!Array.isArray(endpoints) || new Set(endpoints.map(e => e.id)).size !== endpoints.length ||
      endpoints.some(e => !e.id || !services.has(e.serviceId))) fail('endpoint catalog');
  const isIndex = (index, length) => Number.isInteger(index) && index >= 0 && index < length;
  if (!Array.isArray(wire.membershipCatalog)) fail('missing membership catalog');
  const members = wire.membershipCatalog.map(row => {
    if (!Array.isArray(row) || row.length !== 3 || !isIndex(row[0], wire.supplierIds.length) ||
        !isIndex(row[1], wire.ownerIds.length) || !Array.isArray(row[2]) ||
        row[2].some(i => !isIndex(i, endpoints.length)) || new Set(row[2]).size !== row[2].length) fail('membership index');
    return {supplierIndex:row[0], supplierId:wire.supplierIds[row[0]], ownerId:wire.ownerIds[row[1]],
      endpoints:row[2].map(i => endpoints[i]), hosts:row[2].map(i => endpoints[i].hostname).filter(Boolean),serviceIds:new Set()};
  });
  const money = value => {
    if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) fail('non-integer payout');
    const number = Number(value); if (!Number.isSafeInteger(number)) fail('payout exceeds exact integer range');
    return number;
  };
  const timeById=new Map();
  const ids = new Set(), byService = new Map(config.services.map(id => [id, []]));
  let claims = 0, verified = 0, verifiedClaims = 0;
  if (!Array.isArray(wire.sessions)) fail('missing sessions');
  for (const row of wire.sessions) {
    if (!row.id || ids.has(row.id) || !byService.has(row.serviceId) || !row.applicationId ||
        !Number.isSafeInteger(row.sessionEndHeight) || row.sessionEndHeight > config.cutoff ||
        !Number.isFinite(+new Date(row.endedAt)) || !row.endedAt.endsWith('Z') ||
        +new Date(row.endedAt) < +new Date(config.start) || +new Date(row.endedAt) >= +new Date(config.endExclusive) ||
        !Number.isSafeInteger(row.indexedClaimCount) || row.indexedClaimCount <= 0 ||
        !Number.isInteger(row.selectedCount) || row.selectedCount <= 0 ||
        !Array.isArray(row.members) || row.members.length !== row.selectedCount ||
        row.members.some(i => !isIndex(i, members.length))) fail('session identity, date or selected roster');
    const roster = row.members.map(i => members[i]);
    if (new Set(roster.map(m => m.supplierIndex)).size !== row.selectedCount ||
        roster.some(m => m.endpoints.some(e => e.serviceId !== row.serviceId))) fail('duplicate Supplier or cross-service endpoint');
    roster.forEach(member => member.serviceIds.add(row.serviceId));
    const selected = new Set(roster.map(m => m.supplierIndex));
    if (!Array.isArray(row.payouts) || row.payouts.some(p => !Array.isArray(p) || p.length !== 2 || !selected.has(p[0])) ||
        new Set(row.payouts.map(p => p[0])).size !== row.payouts.length) fail('unselected or duplicate payout identity');
    if (row.payoutStatus === 'verified') {
      const pool = money(row.poolUpokt), sum = row.payouts.reduce((n, p) => n + money(p[1]), 0);
      if (!Number.isSafeInteger(sum) || sum !== pool || !row.outcomeAvailableAt ||
          !Number.isFinite(+new Date(row.outcomeAvailableAt)) || +new Date(row.outcomeAvailableAt) < +new Date(row.endedAt)) fail('payout pool or settlement time');
      verified++; verifiedClaims += row.indexedClaimCount;
    } else if (row.payoutStatus !== 'unknown' || row.poolUpokt !== null || row.payouts.length) fail('unknown payout contains an amount');
    timeById.set(row.id,+new Date(row.endedAt));
    ids.add(row.id); claims += row.indexedClaimCount; byService.get(row.serviceId).push(row);
  }
  const sortedSessions=wire.sessions.slice().sort((a,b)=>timeById.get(a.id)-timeById.get(b.id)||a.id.localeCompare(b.id));
  for (const coverage of [wire.coverage, receipt.coverage]) {
    if (!coverage || coverage.indexedClaims !== claims || coverage.indexedSettledSessions !== ids.size ||
        coverage.verifiedDistributionSessions !== verified || coverage.verifiedDistributionClaims !== verifiedClaims ||
        coverage.unknownDistributionClaims !== claims-verifiedClaims) fail('receipt totals');
  }
  const fleetById = new Map(sampled.fleets.map(f => [f.id,f]));
  const domainMatch = (host, domain) => host === domain || host.endsWith(`.${domain}`);
  const matches = (member, scope) => {
    if (scope.fleetId && member.ownerId !== fleetById.get(scope.fleetId)?.ownerAddress) return false;
    if (scope.type === 'network') return scope.value === sampled.networkScopeValue;
    if (scope.type === 'owner') return member.ownerId === scope.value;
    if (scope.type === 'fleet') return member.ownerId === fleetById.get(scope.value)?.ownerAddress;
    if (scope.type === 'supplier') return member.supplierId === scope.value;
    if (scope.type === 'hostname') return member.hosts.includes(scope.value);
    if (scope.type === 'domain') return member.hosts.some(host => domainMatch(host,scope.value));
    return false;
  };
  const filtersFor = query => query.filters ?? (query.filter ? [query.filter] : []);
  const serviceIdsFor = query => [...new Set(query.serviceIds ?? [query.serviceId])].filter(Boolean).sort();
  const periodFor = query => ({start:new Date(Math.max(+new Date(sampled.period.start),
    +new Date(sampled.period.endExclusive) - (['7','14','30'].includes(String(query.period)) ? +query.period : 30)*86400000)).toISOString(),
    endExclusive:sampled.period.endExclusive});
  const week = date => String(Math.floor((+new Date(`${date}T00:00:00Z`) - +new Date(sampled.period.start))/604800000));
  const maskCache = new Map(), frameCache = new Map();
  const identityDimensions = ['supplier','owner','fleet','hostname','domain','infrastructure'];
  function maskFor(query) {
    const filters = filtersFor(query).filter(f => identityDimensions.includes(f.dimension));
    const key = JSON.stringify([query.scope,filters]);
    if (maskCache.has(key)) return maskCache.get(key);
    const mask = members.map(m => matches(m, query.scope) && filters.every(f =>
      f.dimension !== 'infrastructure' && matches(m,{type:f.dimension,value:f.value})));
    if (maskCache.size >= 16) maskCache.delete(maskCache.keys().next().value);
    maskCache.set(key,mask); return mask;
  }
  const sessionMatches = (frame, filter) => {
    if (filter.dimension === 'service') return frame.serviceId === filter.value;
    if (filter.dimension === 'application') return frame.applicationId === filter.value;
    if (filter.dimension === 'gateway') return filter.value === 'unknown';
    if (filter.dimension === 'week') return week(frame.date) === filter.value;
    if (filter.dimension === 'hour') return String(Math.floor(new Date(frame.startedAt).getUTCHours()/6)*6) === filter.value;
    if (filter.dimension === 'selected_count') return (frame.X <= 2 ? String(frame.X) : frame.X <= 5 ? '3–5' : '6+') === filter.value;
    if (filter.dimension === 'session_value') return frame.pool !== null && (frame.pool < 250 ? 'low' : frame.pool <= 500 ? 'medium' : 'high') === filter.value;
    return true;
  };
  const networkFrames=new Map();
  function framesFor(query) {
    const key = JSON.stringify([query.scope,serviceIdsFor(query),String(query.period ?? '30'),filtersFor(query)]);
    if (frameCache.has(key)) return frameCache.get(key);
    const period = periodFor(query), mask = maskFor(query), filters = filtersFor(query), frames = [];
    const wholeNetwork=query.scope.type==='network'&&query.scope.value===sampled.networkScopeValue&&!query.scope.fleetId&&
      !filters.some(f=>identityDimensions.includes(f.dimension));
    const selectedServices=new Set(serviceIdsFor(query)),start=+new Date(period.start),end=+new Date(period.endExclusive);
    for (const row of sortedSessions) {
      const time=timeById.get(row.id);
      if(!selectedServices.has(row.serviceId)||time<start||time>=end)continue;
      if(wholeNetwork&&networkFrames.has(row.id)){
        const frame=networkFrames.get(row.id);if(filters.every(f=>sessionMatches(frame,f)))frames.push(frame);continue;
      }
      const own = row.members.filter(i => mask[i]), supplierIndices = new Set(own.map(i => members[i].supplierIndex));
      const ready = row.payoutStatus === 'verified', pool = ready ? Number(row.poolUpokt) : null;
      const frame = {sessionId:row.id,serviceId:row.serviceId,applicationId:row.applicationId,gatewayId:null,
        date:row.endedAt.slice(0,10),startedAt:row.endedAt,sessionEndHeight:row.sessionEndHeight,populationId:null,N:null,n:null,
        K:row.selectedCount,X:own.length,selectionReady:true,comparisonReady:ready,rosterStatus:'complete',
        payoutStatus:ready?'complete':'missing',pool:ready?pool/1e6:null,
        actual:ready?row.payouts.reduce((n,p) => n+(supplierIndices.has(p[0])?Number(p[1]):0),0)/1e6:null,
        reference:ready?pool*own.length/row.selectedCount/1e6:null,availableAt:row.outcomeAvailableAt,
        indexedClaimCount:row.indexedClaimCount,evidenceUniverse:'indexed-settled-sessions'};
      if(wholeNetwork)networkFrames.set(row.id,frame);
      if (filters.every(f => sessionMatches(frame,f))) frames.push(frame);
    }
    if (frameCache.size >= 8) frameCache.delete(frameCache.keys().next().value);
    frameCache.set(key,frames); return frames;
  }
  const rawById = new Map(wire.sessions.map(s => [s.id,s]));
  function groupDefinitions(query, dimension) {
    if (!['owner','fleet','supplier','hostname','domain','application'].includes(dimension)) return null;
    const entries = new Map(), mask = maskFor(query);
    const add = (value,label=value) => { if(value) entries.set(value,{value,label}); };
    for (const frame of framesFor(query)) {
      const row = rawById.get(frame.sessionId);
      if (dimension === 'application') add(row.applicationId);
      else for (const index of row.members) if (mask[index]) {
        const m = members[index];
        if (dimension === 'owner') add(m.ownerId);
        if (dimension === 'fleet') add(`owner:${m.ownerId}`,fleetById.get(`owner:${m.ownerId}`)?.name ?? m.ownerId);
        if (dimension === 'supplier') add(m.supplierId,supplierById.get(m.supplierId)?.name ?? m.supplierId);
        if (dimension === 'hostname') m.hosts.forEach(host => add(host));
        if (dimension === 'domain') m.endpoints.forEach(e => add(e.registrableDomain));
      }
    }
    // Applications without indexed settlements remain inspectable; they are not zeros.
    if (dimension === 'application') {
      const period = periodFor(query), services = new Set(serviceIdsFor(query));
      for (const row of sampled.sessions) if (services.has(row.serviceId) && +new Date(row.startedAt) >= +new Date(period.start) &&
          +new Date(row.startedAt) < +new Date(period.endExclusive)) add(row.applicationId);
    }
    return [...entries.values()].sort((a,b) => a.value.localeCompare(b.value));
  }
  const groupRewardCache=new Map();
  function groupRewards(query,dimension) {
    if(!['owner','fleet','supplier','hostname','domain'].includes(dimension)||filtersFor(query).some(f=>f.dimension==='selected_count'))return null;
    const key=JSON.stringify([query,dimension]);
    if(groupRewardCache.has(key))return groupRewardCache.get(key);
    const frames=framesFor(query),mask=maskFor(query),commonDates=new Map(),groups=new Map();
    let comparable=0;
    for(const frame of frames) {
      if(frame.comparisonReady){comparable++;commonDates.set(frame.date,(commonDates.get(frame.date)??0)+1);}
      const row=rawById.get(frame.sessionId),selected=new Map(),payouts=new Map(row.payouts.map(([id,value])=>[id,Number(value)]));
      for(const index of row.members)if(mask[index]) {
        const member=members[index];
        const labels=dimension==='supplier'?[member.supplierId]:dimension==='owner'?[member.ownerId]:dimension==='fleet'?[`owner:${member.ownerId}`]:
          dimension==='hostname'?[...new Set(member.hosts)]:[...new Set(member.endpoints.map(e=>e.registrableDomain).filter(Boolean))];
        for(const label of labels){if(!selected.has(label))selected.set(label,new Set());selected.get(label).add(member.supplierIndex);}
      }
      for(const [label,own] of selected) {
        if(!groups.has(label))groups.set(label,{days:new Map(),actual:0,reference:0});
        if(!frame.comparisonReady)continue;
        const group=groups.get(label);
        if(!group.days.has(frame.date))group.days.set(frame.date,{date:frame.date,actual:0,reference:0,positiveSessions:0});
        const day=group.days.get(frame.date),actual=[...own].reduce((n,id)=>n+(payouts.get(id)??0),0)/1e6,
          reference=Number(row.poolUpokt)*own.size/row.selectedCount/1e6;
        day.actual+=actual;day.reference+=reference;group.actual+=actual;group.reference+=reference;
        if(reference>0)day.positiveSessions++;
      }
    }
    const dates=[...commonDates.keys()].sort(),result=new Map();
    for(const [label,group] of groups)result.set(label,{daily:dates.map(date=>({...group.days.get(date)??{date,actual:0,reference:0,positiveSessions:0},sessions:commonDates.get(date)})),
      recordedSessions:frames.length,comparableSessions:comparable,totals:{actual:group.actual,reference:group.reference}});
    if(groupRewardCache.size>=2)groupRewardCache.delete(groupRewardCache.keys().next().value);
    groupRewardCache.set(key,result);return result;
  }
  const endpointCache = new Map();
  function endpointsFor(supplierId, query) {
    const key = JSON.stringify(query);
    if (!endpointCache.has(key)) {
      const grouped = new Map(), mask=maskFor(query);
      for (const frame of framesFor(query)) for (const index of rawById.get(frame.sessionId).members) {
        if(!mask[index])continue;
        const m = members[index];
        if (!grouped.has(index)) grouped.set(index,{supplierId:m.supplierId,start:frame.startedAt,end:null,lastObservedAt:frame.startedAt,
          firstObservedHeight:frame.sessionEndHeight,lastObservedHeight:frame.sessionEndHeight,observedSessions:0,
          sourceKind:'settled-session-roster',ownerId:m.ownerId,endpoints:m.endpoints});
        const g = grouped.get(index); g.observedSessions++; g.lastObservedAt=frame.startedAt; g.lastObservedHeight=frame.sessionEndHeight;
      }
      const bySupplier=new Map();
      for(const group of grouped.values()) {
        if(!bySupplier.has(group.supplierId))bySupplier.set(group.supplierId,[]);
        bySupplier.get(group.supplierId).push(group);
      }
      if(endpointCache.size>=2)endpointCache.delete(endpointCache.keys().next().value);
      endpointCache.set(key,bySupplier);
    }
    return endpointCache.get(key).get(supplierId)??[];
  }
  const info = {kind:'indexed-settled-sessions',sessions:ids.size,claims,verifiedSessions:verified,
    snapshotId:`${sampled.snapshotId}-settled-${receipt.artifactSha256?.slice(0,16)??'proof'}`,
    period:{start:config.start,endExclusive:config.endExclusive,timezone:'UTC'},services:config.services,
    notice:wire.notice,receipt};
  return {info,framesFor,groupDefinitions,groupRewards,endpointsFor,
    candidateIds(scope) {return [...new Set(members.filter(m=>m.serviceIds.size&&matches(m,scope)).map(m=>m.supplierId))];},
    servicesForScope(scope) {return [...new Set(members.filter(m=>m.serviceIds.size&&matches(m,scope)).flatMap(m=>[...m.serviceIds]))];},
    domainAssociations() {return members.filter(m=>m.serviceIds.size).flatMap(m=>m.endpoints.filter(e=>e.registrableDomain)
      .map(e=>({supplierId:m.supplierId,ownerId:m.ownerId,serviceId:e.serviceId,hostname:e.hostname,domain:e.registrableDomain})));},
    exportEvidence(query) {return {...wire,sessions:framesFor(query).map(frame => rawById.get(frame.sessionId)),
      exportNotice:'Session records filtered to this view. Catalogs and collection receipt totals describe the whole saved collection.',receipt};}};
}
