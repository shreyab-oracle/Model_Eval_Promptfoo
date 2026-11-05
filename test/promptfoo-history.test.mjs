import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from '../src/domain/policy.mjs';
import * as runs from '../src/services/runs.mjs';
import {gateExitCode} from '../src/services/task-policy.mjs';

const b={run:{id:'historical-run',status:'COMPLETED',reportId:'original-report'},manifest:{digest:'original-manifest'},inputDigest:'later-review-state'};
const report={runId:b.run.id,manifestDigest:b.manifest.digest,inputDigest:'original-inputs',result:{decision:'ELIGIBLE FOR PILOT',complete:true,reasons:[],comparisons:[]}};
const doc={kind:'REPORT',parentId:b.run.id,report,artifact:{key:'original.json',digest:digest(report)}};
test('historical reports keep their exact original decision even after evaluator or review changes',async()=>{
  assert.equal(typeof runs.historicalComparison,'function');
  const original=structuredClone(doc);
  const result=await runs.historicalComparison(b,{loadDocument:async()=>doc,loadArtifact:async()=>structuredClone(report)});
  assert.deepEqual(result.result,report.result);assert.equal(result.historical,true);assert.equal(result.eligibilityRequiresNewRun,true);
  assert.deepEqual(doc,original,'reading history must never replace its report');
});
test('historical corrupt artifacts and foreign reports cannot become saved evidence',async()=>{
  assert.equal(typeof runs.historicalComparison,'function');
  await assert.rejects(()=>runs.historicalComparison(b,{loadDocument:async()=>doc,loadArtifact:async()=>({...report,result:{decision:'BLOCK'}})}),/digest/i);
  const result=await runs.historicalComparison(b,{loadDocument:async()=>({...doc,parentId:'other'}),loadArtifact:async()=>{throw new Error('Must not read foreign report');}});
  assert.equal(result.result.decision,'REVIEW');assert.equal(result.artifactVerification.verified,false);
});
test('an archived eligible decision cannot grant eligibility under the current evaluator',()=>{
  assert.equal(gateExitCode(report.result,{currentEvidence:false}),1);
});
