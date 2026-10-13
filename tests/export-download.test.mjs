import test from 'node:test';
import assert from 'node:assert/strict';
import {gunzipSync} from 'node:zlib';
import {resultDownloadBlob} from '../src/export-download.js';

test('compressed evidence downloads round-trip exact monetary strings and missing values',async()=>{
  const evidence={poolUpokt:'123456789123456789',unknown:null,sessions:Array.from({length:2000},(_,id)=>({id,amount:'7500000',membership:[1,2,3]}))};
  const blob=await resultDownloadBlob(evidence,true);
  assert.equal(blob.type,'application/gzip');assert(blob.size<JSON.stringify(evidence).length/4);
  assert.deepEqual(JSON.parse(gunzipSync(Buffer.from(await blob.arrayBuffer()))),evidence);
});
test('ordinary preview downloads remain readable JSON',async()=>{
  const evidence={dataKind:'illustrative',unknown:null};
  const blob=await resultDownloadBlob(evidence);
  assert.equal(blob.type,'application/json');assert.deepEqual(JSON.parse(await blob.text()),evidence);
});
test('unserialisable results fail instead of downloading altered evidence',async()=>{
  const circular={};circular.self=circular;
  await assert.rejects(resultDownloadBlob(circular,true),/circular/i);
});
