export async function decodeSnapshot(id) {
  if(typeof DecompressionStream==='undefined')throw new Error('Use a current browser supporting gzip decompression.');
  const encoded=JSON.parse(document.getElementById(id).textContent);
  const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));
  return JSON.parse(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text());
}

export async function loadSavedSettlements(filename,sha256) {
  if(!/^settlements-[a-f0-9]{16}\.bin$/.test(filename)||!/^[a-f0-9]{64}$/.test(sha256)||!filename.includes(sha256.slice(0,16)))
    throw new Error('Invalid saved settlement asset reference.');
  if(typeof DecompressionStream==='undefined')throw new Error('Use a current browser supporting gzip decompression.');
  const response=await fetch(`./${filename}`,{credentials:'same-origin',cache:'force-cache'});
  if(!response.ok)throw new Error(`Saved settlement data could not be loaded (HTTP ${response.status}). Reload the page.`);
  const bytes=await response.arrayBuffer();
  const checksum=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
  if(checksum!==sha256)throw new Error('Saved settlement data failed its checksum. Reload the page; sampled earnings have not been substituted.');
  return JSON.parse(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text());
}
