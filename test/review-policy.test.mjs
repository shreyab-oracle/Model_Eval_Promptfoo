import test from 'node:test';
import assert from 'node:assert/strict';
import {judgesDisagree,REVIEW_POLICY_VERSION,judgeTemplates} from '../src/domain/judge.mjs';
import {reviewOutput} from '../src/services/runs.mjs';
import {assessOutput,decideRun} from '../src/domain/decision.mjs';
import {modelInput,POLICY} from '../src/domain/policy.mjs';
import {generateDataset} from '../src/domain/dataset.mjs';
const j=(score,assessment)=>({assessment,critical:false,scores:{policy:score,evidence:3,tone:3,clarity:3,nextSteps:3}});
const output=(left=3,right=3)=>({id:'answer',caseId:'C',role:'candidate',repeat:0,response:{reply:'Saved exact reply.'},checks:[],judges:[j(left,0),j(right,1)]});
// Labels come directly from the user's specified review-policy examples.
// They are policy regression examples, not a claim of completed production calibration.
for(const [left,right,expected] of [[2,3,'PASS'],[0,1,'FAIL'],[1,2,'NEEDS_REVIEW']])test(`user-labelled ${left}/${right} policy example`,()=>{
  const o=output(left,right);assert.equal(assessOutput(o).outcome,expected);
  assert.equal(judgesDisagree(o.judges),expected==='NEEDS_REVIEW');
});
test('review policy is explicitly versioned; critical disagreement still requires review',()=>{
  assert.equal(REVIEW_POLICY_VERSION,'pass-boundary-v1');const o=output();o.judges[1].critical=true;
  assert.equal(assessOutput(o).outcome,'NEEDS_REVIEW');assert.equal(assessOutput(o).pending,true);
  assert.equal(assessOutput(o,[{outputId:o.id,resolution:'ACCEPT_OUTPUT'}]).outcome,'PASS');
});
test('historical review policy retains exact-score disagreement without changing original evidence',()=>{
  const o=output(2,3);assert.equal(assessOutput(o,[],{reviewPolicyVersion:'score-difference-v1'}).pending,true);
  assert.equal(assessOutput(o).pending,false);
});
test('confirmed financial failure stays FAIL while a critical flag awaits review',()=>{
  const o=output();o.checks=[{status:'FAIL',confirmed:true,severity:'critical',code:'HOLD_PRESERVATION'}];o.judges[1].critical=true;
  const a=assessOutput(o);assert.equal(a.outcome,'FAIL');assert.equal(a.pending,true);assert.equal(a.critical,true);
  assert.equal(assessOutput(o,[{outputId:o.id,resolution:'ACCEPT_OUTPUT'}]).outcome,'FAIL');
});
test('missing/invalid judges are uncertain evidence and cannot be accepted into a pass',()=>{
  for(const judges of [[],[j(3,0)], [{},{}]]){
    const o={...output(),judges};assert.equal(assessOutput(o).outcome,'NEEDS_REVIEW');
    assert.equal(assessOutput(o,[{outputId:o.id,resolution:'ACCEPT_OUTPUT'}]).pass,false);
  }
});
test('response/case counts include every planned item with review coverage separately',()=>{
  const outputs=['baseline','candidate'].flatMap(role=>[0,1,2].map(repeat=>({...output(),id:`${role}-${repeat}`,role,repeat})));
  outputs.find(o=>o.role==='candidate'&&o.repeat===1).judges=[j(1,0),j(2,1)];
  const d=decideRun({status:'COMPLETED',live:true,artifactsVerified:true,datasetKind:'development'},[{id:'C',category:'routine'},{id:'D',category:'routine'}],outputs);
  assert.deepEqual(d.outcomes.candidate.responses,{pass:2,fail:0,needsReview:4,total:6,expected:6,recorded:3,passRate:2/6});
  assert.deepEqual(d.outcomes.candidate.cases,{pass:0,fail:0,needsReview:2,total:2,passRate:0});
  assert.equal(d.outcomes.candidate.reviews.pending,1);assert.equal(d.decision,'REVIEW');
});
test('a known case failure is distinct from missing work and blocks as before',()=>{
  const o=output(0,1);const d=decideRun({status:'INCOMPLETE',live:true,datasetKind:'release'},[{id:'C',category:'routine'}],[o]);
  assert.equal(d.comparisons[0].candidate.outcome,'FAIL');assert.equal(d.outcomes.candidate.responses.fail,1);
  assert.equal(d.outcomes.candidate.responses.needsReview,2);assert.equal(d.decision,'BLOCK');
});
test('model instructions explain existing billed cents and primary-owner requirements',()=>{
  const text=modelInput({evidence:{}},'Follow supplied rules.',POLICY)[0].content;
  assert.match(text,/billedTotalCents is invoice\.quantity \* invoice\.unitCents, even when PO or receipt is absent/);
  assert.match(text,/DUPLICATE: AP Control; OVER_RECEIVED or MISSING_RECEIPT: Receiving; PRICE_TOLERANCE, OVER_ORDERED or MISSING_PO: Procurement; otherwise Accounts Payable/);
});
test('judge instructions distinguish failing quality from critical business violations',()=>{
  for(const t of judgeTemplates(POLICY))assert.match(t,/A score below 2 is not automatically a critical finding/);
});
test('premature human acceptance cannot override later unseen judgments',async()=>{
  const o={...output(),kind:'OUTPUT',parentId:'run',judges:[]};let saved=false;
  const store={doc:async()=>o,docs:async()=>[],saveDoc:async()=>{saved=true;}};
  await assert.rejects(()=>reviewOutput({runId:'run',outputId:o.id,resolution:'ACCEPT_OUTPUT',reason:'Premature'},{store}),/two valid.*assessment/i);
  assert.equal(saved,false);
});
test('resolved required reviews have a clear denominator and can clear a complete case',()=>{
  const outputs=['baseline','candidate'].flatMap(role=>[0,1,2].map(repeat=>({...output(),id:`${role}-${repeat}`,role,repeat})));
  const disputed=outputs.find(o=>o.role==='candidate');disputed.judges=[j(1,0),j(2,1)];
  const result=decideRun({status:'COMPLETED',live:true,artifactsVerified:true,datasetKind:'release'},[{id:'C',category:'routine'}],outputs,[{outputId:disputed.id,resolution:'ACCEPT_OUTPUT'}],{labels:true,calibration:true,release:true});
  assert.deepEqual(result.outcomes.candidate.reviews,{required:1,resolved:1,pending:0,coverage:1});
  assert.equal(result.outcomes.candidate.cases.pass,1);assert.equal(result.decision,'ELIGIBLE FOR PILOT');
});
test('agreed failing tone is FAIL without unnecessary score-only review',()=>{
  const o=output();o.judges[0].scores.tone=0;o.judges[1].scores.tone=1;
  assert.equal(assessOutput(o).outcome,'FAIL');assert.equal(assessOutput(o).pending,false);
});
test('new development datasets do not declare a singleton boundary case as a pair',()=>{
  const d=generateDataset({kind:'development',version:'new-pair-metadata'}),counts=new Map();
  for(const c of d.cases)if(c.pairId)counts.set(c.pairId,(counts.get(c.pairId)||0)+1);
  assert.equal(d.cases.length,24);assert.ok([...counts.values()].every(n=>n===2));assert.equal(counts.size,2);
});
