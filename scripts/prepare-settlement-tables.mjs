import {readFile,writeFile} from 'node:fs/promises';
import {gunzipSync,gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {summariseRewardDaily} from '../src/engine.js';
import {stringSeed} from '../src/math.js';

/** Precompute identity tables once, rather than scanning the month on each click. */
export function prepareSettlementTables(sampled,wire,packedSha256) {
  const endpoints=wire.endpointCatalog,members=wire.membershipCatalog;
  const labels=members.map(([supplier,owner,ids])=>({supplier,owner:wire.ownerIds[owner],
    domains:[...new Set(ids.map(i=>endpoints[i].registrableDomain).filter(Boolean))]}));
  const services=new Map(wire.config.services.map(id=>[id,{counts:new Map(),owner:new Map(),domain:new Map()}]));
  for(const session of wire.sessions) {
    if(session.payoutStatus!=='verified')throw new Error('Cannot precompute an unverified monthly earnings table.');
    const service=services.get(session.serviceId),date=session.endedAt.slice(0,10);
    service.counts.set(date,(service.counts.get(date)??0)+1);
    const payouts=new Map(session.payouts.map(([i,v])=>[i,Number(v)])),pool=Number(session.poolUpokt);
    for(const dimension of ['owner','domain']) {
      const selected=new Map();
      for(const i of session.members) {
        const member=labels[i],keys=dimension==='owner'?[member.owner]:member.domains;
        for(const key of keys) {
          if(!selected.has(key))selected.set(key,[]);
          selected.get(key).push(member);
        }
      }
      for(const [key,roster] of selected) {
        if(!service[dimension].has(key))service[dimension].set(key,{days:new Map(),suppliersByDate:new Map(),ownersByDate:new Map()});
        const group=service[dimension].get(key);
        if(!group.days.has(date))group.days.set(date,{date,actual:0,reference:0,positiveSessions:0});
        const day=group.days.get(date);
        day.actual+=roster.reduce((n,m)=>n+(payouts.get(m.supplier)??0),0)/1e6;
        day.reference+=pool*roster.length/session.selectedCount/1e6;
        if(pool>0)day.positiveSessions++;
        if(!group.suppliersByDate.has(date)){group.suppliersByDate.set(date,new Set());group.ownersByDate.set(date,new Set());}
        roster.forEach(m=>{group.suppliersByDate.get(date).add(m.supplier);group.ownersByDate.get(date).add(m.owner);});
      }
    }
  }
  const periods={};
  for(const period of ['7','14','30']) {
    periods[period]={};
    const start=new Date(Math.max(+new Date(sampled.period.start),+new Date(sampled.period.endExclusive)-Number(period)*86400000)).toISOString().slice(0,10);
    for(const [serviceId,service] of services) {
      periods[period][serviceId]={};
      const dates=[...service.counts.keys()].filter(date=>date>=start).sort();
      const recorded=dates.reduce((n,date)=>n+service.counts.get(date),0);
      for(const dimension of ['owner','domain']) {
        const old=(dimension==='domain'?sampled.liveSource.domainLeaderboards:sampled.liveSource.leaderboards)?.[period]?.[serviceId]??[];
        const oldById=new Map(old.map(row=>[row.domain??row.ownerAddress,row]));
        const rows=[];
        for(const [key,group] of service[dimension]) {
          const selected=new Set(dates.flatMap(date=>[...(group.suppliersByDate.get(date)??[])]));
          if(!selected.size)continue;
          const owners=new Set(dates.flatMap(date=>[...(group.ownersByDate.get(date)??[])]));
          const daily=dates.map(date=>({...group.days.get(date)??{date,actual:0,reference:0,positiveSessions:0},sessions:service.counts.get(date)}));
          const scope={type:dimension,value:key};
          const analysisKey=JSON.stringify({scope,services:[serviceId],period,filters:[]});
          const summary=summariseRewardDaily(daily,recorded,recorded,stringSeed(analysisKey));
          const previous=oldById.get(key);
          rows.push({...previous,...(dimension==='domain'?{domain:key}:{ownerAddress:key}),scope,
            name:previous?.name??key,eligibleSuppliers:previous?.eligibleSuppliers??0,
            selectedSuppliers:selected.size,ownerCount:owners.size,...summary,earningsUniverse:'indexed-settled-sessions'});
        }
        periods[period][serviceId][dimension]=rows.sort((a,b)=>(a.domain??a.ownerAddress).localeCompare(b.domain??b.ownerAddress));
      }
    }
  }
  return {version:1,cutoff:wire.config.cutoff,claims:wire.coverage.indexedClaims,sessions:wire.sessions.length,
    packedSha256,periods,notice:'Precomputed recorded settlement comparisons. Eligible counts retain their separately dated selection sample reference.'};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const root=fileURLToPath(new URL('../',import.meta.url));
  const sample=JSON.parse(gunzipSync(await readFile(resolve(root,'data/live-snapshot.json.gz'))));
  const packed=await readFile(resolve(root,'data/settlement-month.json.gz'));
  const wire=JSON.parse(gunzipSync(packed));
  const tables=prepareSettlementTables(sample,wire,createHash('sha256').update(packed).digest('hex'));
  const output=resolve(root,'data/settlement-tables.json.gz');
  await writeFile(output,gzipSync(JSON.stringify(tables)));
  console.log(`Prepared settlement comparisons: ${output}`);
}
