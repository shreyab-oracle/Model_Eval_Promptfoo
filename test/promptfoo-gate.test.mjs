import test from 'node:test';
import assert from 'node:assert/strict';
import {decideRun,assessOutput} from '../src/domain/decision.mjs';
import {gateExitCode} from '../src/services/task-policy.mjs';

const run={status:'COMPLETED',live:true,artifactsVerified:true,datasetKind:'release'},evidence={labels:true,calibration:true,release:true};
const judge={critical:false,scores:{policy:3,evidence:3,tone:3,clarity:3,nextSteps:3}};
const cases=Array.from({length:100},(_,i)=>({id:`case-${i}`,category:'routine',...(i<2?{pairId:'boundary-pair'}:{})}));
const rows=()=>cases.flatMap(c=>['baseline','candidate'].flatMap(role=>[0,1,2].map(repeat=>({id:`${c.id}-${role}-${repeat}`,caseId:c.id,role,repeat,response:{reply:'Saved response'},checks:[],judges:[{...structuredClone(judge),assessment:0},{...structuredClone(judge),assessment:1}]}))));
const failure={code:'HOLD_PRESERVATION',status:'FAIL',severity:'critical',confirmed:true,message:'Required hold omitted'};

test('confirmed mandatory critical failure BLOCKs even with unfinished execution and missing evidence',()=>{
  const output=rows().find(o=>o.role==='candidate');output.checks=[failure];
  const result=decideRun({...run,status:'INCOMPLETE',artifactsVerified:false},cases,[output],[],{});
  assert.equal(result.decision,'BLOCK');assert.equal(result.complete,false);assert.equal(gateExitCode(result),1);
});
test('a failed paired boundary blocks despite 99 percent overall and category success',()=>{
  const outputs=rows();outputs.find(o=>o.role==='candidate'&&o.caseId==='case-0').checks=[{...failure,severity:'major'}];
  // Baseline also fails this member, so no ordinary category regression applies.
  outputs.find(o=>o.role==='baseline'&&o.caseId==='case-0').checks=[{...failure,severity:'major'}];
  const result=decideRun(run,cases,outputs,[],evidence);
  assert.equal(result.candidate,0.99);assert.equal(result.decision,'BLOCK');
  assert.ok(result.reasons.some(r=>/paired/i.test(r)));assert.equal(result.pairedTests.failed,1);
});
test('an incomplete declared pair requires REVIEW and cannot establish release eligibility',()=>{
  const unpaired=cases.map((c,i)=>i===1?{id:c.id,category:c.category}:c),result=decideRun(run,unpaired,rows(),[],evidence);
  assert.equal(result.decision,'REVIEW');assert.equal(result.pairedTests.complete,false);
});
test('pending judge adjudication is REVIEW when it is the only obstacle to thresholds',()=>{
  const outputs=rows();for(const o of outputs)if(o.role==='candidate')o.judges[1].scores.tone=1;
  const result=decideRun(run,cases,outputs,[],evidence);
  assert.equal(result.pendingReviews,300);assert.equal(result.decision,'REVIEW');
});
test('human acceptance resolves judge disagreement but never deterministic controls',()=>{
  const o=rows()[0];o.judges[1].critical=true;
  assert.equal(assessOutput(o).pending,true);
  assert.equal(assessOutput(o,[{outputId:o.id,resolution:'ACCEPT_OUTPUT'}]).pass,true);
  o.checks=[failure];assert.equal(assessOutput(o,[{outputId:o.id,resolution:'ACCEPT_OUTPUT'}]).pass,false);
});
test('known numerical failures cannot be masked by missing artifact approvals',()=>{
  const outputs=rows();for(const o of outputs)if(o.role==='candidate')o.checks=[{...failure,severity:'major'}];
  assert.equal(decideRun({...run,artifactsVerified:false},cases,outputs,[],{}).decision,'BLOCK');
});
test('missing and malformed judgments remain REVIEW instead of fabricating failed quality scores',()=>{
  for(const invalid of [[],[{} ,{}],[{...judge,assessment:0},{...judge,scores:{policy:'3'},assessment:1}]]){
    const outputs=rows();for(const o of outputs)o.judges=structuredClone(invalid);
    assert.equal(decideRun(run,cases,outputs,[],evidence).decision,'REVIEW');
  }
});
