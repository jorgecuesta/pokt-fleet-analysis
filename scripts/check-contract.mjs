import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createIllustrativeAdapter,createLiveAdapter} from '../src/adapter.js';
import {gunzipSync} from 'node:zlib';
const [schema,data]=await Promise.all(['../docs/product-report.schema.json','../data/fictional-snapshot.json'].map(async file=>JSON.parse(await readFile(new URL(file,import.meta.url),'utf8'))));

// Validate the subset of JSON Schema used by this dependency-free contract.
function validate(value,rule,path='$') {
  if(rule.$ref)return validate(value,schema.$defs[rule.$ref.split('/').at(-1)],path);
  if(rule.anyOf){assert(rule.anyOf.some(option=>{try{validate(value,option,path);return true;}catch{return false;}}),`${path} does not match any allowed shape`);return;}
  if(rule.const!==undefined)assert.equal(value,rule.const,path);
  if(rule.enum)assert(rule.enum.includes(value),`${path}: unexpected enum value`);
  if(rule.type){
    const types=Array.isArray(rule.type)?rule.type:[rule.type];
    assert(types.some(type=>type==='null'?value===null:type==='array'?Array.isArray(value):type==='integer'?Number.isInteger(value):type==='object'?value!==null&&typeof value==='object'&&!Array.isArray(value):typeof value===type),`${path}: unexpected value type`);
  }
  if(value===null)return;
  if(typeof value==='number'){assert(Number.isFinite(value),path);if(rule.minimum!==undefined)assert(value>=rule.minimum,path);if(rule.maximum!==undefined)assert(value<=rule.maximum,path);}
  if(typeof value==='string'&&rule.pattern)assert(new RegExp(rule.pattern).test(value),path);
  if(Array.isArray(value)){
    if(rule.minItems!==undefined)assert(value.length>=rule.minItems,path);
    if(rule.maxItems!==undefined)assert(value.length<=rule.maxItems,path);
    if(rule.uniqueItems)assert.equal(new Set(value.map(item=>JSON.stringify(item))).size,value.length,path);
    if(rule.items)value.forEach((item,index)=>validate(item,rule.items,`${path}[${index}]`));
  } else if(typeof value==='object') {
    for(const key of rule.required??[])assert(Object.hasOwn(value,key),`${path}.${key} is required`);
    for(const [key,child] of Object.entries(rule.properties??{}))if(Object.hasOwn(value,key))validate(value[key],child,`${path}.${key}`);
  }
}

const adapter=createIllustrativeAdapter(data);let reports=0;
for(const fleet of adapter.directory())for(const service of adapter.servicesFor(fleet.scope))for(const period of ['7','14','30']) {
  validate(adapter.getReport({scope:fleet.scope,serviceId:service.id,period,filters:[]} ),schema);reports++;
}
for(const fleet of adapter.directory())for(const period of ['7','14','30']) {
  validate(adapter.getReport({scope:fleet.scope,serviceIds:adapter.servicesFor(fleet.scope).map(s=>s.id),period,filters:[]}),schema);reports++;
}
validate(adapter.getReport({scope:{type:'network',value:'illustrative-sample'},serviceIds:data.services.map(s=>s.id),period:'30',filters:[]}),schema);reports++;
for(const match of adapter.search('relay.shared.example'))validate(adapter.getReport({scope:match.scope,serviceId:match.primaryService,period:'30',filters:[]}),schema);
const sample=JSON.parse(await readFile(new URL('../docs/example-report.json',import.meta.url),'utf8'));
validate(sample,schema);
const malformed=structuredClone(sample);delete malformed.rewards.actualPokt;assert.throws(()=>validate(malformed,schema));
console.log(`${reports+4} generated/example reports satisfy the product schema; a missing required amount is rejected.`);
const live=JSON.parse(gunzipSync(await readFile(new URL('../data/live-snapshot.json.gz',import.meta.url))));
const liveAdapter=createLiveAdapter(live);
let liveReports=0;
for(const service of live.services){
  validate(liveAdapter.getReport({scope:{type:'network',value:live.networkScopeValue},serviceId:service.id,period:'30',filters:[]}),schema);liveReports++;
  const owner=liveAdapter.leaderboard(service.id)[0];
  if(owner){validate(liveAdapter.getReport({scope:{type:'fleet',value:owner.fleetId},serviceId:service.id,period:'30',filters:[]}),schema);liveReports++;}
  const domain=liveAdapter.leaderboard(service.id,'30','domain')[0];
  if(domain){
    validate(liveAdapter.getReport({scope:domain.scope,serviceId:service.id,period:'30',filters:[]}),schema);liveReports++;
    validate(liveAdapter.getReport({scope:{type:'network',value:live.networkScopeValue},serviceId:service.id,period:'30',filters:[{dimension:'domain',value:domain.domain}]}),schema);liveReports++;
  }
}
validate(liveAdapter.getReport({scope:{type:'network',value:live.networkScopeValue},serviceIds:live.services.map(s=>s.id),period:'30',filters:[]}),schema);liveReports++;
console.log(`${liveReports} recorded mainnet reports satisfy the same product schema.`);
