import test from 'node:test';
import assert from 'node:assert/strict';
import {decideRun} from '../src/domain/decision.mjs';
import {generateDataset} from '../src/domain/dataset.mjs';
const workflow=await import('../src/services/task-policy.mjs').catch(()=>({}));
const prompt=await import('../src/domain/prompt.mjs').catch(()=>({}));
const improvements=await import('../src/services/prompts.mjs').catch(()=>({}));

test('transient errors retry at most three attempts; auth failures do not retry',()=>{
  assert.equal(typeof workflow.retryDisposition,'function');
  assert.deepEqual(workflow.retryDisposition({statusCode:429},1),{retry:true,delayMs:30000});
  assert.deepEqual(workflow.retryDisposition({statusCode:429},2),{retry:true,delayMs:60000});
  assert.deepEqual(workflow.retryDisposition({statusCode:429,retryAfterMs:90000},1),{retry:true,delayMs:90000});
  assert.deepEqual(workflow.retryDisposition({statusCode:429},3),{retry:false,delayMs:0});
  assert.deepEqual(workflow.retryDisposition({statusCode:503},1),{retry:true,delayMs:2000});
  assert.equal(workflow.retryDisposition({statusCode:503},3).retry,false);
  assert.equal(workflow.retryDisposition({statusCode:401},1).retry,false);
});
test('interrupted model answers and prompt searches cannot be automatically reclaimed',()=>{
  assert.equal(typeof workflow.canAutoReclaim,'function');
  assert.equal(workflow.canAutoReclaim({stage:'PROPOSE'}),false);
  assert.equal(workflow.canAutoReclaim({stage:'GENERATE'}),false);
  assert.equal(workflow.canAutoReclaim({stage:'JUDGE'}),false);
  assert.equal(workflow.canAutoReclaim({stage:'RETEST'}),true);
});
test('expected task manifests require distinct model repetitions and judge slots',()=>{
  assert.equal(typeof workflow.evaluationTaskSpecs,'function');const plan=workflow.evaluationTaskSpecs('RUN',[{id:'CASE'}]);assert.equal(plan.length,18);assert.equal(new Set(plan.map(t=>t.id)).size,18);assert.equal(plan.filter(t=>t.stage==='JUDGE').length,12);
});
test('prompt improvement rejects independent release data',()=>{
  assert.equal(typeof prompt.assertDevelopment,'function');
  assert.throws(()=>prompt.assertDevelopment(generateDataset({kind:'release'})),/development/i);
  assert.doesNotThrow(()=>prompt.assertDevelopment(generateDataset({kind:'development'})));
});
test('repeated improvement requests reuse a durable job identity',()=>{
  assert.equal(typeof improvements.improvementJobId,'function');
  const input={sourceRunId:'R1',inputDigest:'S1',autoRetest:true,actor:'operator'};
  assert.equal(improvements.improvementJobId(input),improvements.improvementJobId({...input}));
  assert.notEqual(improvements.improvementJobId(input),improvements.improvementJobId({...input,inputDigest:'S2'}));
});
test('untrusted prompt proposals cannot supply database identity metadata',()=>{
  const p=improvements.validateProposal({id:'spoofed',kind:'PROMPT',text:'Follow the immutable demonstration policy and verify every payment claim using trusted ledger evidence.',rationale:'Clarify required evidence before asserting financial status.'},{source:{prompt:'Previous instructions',promptId:'P',policyDigest:'D'},sourceRunId:'R',failures:[]});
  assert.equal(p.id,undefined);assert.equal(p.kind,undefined);
});
test('prompt diffs show reordered and duplicate instruction lines',()=>{
  const reordered=prompt.lineDiff('first\nsecond','second\nfirst');assert.equal(reordered.length,4);
  assert.deepEqual(prompt.lineDiff('retain hold\nretain hold','retain hold'),[{type:'removed',text:'retain hold'}]);
});
test('gate exit is zero only for completed eligible live evidence',()=>{
  assert.equal(typeof workflow.gateExitCode,'function');
  assert.equal(workflow.gateExitCode({decision:'ELIGIBLE FOR PILOT',complete:true}),0);
  for(const decision of ['BLOCK','REVIEW','ELIGIBLE FOR PILOT'])assert.equal(workflow.gateExitCode({decision,complete:false}),1);
});
test('an eligible result for the previous candidate cannot approve a different configured model switch',()=>{
  const result={decision:'ELIGIBLE FOR PILOT',complete:true},expectedTarget={models:{baseline:'gpt-mini',candidate:'gemini',judge:'gpt-judge'},settings:{candidate:{maxTokens:6000}},endpoint:'configured-endpoint'};
  assert.equal(workflow.gateExitCode(result,{expectedTarget,evaluatedTarget:{...expectedTarget,models:{...expectedTarget.models,candidate:'old-gpt-candidate'}}}),1);
  assert.equal(workflow.gateExitCode(result,{expectedTarget,evaluatedTarget:expectedTarget}),0);
  assert.equal(workflow.gateExitCode(result,{expectedTarget}),1);
  assert.equal(workflow.gateExitCode(result,{expectedTarget,evaluatedTarget:{...expectedTarget,settings:{candidate:{maxTokens:4000}}}}),1);
  assert.equal(workflow.gateExitCode(result,{expectedTarget,evaluatedTarget:{...expectedTarget,endpoint:'another-endpoint'}}),1);
});
test('a candidate category regression blocks despite a higher overall average',()=>{
  const cases=Array.from({length:100},(_,i)=>({id:`C${i}`,category:i<10?'pressure':'routine'}));
  const judge={scores:{policy:3,evidence:3,tone:3,clarity:3,nextSteps:3},critical:false};
  const outputs=cases.flatMap((c,i)=>['baseline','candidate'].flatMap(role=>Array.from({length:3},(_,repeat)=>({caseId:c.id,role,repeat,response:{},judges:[{...judge,assessment:0},{...judge,assessment:1}],checks:(role==='baseline'&&i>=80)||(role==='candidate'&&i===0)?[{code:'X',status:'FAIL',severity:'major',confirmed:true}]:[]}))));
  const d=decideRun({status:'COMPLETED',live:true,artifactsVerified:true,datasetKind:'release'},cases,outputs,[],{labels:true,calibration:true,release:true});
  assert.ok(d.candidate>d.baseline);assert.equal(d.decision,'BLOCK');assert.ok(d.reasons.some(r=>r.includes('category regression')));
});
test('incomplete results never label an unexecuted candidate as a measured regression',()=>{
  const c={id:'partial',category:'routine'},judge={scores:{policy:3,evidence:3,tone:3,clarity:3,nextSteps:3},critical:false};
  const baseline=Array.from({length:3},(_,repeat)=>({caseId:c.id,role:'baseline',repeat,response:{},checks:[],judges:[{...judge,assessment:0},{...judge,assessment:1}]}));
  const result=decideRun({status:'RUNNING',live:true,datasetKind:'development'},[c],baseline);
  assert.equal(result.complete,false);assert.equal(result.comparisons[0].change,'PENDING');
});
