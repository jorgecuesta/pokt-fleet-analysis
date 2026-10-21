import {readFile,writeFile,mkdir,readdir,unlink} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join,dirname} from 'node:path';
import {Script} from 'node:vm';
import {gunzipSync,gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {createLiveAdapter} from '../src/adapter.js';
import {prepareSettlementTables} from './prepare-settlement-tables.mjs';

const root=dirname(dirname(fileURLToPath(import.meta.url)));
const read=path=>readFile(join(root,path),'utf8');
const optional=async path=>{try{return await readFile(join(root,path));}catch(error){if(error.code!=='ENOENT')throw error;return null;}};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const jsonCode=value=>JSON.stringify(value).replace(/</g,'\\u003c');
const [template,styles,raw,logo,font,fontLicense,loader,...modules]=await Promise.all([
  read('src/index.html'),read('src/styles.css'),read('data/fictional-snapshot.json'),
  readFile(join(root,'src/assets/fleet-mark.svg')),readFile(join(root,'src/assets/rubik-latin-variable.woff2')),read('src/assets/RUBIK-OFL.txt'),
  read('src/snapshot-loader.js'),...['math','settlements','engine','adapter','export-download','app'].map(name=>read(`src/${name}.js`))
]);
const fixture=JSON.parse(raw);
if(fixture.dataKind!=='illustrative')throw new Error('The preview requires explicitly fictional data.');
let liveBytes=await optional('data/live-snapshot.json.gz'),monthlyCheck=null,live=null;
if(liveBytes){
  const checked=await optional('data/monthly-claims-diagnostic.json');
  monthlyCheck=checked?JSON.parse(checked):null;
  if(monthlyCheck&&monthlyCheck.productSha256!==sha(liveBytes))throw new Error('Monthly diagnostic source checksum differs.');
  live=JSON.parse(gunzipSync(liveBytes));
  createLiveAdapter(structuredClone(live),monthlyCheck);
}
const [settlementBytes,receiptBytes,integrationBytes]=await Promise.all([
  optional('data/settlement-month.json.gz'),optional('data/settlement-month-receipt.json'),optional('data/settlement-integration.json')
]);
let receipt=null,settlementTables=null,asset=null;
if(settlementBytes||receiptBytes||integrationBytes){
  if(!settlementBytes||!receiptBytes||!integrationBytes||!live)throw new Error('The separate monthly settlement installation is incomplete.');
  const integration=JSON.parse(integrationBytes),wire=JSON.parse(gunzipSync(settlementBytes));receipt=JSON.parse(receiptBytes);
  const digest=sha(settlementBytes),end=live.period.endExclusive;
  if(integration.monthlyActivationReady!==true||integration.packedSha256!==digest||integration.canonicalSha256!==receipt.artifactSha256||
    integration.originalSampleSha256!==sha(liveBytes)||integration.claims!==monthlyCheck?.summary.monthlyClaimRecords||
    wire.config.start!==live.period.start||wire.config.endExclusive!==end||
    +new Date(end)-+new Date(wire.config.start)!==30*86400000||wire.config.services.length!==live.services.length||
    live.services.some(s=>!wire.config.services.includes(s.id))||receipt.coverage.unknownDistributionClaims!==0)
    throw new Error('Only a verified complete 30-day, eight-service settlement installation can be built.');
  createLiveAdapter(structuredClone(live),monthlyCheck,wire,receipt);
  const tables=prepareSettlementTables(live,wire,digest);
  settlementTables=gzipSync(JSON.stringify(tables));
  await writeFile(join(root,'data/settlement-tables.json.gz'),settlementTables);
  asset={filename:`settlements-${digest.slice(0,16)}.bin`,sha256:digest};
  if(settlementBytes.length>24*1048576)throw new Error('Saved settlement asset exceeds the safe 24 MiB file budget.');
}
let proof=null;
const proofBytes=await optional('data/settlement-pilot/integration-proof.json');
const pairBytes=await optional('data/settlement-pilot/paired-investigation.json');
if(proofBytes&&pairBytes){
  const checked=JSON.parse(proofBytes),paired=JSON.parse(pairBytes);
  if(checked.status!=='verified'||checked.monthlyActivationReady!==false||paired.technicalStatus!=='passed'||!paired.safeToCollectIndexedSettlements||
    paired.checks.some(c=>!c.control.passed||c.control.absentOnChain.length||c.control.distributionDifferences.length))throw new Error('Pilot source investigation has not passed.');
  proof={period:{start:checked.sourceWindow.start,endExclusive:checked.sourceWindow.endExclusive},claims:checked.claims,sessions:checked.sessions,
    sampledCountsChecked:checked.sampledCountsChecked,coveredOverlaps:checked.coveredOverlapsReconciled,
    onChainClaims:paired.checks.reduce((n,c)=>n+c.control.indexedClaimsChecked,0),wholeGroupCauseEstablished:paired.wholeGroupCauseEstablished};
}
if(live){
  const index=new Map(live.suppliers.map((s,i)=>[s.id,i]));
  if(live.wireCodec!=='supplier-indices-v1')for(const p of live.populations){
    p.eligibleSupplierIndices=p.eligibleSupplierIds.map(id=>{const i=index.get(id);if(i===undefined)throw new Error('Unmapped eligible Supplier');return i;});delete p.eligibleSupplierIds;
  }
  live.wireCodec='supplier-indices-v1';liveBytes=gzipSync(JSON.stringify(live));
}
const css=styles.replace('__RUBIK_DATA__',`data:font/woff2;base64,${font.toString('base64')}`)+`\n/* Embedded Rubik font license:\n${fontLicense}\n*/`;
const bootstrap=liveBytes?`const requested=new URLSearchParams(location.search).get('dataset');const preview=requested==='preview'||(!requested&&new URLSearchParams(location.hash.slice(1)).get('snapshot')?.startsWith('illustrative-'));const SNAPSHOT_DATA=await decodeSnapshot(preview?'fictional-snapshot':'live-snapshot');`:`const preview=true;const SNAPSHOT_DATA=await decodeSnapshot('fictional-snapshot');`;
const code=`(async()=>{'use strict';\n${loader.replace(/^export /gm,'')}\nconst MONTHLY_CLAIM_CHECK=${jsonCode(monthlyCheck)};\nconst SETTLEMENT_RECEIPT=${jsonCode(receipt)};\nconst SETTLEMENT_PROOF=${jsonCode(proof)};\n${bootstrap}\nconst SAVED_SETTLEMENT_ASSET=${jsonCode(asset)};\nconst SETTLEMENT_DATA=!preview&&SAVED_SETTLEMENT_ASSET?await loadSavedSettlements(SAVED_SETTLEMENT_ASSET.filename,SAVED_SETTLEMENT_ASSET.sha256):null;\nconst SETTLEMENT_TABLES=!preview&&SAVED_SETTLEMENT_ASSET?await decodeSnapshot('settlement-tables'):null;\n${modules.map(source=>source.replace(/^import .*;\s*$/gm,'').replace(/^export /gm,'')).join('\n')}\n})().catch(error=>{document.getElementById('app').textContent='Could not open this snapshot. '+error.message;});`.replaceAll('__FLEET_MARK__',`data:image/svg+xml;base64,${logo.toString('base64')}`);
new Script(code,{filename:'fleet-analysis-bundle.js'});
if(/<\/script/i.test(code))throw new Error('Unsafe script terminator in the bundle.');
const html=template.replaceAll('__FLEET_MARK__',`data:image/svg+xml;base64,${logo.toString('base64')}`).replace('/* INLINE_STYLES */',()=>css).replace('/* INLINE_DATA */',()=>JSON.stringify(gzipSync(JSON.stringify(fixture)).toString('base64')))
  .replace('/* INLINE_LIVE_DATA */',()=>JSON.stringify(liveBytes?.toString('base64')??null))
  .replace('/* INLINE_SETTLEMENT_TABLES */',()=>JSON.stringify(settlementTables?.toString('base64')??null)).replace('/* INLINE_APPLICATION */',()=>code);
if(Buffer.byteLength(html)>24*1048576)throw new Error('Static HTML exceeds the safe 24 MiB file budget.');
if(/__RUBIK_DATA__|__FLEET_MARK__/.test(html))throw new Error('Unresolved brand asset.');
await mkdir(join(root,'dist'),{recursive:true});
// Remove only obsolete generated settlement assets, preventing stale deployment bytes.
for(const name of await readdir(join(root,'dist')))if(/^settlements-[a-f0-9]{16}\.bin$/.test(name)&&name!==asset?.filename)await unlink(join(root,'dist',name));
if(asset)await writeFile(join(root,'dist',asset.filename),settlementBytes);
await writeFile(join(root,'dist/index.html'),html);
await writeFile(join(root,'dist/robots.txt'),'User-agent: *\nDisallow: /\n');
console.log(`Built dist/index.html (${(Buffer.byteLength(html)/1048576).toFixed(2)} MiB). ${asset?'Monthly settlement asset and separate sampled selection.':'Original sampled mainnet snapshot; monthly settlement activation pending.'} Fictional preview retained. No Pocket API requests.`);
