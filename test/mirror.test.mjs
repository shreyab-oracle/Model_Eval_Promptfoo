import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {createViewerMirror,startNativeViewer,viewerLabels} from '../src/evaluation/mirror.mjs';
test('navigation labels hide snapshot numbers without changing evidence or revision metadata',()=>{
  const description='release · date · mirror snapshot 2',evidence={reply:description};
  const details=viewerLabels({data:{config:{description,metadata:{mirrorSnapshot:2}},results:{evidence}}});
  assert.equal(details.data.config.description,'release · date');
  assert.equal(details.data.config.metadata.mirrorSnapshot,2);assert.equal(details.data.results.evidence.reply,description);
  const list=viewerLabels({data:[{description,label:description+' (eval-id)'}]});
  assert.equal(list.data[0].label,'release · date (eval-id)');assert.equal(list.data[0].description,'release · date');
});
test('stock Promptfoo imports and refreshes a rebuildable mirror without re-evaluating Oracle answers',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'aie-native-mirror-'));
  const output={id:'oracle-answer',caseId:'case',role:'candidate',repeat:0,response:{reply:'Please retain the hold.'},checks:[{code:'HOLD_PRESERVATION',status:'FAIL',severity:'critical',confirmed:true,message:'Required hold omitted'}],assessment:{outcome:'FAIL',critical:true},judges:[{assessment:0,scores:{policy:1,evidence:2,tone:3,clarity:2,nextSteps:2},rationale:'Original judgment',evidence:[{quote:'retain the hold',axis:'policy',reason:'Exact evidence'}]}]};
  const b={run:{id:'oracle-run',kind:'development',createdAt:'2026-11-01T08:00:00Z'},snapshot:{prompt:'Frozen instructions',dataset:{cases:[{id:'case',expected:{action:'RETAIN_HOLD'}}]}},result:{complete:true,decision:'BLOCK',reasons:['Original failure'],comparisons:[{id:'case',change:'REGRESSION',baseline:{outcome:'PASS',pending:0,critical:0},candidate:{outcome:'FAIL',pending:0,critical:1}}]},outputs:[output],reviews:[]};
  let native;const mirror=createViewerMirror({directory,start:async dir=>native=await startNativeViewer(dir),readComparison:async id=>{assert.equal(id,'oracle-run');return structuredClone(b);},listRuns:async()=>[b.run]});
  const url=query=>new URL(`http://127.0.0.1/promptfoo/api/eval/${id}/table${query}`);let id;
  try{
    const first=await mirror.ensure('oracle-run');id=first.viewerId;assert.ok(id);assert.equal((await mirror.ensure('oracle-run')).viewerId,id);
    assert.equal((await fetch(native.base+'/health')).status,403,'the stock server cannot be accessed without the private proxy token');
    const upgrade=await new Promise((resolve,reject)=>{
      const socket=net.connect(Number(new URL(native.base).port),'127.0.0.1',()=>socket.write('GET /socket.io/?EIO=4&transport=websocket HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'));
      socket.once('data',data=>{resolve(data.toString());socket.destroy();});socket.once('error',reject);socket.setTimeout(3000,()=>{socket.destroy();reject(new Error('Upgrade rejection timed out'));});
    });assert.match(upgrade,/^HTTP\/1\.1 403/,'WebSocket upgrades cannot bypass the private HTTP token');
    const page=await(await mirror.proxy('GET',url('?limit=1'))).json();assert.equal(page.table.body.length,1);
    const saved=page.table.body[0].outputs[1];assert.match(saved.text,/Please retain the hold/);assert.equal(saved.namedScores['Judge 1 · policy'],1);assert.equal(saved.metadata.oracleRunId,'oracle-run');assert.equal(saved.metadata.oracleOutputId,'oracle-answer');
    assert.equal(saved.failureReason,1);assert.match(JSON.stringify(saved.gradingResult),/Original judgment/);
    const filtered=await(await mirror.proxy('GET',url('?filter='+encodeURIComponent(JSON.stringify({type:'metadata',field:'confirmedCriticalFailure',operator:'equals',value:'true'}))))).json();assert.equal(filtered.filteredCount,3);
    for(const [caseId,expected] of [['case',3],['missing-case',0]]){
      const exact=await(await mirror.proxy('GET',url('?filter='+encodeURIComponent(JSON.stringify({type:'metadata',field:'caseId',operator:'equals',value:caseId}))))).json();assert.equal(exact.filteredCount,expected);
    }
    for(const [query,expected] of [['Example 1',3],['Example 1, repetition 1',1],['example 1 repetition 2',1],['Example 2',0],['Example 1, repetition 4',0]]){
      const searched=await(await mirror.proxy('GET',url('?search='+encodeURIComponent(query)))).json();assert.equal(searched.filteredCount,expected,query);
      if(expected===1){assert.equal(searched.table.body[0].outputs.length,2);assert.equal(searched.table.body[0].outputs[0].metadata.repeat,/2$/.test(query)?1:0);}
    }
    const narrowed=await(await mirror.proxy('GET',url('?search='+encodeURIComponent('Example 1, repetition 1')+'&filter='+encodeURIComponent(JSON.stringify({type:'metadata',field:'confirmedCriticalFailure',operator:'equals',value:'true'}))))).json();assert.equal(narrowed.filteredCount,1);
    const excluded=await(await mirror.proxy('GET',url('?search='+encodeURIComponent('Example 1, repetition 1')+'&filter='+encodeURIComponent(JSON.stringify({type:'metadata',field:'caseId',operator:'equals',value:'missing-case'}))))).json();assert.equal(excluded.filteredCount,0,'search must not clear an existing case filter');
    const ordinary=await(await mirror.proxy('GET',url('?search='+encodeURIComponent('Please retain the hold')))).json();assert.equal(ordinary.filteredCount,1,'ordinary answer text search is preserved');
    output.assessment={outcome:'NEEDS_REVIEW',critical:false};b.result.decision='REVIEW';
    const previousId=id;id=(await mirror.ensure('oracle-run')).viewerId;assert.notEqual(id,previousId,'changed source evidence creates a separate immutable mirror snapshot');
    const refreshed=await(await mirror.proxy('GET',url('?limit=1'))).json();assert.equal(refreshed.table.body[0].outputs[1].failureReason,2);
    assert.equal(refreshed.config.metadata.businessGate,'REVIEW');
    const originalURL=new URL(`http://127.0.0.1/promptfoo/api/eval/${previousId}/table?limit=1`);
    assert.equal((await(await mirror.proxy('GET',originalURL)).json()).table.body[0].outputs[1].failureReason,1,'the original mirror judgment must be retained');
    await assert.rejects(()=>mirror.proxy('POST',url('')),{statusCode:409});
    assert.equal((await mirror.context(id)).oracleRunId,'oracle-run');
  }finally{await mirror.close();await fs.rm(directory,{recursive:true,force:true,maxRetries:8,retryDelay:150});}
});
