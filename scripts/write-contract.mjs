import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createIllustrativeAdapter} from '../src/adapter.js';
const data=JSON.parse(await readFile(new URL('../data/fictional-snapshot.json',import.meta.url),'utf8'));
const output=new URL('../docs/',import.meta.url);await mkdir(output,{recursive:true});
const string={type:'string'},nullableString={type:['string','null']},count={type:'integer',minimum:0},number={type:'number'},nonnegative={type:'number',minimum:0},nullableNumber={type:['number','null']},nullableNonnegative={type:['number','null'],minimum:0},fraction={type:['number','null'],minimum:0,maximum:1},boolean={type:'boolean'};
const object=(properties,optional=[])=>({type:'object',required:Object.keys(properties).filter(key=>!optional.includes(key)),properties});
const array=items=>({type:'array',items});
const ref=name=>({$ref:`#/$defs/${name}`});
const dimensions=['infrastructure','service','fleet','hostname','domain','owner','supplier','gateway','application','week','hour','selected_count','session_value'];
const scopeTypes=['fleet','supplier','owner','hostname','domain','network'];
const scope=object({type:{enum:scopeTypes},value:string,fleetId:string},['fleetId']);
const filter=object({dimension:{enum:dimensions},value:string});
const rewards=object({
  availability:{enum:['available','limited','partial','unavailable']},reason:nullableString,
  actualPokt:nullableNonnegative,equalSharePokt:nullableNonnegative,ratio:nullableNonnegative,
  differencePercent:{type:['number','null'],minimum:-100},intervalRatio:ref('interval'),intervalDifferencePercent:ref('interval'),
  direction:{enum:['above','below','no_clear_difference','not_assessed']},informativeDays:count,positiveSessions:count,
  comparableSessions:count,recordedSessions:count,coverage:{type:'number',minimum:0,maximum:1},largestDayShare:fraction,
  daily:array(object({date:{type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}$'},actual:nonnegative,reference:nonnegative,sessions:count,positiveSessions:count})),
  bootstrap:object({definedDraws:count,repetitions:{type:'integer',minimum:1}})
});
const service=object({id:string,name:string,shortName:string});
const exposure=object({availability:{enum:['available','unavailable']},reason:nullableString,recordedSessions:count,verifiedSessions:count,presentSessions:count,presenceFraction:fraction,meanSelected:nullableNonnegative,expectedPresenceFraction:fraction,expectedMeanSelected:nullableNonnegative,eligibleRange:ref('interval'),missingRosters:count,selectedPositions:count});
const scenario=object({observedAt:string,totalEligible:count,ownEligible:count,selectionCap:{type:'integer',minimum:1},populationId:string,assumption:string});
const schema={
  $schema:'https://json-schema.org/draft/2020-12/schema',
  title:'POKT fleet analysis product report v1',
  description:'Product model shape. Financial units are POKT. Semantic invariants are documented in product-contract.md.',
  ...object({
    schemaVersion:{const:1},dataKind:{enum:['illustrative','live']},snapshotId:string,generatedAt:string,
    query:object({scope:ref('queryScope'),serviceId:string,serviceIds:{...array(string),minItems:1,uniqueItems:true},period:{enum:['7','14','30']},filters:array(ref('filter'))},['serviceId']),
    scope:object({type:{enum:scopeTypes},value:string,label:string,fleetId:nullableString,fleetNames:array(string),supplierCount:count,identityCount:count,latestEligibleCount:{type:['integer','null'],minimum:0},membershipRule:string,fictional:boolean,filters:array(ref('filter')),sampleNotice:nullableString}),
    service,services:{...array(service),minItems:1},
    period:object({start:string,endExclusive:string,timezone:{const:'UTC'},requestedDays:{type:'integer',minimum:1}}),
    rewards:ref('rewards'),
    exposure:ref('exposure'),
    scenarioReference:{anyOf:[ref('scenarioReference'),{type:'null'}]},
    scenarioReferences:array(object({...scenario.properties,serviceId:string,serviceName:string})),
    perService:array(object({...rewards.properties,id:string,label:string,exposure:ref('exposure')})),
    trend:object({points:array({...rewards,required:[...rewards.required,'id','label'],properties:{...rewards.properties,id:string,label:string}}),variable:boolean,earlierRatio:nullableNonnegative,laterRatio:nullableNonnegative}),
    evidence:object({recordedSessions:count,verifiedRosters:count,comparableOutcomes:count,missingOutcomes:count,pendingOutcomes:count,zeroPoolSessions:count,informativeDays:count,positiveOpportunities:count,largestDayShare:fraction,membershipRule:string,sourceNotice:string,sampling:string,thresholdNotice:string,limitations:array(string)})
  }),
  $defs:{queryScope:scope,filter,rewards,exposure,
    interval:{type:['array','null'],minItems:2,maxItems:2,items:number},
    scenarioReference:scenario}
};
await writeFile(new URL('product-report.schema.json',output),JSON.stringify(schema,null,2)+'\n');
const adapter=createIllustrativeAdapter(data);
const exampleScope={type:'fleet',value:'alder'};
const example=adapter.getReport({scope:exampleScope,serviceIds:adapter.servicesFor(exampleScope).map(service=>service.id),period:'30',filters:[]});
await writeFile(new URL('example-report.json',output),JSON.stringify(example,null,2)+'\n');
console.log('Wrote machine-readable contract and an actual illustrative report.');
