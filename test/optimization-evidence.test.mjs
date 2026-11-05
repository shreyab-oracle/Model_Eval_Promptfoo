// Unit fixtures exercise the shared production checker/judge path; no model providers.
import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateOptimizationCase} from '../src/optimization/engine.mjs';
import {generateDataset} from '../src/domain/dataset.mjs';
import {INITIAL_PROMPT,POLICY,expectedFor,sourceIds} from '../src/domain/policy.mjs';
import {AXES,judgeTemplates,RUBRIC} from '../src/domain/judge.mjs';
test('Prompt optimization invokes shared three-repeat/two-judge evaluation and excludes labels from tested-model input',async()=>{
  const c=generateDataset({kind:'development'}).cases[0],docs=new Map(),options=[];
  const source={models:{candidate:'candidate',judge:'judge'},modes:{candidate:'ON_DEMAND',judge:'ON_DEMAND'},settings:{maxCompletionTokens:2048,verbosity:'MEDIUM'},judgeSettings:{maxCompletionTokens:2048,verbosity:'MEDIUM'},modelSettings:{candidate:{family:'gemini',maxTokens:6000,temperature:1,frequencyPenalty:0,presencePenalty:0,topP:0.95,fixedTopK:64},judge:{family:'openai',maxCompletionTokens:2048,verbosity:'MEDIUM'}},policy:POLICY,judgeTemplates:judgeTemplates(POLICY)};
  const response={...expectedFor(c),sources:sourceIds(c),nextStep:'Accounts Payable should continue the normal approval process.',reply:'Thank you. The records match; please continue normal Accounts Payable approval. Payment is not confirmed.'};
  const invoke=async(op,request)=>{options.push({op,request});return{text:JSON.stringify(op.startsWith('generate')?response:{scores:Object.fromEntries(AXES.map(a=>[a,op.endsWith('/1')?2:3])),critical:false,rationale:'The reply follows the supplied evidence and normal approval process.',evidence:[{quote:'Payment is not confirmed.',axis:'evidence',reason:'Unknown payment status is acknowledged.'}]})};};
  const store={doc:async id=>docs.get(id),saveDoc:async d=>{docs.set(d.id,{id:d.id,...d.value});return d.id;}};
  const input={snapshot:{source},jobId:'UNIT',text:INITIAL_PROMPT,c,invoke,store};
  const value=await evaluateOptimizationCase(input);assert.equal(value.complete,true);assert.equal(value.pass,true);assert.equal(options.length,9);assert.equal(options.filter(o=>o.op.startsWith('judge')).length,6);
  assert.ok(value.feedback.outputs.every(o=>o.evaluation?.runner==='promptfoo'),'Prompt optimization feedback must come from the shared runner');
  assert.equal(value.pending,false,'passing 2/3 differences do not create a second optimization correctness interpretation');
  assert.ok([...docs.values()].filter(d=>d.judges).every(d=>d.judgeEvaluations?.length===2));
  for(const o of options.filter(o=>o.op.startsWith('generate'))){assert.doesNotMatch(o.request.messages[1].content,/expected|referenceBehaviour|expectedBehaviour/);assert.equal(o.request.settings.maxTokens,6000);assert.equal('maxCompletionTokens' in o.request.settings,false);}
  for(const o of options.filter(o=>o.op.startsWith('judge')))assert.equal(o.request.settings.maxCompletionTokens,2048);
  await evaluateOptimizationCase(input);assert.equal(options.length,9,'saved outputs must replay without new calls');
});
test('our judge rubric has distinct fixed anchors for all five criteria',()=>{
  assert.deepEqual(Object.keys(RUBRIC),AXES);for(const axis of AXES)assert.equal(RUBRIC[axis].length,4);
  for(const template of judgeTemplates(POLICY)){assert.match(template,/equivalent correct business behaviour/);assert.match(template,/Every axis must be >=2/);assert.match(template,/Good tone cannot compensate/);}
});
