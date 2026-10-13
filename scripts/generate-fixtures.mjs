import {writeFileSync, mkdirSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {seededRandom} from '../src/math.js';

// This creates fictional evidence. It makes no HTTP requests and reads no real data.
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const random = seededRandom(741030);
const normal = () => Math.sqrt(-2 * Math.log(Math.max(random(), 1e-12))) * Math.cos(2 * Math.PI * random());
const round = value => Math.round(value * 1e6) / 1e6;
const dateOf = day => `2026-09-${String(day + 1).padStart(2, '0')}`;
const dayAfter = (day, hour) => new Date(Date.UTC(2026, 8, day + 2, hour)).toISOString();

const serviceNames = [
  ['bsc', 'BNB Smart Chain', 'BSC'], ['eth', 'Ethereum', 'ETH'], ['base', 'Base', 'BASE'],
  ['polygon', 'Polygon', 'POL'], ['arbitrum', 'Arbitrum', 'ARB'], ['optimism', 'Optimism', 'OP'],
  ['avalanche', 'Avalanche', 'AVAX'], ['solana', 'Solana', 'SOL'], ['bitcoin', 'Bitcoin', 'BTC'],
  ['robinhood', 'Robinhood', 'RH'], ['gnosis', 'Gnosis', 'GNO'], ['scroll', 'Scroll', 'SCR'],
  ['linea', 'Linea', 'LIN'], ['blast', 'Blast', 'BLAST'], ['opbnb', 'opBNB', 'OPB'],
  ['pokt', 'Pocket', 'POKT'], ['fantom', 'Fantom', 'FTM'], ['demo_testnet', 'Demo Testnet', 'TEST']
];
const services = serviceNames.map(([id, name, shortName], index) => ({id, name, shortName, colour: ['#29776d','#586fc2','#657391','#895cad'][index % 4]}));
const fleetSpecs = [
  {id:'alder', name:'Alder Relay', count:48, primary:'bsc', services:['bsc','eth','base'], groups:['Europe','Americas'], note:'A clear earnings result', story:'Good coverage, consistent earnings, and two fleet groups.', level:1.28, tag:'Well covered'},
  {id:'moss', name:'Moss Relay', count:8, primary:'bsc', services:['bsc','base'], groups:['Main'], note:'A promising number, little evidence', story:'Recently eligible. Explore selection while earnings evidence builds.', level:1.85, tag:'Limited evidence'},
  {id:'juniper', name:'Juniper Relay', count:1, primary:'solana', services:['solana','demo_testnet'], groups:['Main'], note:'One Supplier, useful evidence', story:'See how a small fleet can still have informative observations.', level:1.06, tag:'One Supplier'},
  {id:'meridian', name:'Meridian Relay', count:84, primary:'bsc', services:['bsc','eth','base'], groups:['North','South','Hosted relay'], note:'The aggregate hides a weaker group', story:'Three fleet groups, two owners, and shared hosting.', level:1.08, tag:'Multiple groups'},
  {id:'prism', name:'Prism Relay', count:36, primary:'base', services:services.map(s=>s.id), groups:['Core','Edge'], note:'One fleet, many services', story:'Search eighteen services with different eligibility and evidence.', level:1.0, tag:'18 services'},
  {id:'tidal', name:'Tidal Relay', count:60, primary:'base', services:['bsc','base','eth'], groups:['West','East'], note:'Earnings changed during the month', story:'A period average conceals a substantial shift.', level:1.0, tag:'Changing earnings'},
  {id:'cairn', name:'Cairn Relay', count:44, primary:'robinhood', services:['bsc','robinhood'], groups:['Established','Expansion'], note:'A fleet that grew through the month', story:'Changing eligibility and owner history, with a dated scenario.', level:.92, tag:'Changing fleet'},
  {id:'copper', name:'Copper Relay', count:24, primary:'polygon', services:['polygon','base'], groups:['Main','Backup'], note:'Useful selections, partial outcomes', story:'Missing rosters and unfinished payouts remain distinct from zeros.', level:.8, tag:'Partial coverage'}
];
const fleets = fleetSpecs.map(({level, count, ...f}) => ({...f, exampleCount:count, description:f.story}));
const suppliers = [];
for (const fleet of fleetSpecs) {
  for (let i = 0; i < fleet.count; i++) {
    const groupIndex = Math.min(fleet.groups.length - 1, Math.floor(i * fleet.groups.length / fleet.count));
    const groupName = fleet.groups[groupIndex];
    const host = `${groupName.toLowerCase().replaceAll(' ', '-')}.${fleet.id}.example`;
    const hosts = [host];
    if ((fleet.id === 'alder' && i < 4) || (fleet.id === 'meridian' && groupIndex === 2)) hosts.push('relay.shared.example');
    const ownerIndex = fleet.id === 'meridian' ? (groupIndex === 1 ? 2 : 1) : fleet.id === 'cairn' ? (i < 22 ? 1 : 2) : 1;
    const ownerId = `demo:${fleet.id}:owner:${ownerIndex}`;
    const ownerHistory = [{ownerId, start:'2026-09-01', end:null}];
    if (fleet.id === 'cairn' && i < 11) ownerHistory.splice(0, 1,
      {ownerId:'demo:cairn:owner:1', start:'2026-09-01', end:'2026-09-16'},
      {ownerId:'demo:cairn:owner:2', start:'2026-09-16', end:null});
    const registeredServices = fleet.services.filter((serviceId, serviceIndex) => fleet.id !== 'prism' || i < (serviceId === 'demo_testnet' ? 12 : 12 + serviceIndex % 5 * 6));
    suppliers.push({id:`demo:${fleet.id}:supplier:${String(i+1).padStart(3,'0')}`, fleetId:fleet.id,
      name:`Supplier ${String(i+1).padStart(3,'0')}`, groupId:`${fleet.id}:${groupIndex}`, groupName,
      endpointHosts:hosts, endpointUrls:hosts.map(h=>`https://${h}/rpc`), ownerHistory, serviceIds:registeredServices,
      fictional:true});
  }
}
const gateways = [
  {id:'demo-gateway-north', name:'North Gateway'}, {id:'demo-gateway-mesh', name:'Mesh Gateway'},
  {id:'demo-gateway-transit', name:'Transit Gateway'}
];
const applications = gateways.flatMap((gateway,index)=>[0,1].map(i=>({id:`demo:application:${index+1}:${i+1}`, name:`${gateway.name.replace(' Gateway','')} App ${i+1}`, gatewayId:gateway.id})));
applications.push({id:'demo:application:unmapped',name:'Unmapped App',gatewayId:null});

function isEligible(supplier, serviceId, day) {
  if (!supplier.serviceIds.includes(serviceId)) return false;
  const index = Number(supplier.id.split(':').at(-1)) - 1;
  if (supplier.fleetId === 'moss' && day < 26) return false;
  if (supplier.fleetId === 'prism' && serviceId === 'gnosis') return false;
  if (supplier.fleetId === 'cairn') {
    const allowed = day < 15 ? 18 : Math.min(44, 20 + (day - 15) * 2);
    if (index >= allowed) return false;
  }
  return true;
}
function supplierWeight(supplier, serviceId, day, gatewayId, dailyNoise) {
  const fleet = fleetSpecs.find(f=>f.id===supplier.fleetId);
  let weight = fleet.level;
  if (fleet.id === 'meridian') weight = {'North':1.65,'South':.43,'Hosted relay':1.09}[supplier.groupName];
  if (fleet.id === 'tidal') weight = day < 15 ? 1.65 : .55;
  if (fleet.id === 'prism') weight = .82 + (services.findIndex(s=>s.id===serviceId) % 5) * .13;
  if (fleet.id === 'alder' && gatewayId === 'demo-gateway-transit') weight *= .88;
  if (fleet.id === 'meridian' && gatewayId === 'demo-gateway-mesh') weight *= .82;
  return weight * dailyNoise[fleet.id] * Math.exp(normal() * .13);
}
function drawPositions(total, count) {
  const positions = new Set();
  while (positions.size < count) positions.add(Math.floor(random() * total));
  return [...positions];
}
const populations = [];
const sessions = [];
for (let serviceIndex = 0; serviceIndex < services.length; serviceIndex++) {
  const service = services[serviceIndex];
  for (let day = 0; day < 30; day++) {
    const eligible = suppliers.filter(s=>isEligible(s, service.id, day));
    const totalEligible = service.id === 'demo_testnet' ? eligible.length : service.id === 'solana' ? 420 + day :
      service.id === 'robinhood' ? 1180 + day * 8 : 1280 + serviceIndex * 63 + day * 5;
    const selected = Math.min(50, totalEligible);
    const populationId = `${service.id}:${dateOf(day)}`;
    populations.push({id:populationId, serviceId:service.id, observedAt:`${dateOf(day)}T00:00:00.000Z`,
      totalEligible, selectionCap:50, eligibleSupplierIds:eligible.map(s=>s.id)});
    const dailyNoise = Object.fromEntries(fleetSpecs.map(f=>[f.id,Math.exp(normal() * .055)]));
    for (let timeIndex = 0; timeIndex < 8; timeIndex++) {
      const hour = timeIndex * 3;
      for (let appIndex = 0; appIndex < 2; appIndex++) {
        const application = applications[(timeIndex * 3 + appIndex + day) % applications.length];
        const roster = drawPositions(totalEligible, selected);
        const allWeights = roster.map(position => position < eligible.length ? supplierWeight(eligible[position],service.id,day,application.gatewayId,dailyNoise) : Math.exp(normal() * .17));
        const weightSum = allWeights.reduce((a,b)=>a+b,0);
        const hasZeroPool = (day * 32 + timeIndex * 4 + appIndex + serviceIndex) % 23 === 0;
        const totalPayout = hasZeroPool ? 0 : round((service.id === 'demo_testnet' ? 30 : 320 + serviceIndex * 15) * Math.exp(normal() * .4));
        const allPayouts = allWeights.map(weight=>round(totalPayout * weight / weightSum));
        if (allPayouts.length) allPayouts[0] = round(allPayouts[0] + totalPayout - allPayouts.reduce((a,b)=>a+b,0));
        const supplierPayouts = roster.flatMap((position,index)=>position < eligible.length ? [{supplierId:eligible[position].id,pokt:allPayouts[index]}] : []);
        const sequence = day * 32 + timeIndex * 4 + appIndex;
        const payoutStatus = service.id === 'polygon' && day >= 28 ? 'pending' : service.id === 'polygon' && sequence % 5 === 0 ? 'missing' : 'complete';
        const rosterStatus = service.id === 'polygon' && sequence % 17 === 0 ? 'missing' : 'complete';
        sessions.push({id:`demo:${service.id}:${dateOf(day)}:${hour}:${appIndex}`,serviceId:service.id,populationId,
          startedAt:`${dateOf(day)}T${String(hour).padStart(2,'0')}:${String(appIndex * 5).padStart(2,'0')}:00.000Z`,
          gatewayId:application.gatewayId, applicationId:application.id, selectedCount:selected,
          rosterStatus, selectedSupplierIds:rosterStatus==='complete'?supplierPayouts.map(p=>p.supplierId):null,
          payoutStatus, totalPayoutPokt:payoutStatus==='complete'?totalPayout:null,
          supplierPayouts:payoutStatus==='complete'?supplierPayouts:null,
          outcomeAvailableAt:payoutStatus==='complete'?dayAfter(day,hour):null});
      }
    }
  }
}
const snapshot = {schemaVersion:1, dataKind:'illustrative', snapshotId:'illustrative-september-2026-v1',
  generatedAt:'2026-10-02T00:00:00.000Z', period:{start:'2026-09-01T00:00:00.000Z',endExclusive:'2026-10-01T00:00:00.000Z',timezone:'UTC'},
  description:'All fleets, identities, Gateway relationships, eligibility and payouts are fictional.',
  sampling:'Controlled fictional session observations; not live POKT network evidence.', fleets, services, suppliers, gateways, applications, populations, sessions};
mkdirSync(resolve(project,'data'),{recursive:true});
writeFileSync(resolve(project,'data/fictional-snapshot.json'),JSON.stringify(snapshot));
console.log(JSON.stringify({fleets:fleets.length,services:services.length,suppliers:suppliers.length,sessions:sessions.length,bytes:Buffer.byteLength(JSON.stringify(snapshot))}));
