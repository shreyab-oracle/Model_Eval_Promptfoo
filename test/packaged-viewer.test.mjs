import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {buildUI} from '../scripts/build-ui.mjs';
import {makeServer} from '../src/http/server.mjs';
import {createViewerMirror} from '../src/evaluation/mirror.mjs';

test('production package serves native assets and Oracle run links through the protected stock viewer',async()=>{
  const staticRoot=await buildUI(),directory=await fs.mkdtemp(path.join(os.tmpdir(),'aie-packaged-ui-'));
  const b={run:{id:'oracle-smoke',kind:'development',status:'COMPLETED',createdAt:'2026-11-01T08:00:00Z'},snapshot:{prompt:'Frozen saved instructions',dataset:{cases:[{id:'case',invoice:{quantity:10,unitCents:100}}]}},outputs:[],result:{decision:'REVIEW',reasons:['Saved evidence is incomplete'],complete:false,comparisons:[],pendingReviews:0,criticalCandidateFailures:0},reviews:[]};
  const mirror=createViewerMirror({directory,readComparison:async id=>{assert.equal(id,b.run.id);return b;},listRuns:async()=>[b.run]});
  const server=makeServer({port:0,staticRoot,mirror,dispatch:async()=>{throw new Error('The UI fixture cannot invoke live application services');}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
  try{
    const response=await fetch(base+'/eval/oracle-smoke');assert.equal(response.status,200);assert.match(response.url,/\/eval\/eval-/);
    const html=await response.text();assert.match(html,/<title>promptfoo<\/title>/);assert.match(html,/\/aie\/viewer-bootstrap.js/);
    const viewerId=new URL(response.url).pathname.split('/')[2];
    const table=await(await fetch(base+'/promptfoo/api/eval/'+viewerId+'/table')).json();assert.equal(table.table.body.length,3);assert.equal(table.table.head.prompts.length,2);assert.equal(table.table.body[0].outputs[0].failureReason,2);
    for(const asset of new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"#]+)"/g)].map(m=>m[1]))){const file=await fetch(base+asset);assert.equal(file.status,200);assert.ok((await file.arrayBuffer()).byteLength>0);}
    const context=await(await fetch(base+'/aie/viewer-context/'+viewerId)).json();assert.equal(context.oracleRunId,'oracle-smoke');assert.equal(context.result.decision,'REVIEW');
    assert.deepEqual(context.outcomes.candidate,{total:3,pass:0,fail:0,needsReview:0,incomplete:3});
    const write=await fetch(base+'/promptfoo/api/eval/replay',{method:'POST'});assert.equal(write.status,409);
    assert.match((await fetch(base+'/aie/presentation.mjs')).headers.get('content-type'),/javascript/);
  }finally{await new Promise(resolve=>server.close(resolve));await mirror.close();await fs.rm(directory,{recursive:true,force:true,maxRetries:8,retryDelay:150});}
});
