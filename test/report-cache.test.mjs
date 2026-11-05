import test from 'node:test';
import assert from 'node:assert/strict';
import {readSavedReport} from '../src/services/runs.mjs';
import {assertReportReady} from '../src/services/task-policy.mjs';

const bundle={run:{id:'test-1',status:'COMPLETED',reportId:'report-1'},manifest:{digest:'frozen-manifest'},inputDigest:'current-inputs'};
const report={runId:'test-1',manifestDigest:'frozen-manifest',inputDigest:'current-inputs',result:{decision:'BLOCK'}};
const doc={kind:'REPORT',parentId:'test-1',report,artifact:{key:'report.json'}};

test('unfinished work cannot create a partial report that prevents the final automatic report',()=>{
  assert.doesNotThrow(()=>assertReportReady({run:{status:'COMPLETED'},tasks:[{status:'DONE'}]}));
  for(const status of ['DRAFT','RUNNING','INCOMPLETE','CANCELLED'])assert.throws(()=>assertReportReady({run:{status},tasks:[{status:'DONE'}]}),e=>e.code==='REPORT_NOT_READY');
  assert.throws(()=>assertReportReady({run:{status:'COMPLETED'},tasks:[{status:'FAILED'}]}),e=>e.code==='REPORT_NOT_READY');
});

test('a current saved report can supply the results screen without loading every conversation',async()=>{
  const result=await readSavedReport(bundle,{loadDocument:async()=>doc,loadArtifact:async()=>structuredClone(report)});
  assert.deepEqual(result.result,{decision:'BLOCK'});
});
test('stale, foreign and missing reports cannot supply current evaluation evidence',async()=>{
  for(const value of [null,{...doc,parentId:'other-test'},{...doc,report:{...report,inputDigest:'previous-inputs'}},{...doc,report:{...report,manifestDigest:'different-manifest'}}]){
    assert.equal(await readSavedReport(bundle,{loadDocument:async()=>value,loadArtifact:async()=>{throw new Error('Stale reports must not be loaded');}}),null);
  }
});
test('corrupt saved report contents remain an actual verification error',async()=>{
  await assert.rejects(()=>readSavedReport(bundle,{loadDocument:async()=>doc,loadArtifact:async()=>({...report,result:{decision:'ELIGIBLE FOR PILOT'}})}),/report digest mismatch/i);
});
