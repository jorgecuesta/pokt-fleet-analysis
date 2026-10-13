import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {strict as assert} from 'node:assert';
import {Script,runInNewContext} from 'node:vm';
import {webcrypto,createHash} from 'node:crypto';

const root=dirname(dirname(fileURLToPath(import.meta.url)));
const html=await readFile(join(root,'dist/index.html'),'utf8');
assert(!html.includes('/* INLINE_'),'Build placeholders must be replaced.');
assert(!/__RUBIK_DATA__|__POCKET_LOGO__/.test(html),'Brand assets must be embedded.');
assert(html.includes('data:font/woff2;base64,'));
assert(html.includes('data:image/png;base64,'));
assert(html.includes('SIL OPEN FONT LICENSE Version 1.1'));
assert.equal((await readFile(join(root,'src/assets/rubik-latin-variable.woff2'))).subarray(0,4).toString(),'wOF2');
assert.equal((await readFile(join(root,'src/assets/pocket-logo-white.png'))).subarray(1,4).toString(),'PNG');
const code=html.match(/<script>([\s\S]*?)<\/script>/)[1];
new Script(code);
// Exercise the shipped gzip bootstrap for both datasets without claiming a
// rendered-browser test. Dataset choice must not decode the unused payload.
const prefix=code.slice(0,code.indexOf('/** Small, dependency-free'));
assert(prefix.includes('decodeSnapshot'));
for(const [search,hash,kind] of [['','', 'live'],['?dataset=preview','', 'illustrative'],['','#snapshot=illustrative-september-2026-v1','illustrative']]){
  const requested=[],fetched=[];
  const document={getElementById(id){requested.push(id);return {textContent:html.match(new RegExp(`<script[^>]+id="${id}"[^>]*>([\\s\\S]*?)<\\/script>`))[1]};}};
  const result=await runInNewContext(prefix+'return {data:SNAPSHOT_DATA,settlement:SETTLEMENT_DATA,asset:SAVED_SETTLEMENT_ASSET};})()',{
    document,location:{search,hash},URLSearchParams,Uint8Array,atob,Blob,Response,DecompressionStream,crypto:webcrypto,
    fetch:async url=>{assert(/^\.\/settlements-[a-f0-9]{16}\.bin$/.test(url));fetched.push(url);return new Response(await readFile(join(root,'dist',url.slice(2))));}});
  assert.equal(result.data.dataKind,kind);
  assert.deepEqual(requested,kind==='live'&&result.asset?['live-snapshot','settlement-tables']:[kind==='live'?'live-snapshot':'fictional-snapshot']);
  assert.equal(fetched.length,kind==='live'&&result.asset?1:0);
  if(kind==='live'&&result.asset){assert(result.settlement.sessions.length>0);assert.equal(createHash('sha256').update(await readFile(join(root,'dist',result.asset.filename))).digest('hex'),result.asset.sha256);}else assert.equal(result.settlement,null);
}
assert.equal((code.match(/\bfetch\s*\(/g)??[]).length,1,'Only the fixed saved-asset loader may fetch.');
assert(code.includes('fetch(`./${filename}`'),'The data loader must use a relative asset.');
assert(!/\b(XMLHttpRequest|WebSocket)\s*\(/.test(code),'No external API transport.');
assert(!/<(?:script|link)[^>]+(?:src|href)="https?:/i.test(html),'Brand and application dependencies must be embedded.');
assert(html.includes('<html lang="en">'));
assert(html.includes('width=device-width'));
assert(html.includes('prefers-reduced-motion'));
assert(html.includes(':focus-visible'));
assert(html.includes('role="tablist"'));
assert(html.includes('aria-labelledby="dialog-title"'));
assert(html.includes('max-width:650px'));
assert(html.includes('max-width:850px'));
assert(html.includes('All fleets, identities and results are fictional.'));
const sourceFiles=['snapshot-loader','math','settlements','engine','adapter','export-download','app'];
for(const name of sourceFiles) {
  const source=await readFile(join(root,`src/${name}.js`),'utf8');
  assert(!source.includes('TODO'),'Unfinished implementation marker.');
}
console.log('Bundle syntax, saved-asset delivery, dataset disclosure, keyboard semantics and responsive CSS checks passed.');
await import('./check-contract.mjs');
