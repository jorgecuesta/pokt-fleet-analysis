/** Gzip keeps complete monthly evidence practical without omitting any records. */
export async function resultDownloadBlob(result, compressed=false) {
  const plain=new Blob([JSON.stringify(result,null,compressed?0:2)],{type:'application/json'});
  if(!compressed)return plain;
  const stream=plain.stream().pipeThrough(new CompressionStream('gzip'));
  const bytes=await new Response(stream).arrayBuffer();
  return new Blob([bytes],{type:'application/gzip'});
}
