import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const api=await import('../src/http/server.mjs');
test('native viewer HTTP reads use the Oracle adapter while mutations cannot reach application writes',async()=>{
  assert.equal(typeof api.makeServer,'function');let writes=0;
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aie-viewer-test-'));fs.writeFileSync(path.join(root,'index.html'),'<title>promptfoo</title>');
  const server=api.makeServer({port:0,staticRoot:root,dispatch:async method=>{if(method!=='GET')writes++;return{};},viewer:async method=>{if(method!=='GET')throw Object.assign(new Error('Use Invoice controls'),{statusCode:409});return{data:['saved-Oracle-run']};}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
  try{
    const list=await fetch(`http://127.0.0.1:${port}/promptfoo/api/results`);assert.deepEqual(await list.json(),{data:['saved-Oracle-run']});
    const mutation=await fetch(`http://127.0.0.1:${port}/promptfoo/api/eval/replay`,{method:'POST'});assert.equal(mutation.status,409);assert.equal(writes,0);
    const html=await(await fetch(`http://127.0.0.1:${port}/eval/saved-Oracle-run`)).text();assert.match(html,/<title>promptfoo<\/title>/);
    const foreign=await fetch(`http://127.0.0.1:${port}/api/reviews`,{method:'POST',headers:{origin:'https://foreign.invalid','content-type':'application/json'},body:'{}'});assert.equal(foreign.status,403);assert.equal(writes,0);
  }finally{await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true});}
});

test('Oracle links redirect once to URL-encoded native IDs without a redirect loop',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aie-viewer-redirect-'));fs.writeFileSync(path.join(root,'index.html'),'<title>promptfoo</title>');
  const viewerId='eval-local-2026-11-01T08:00:00';
  const mirror={ensure:async()=>({viewerId}),latest:async()=>({viewerId}),close:async()=>{}};
  const server=api.makeServer({port:0,staticRoot:root,mirror});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{const response=await fetch(`http://127.0.0.1:${server.address().port}/eval/oracle-run`);assert.equal(response.status,200);assert.match(response.url,/%3A/);assert.match(await response.text(),/<title>promptfoo/);}
  finally{await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true});}
});
