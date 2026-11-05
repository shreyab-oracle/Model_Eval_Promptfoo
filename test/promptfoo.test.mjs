import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {observeModelAnswer} from '../src/services/model-answer.mjs';
import {validateJudge,judgePass} from '../src/domain/judge.mjs';
import {evaluationTaskSpecs} from '../src/services/task-policy.mjs';
const adapter=await import('../src/evaluation/adapter.mjs').catch(()=>({}));
const f=JSON.parse(fs.readFileSync(new URL('./fixtures/promptfoo-parity.json',import.meta.url)));
const response=text=>({text,raw:{chatResponse:{choices:[{message:{content:[{type:'TEXT',text}]}}]}},requestId:'saved-request',latencyMs:17,usage:{promptTokens:10,completionTokens:20}});
const replay=async(stage,c,text,extra={})=>{assert.equal(typeof adapter.evaluateRequest,'function');return adapter.evaluateRequest({stage,c,receivedResponse:response(text),identity:{taskId:'saved-task',attemptId:'saved-attempt'},...extra});};

for(const scenario of f.scenarios)test(`Promptfoo saved parity: ${scenario.name}`,async()=>{
  const c=structuredClone(f.case);
  for(const key of ['invoice','po','receipt','evidence'])if(scenario[key])Object.assign(c[key],scenario[key]);
  const answer={...structuredClone(f.answer),...scenario.answer},text=scenario.text||JSON.stringify(answer);
  const legacy=observeModelAnswer(c,text),actual=await replay('GENERATE',c,text);
  assert.deepEqual(actual.value,legacy);
  assert.deepEqual(actual.value.checks.filter(x=>x.status==='FAIL').map(x=>x.code),scenario.failed);
  if(scenario.critical)assert.ok(actual.value.checks.some(x=>x.severity==='critical'&&x.confirmed));
  assert.equal(actual.evaluation.runner,'promptfoo');
  assert.equal(actual.evaluation.success,scenario.failed.length===0);
  assert.deepEqual(actual.evaluation.gradingResult.metadata.business,legacy);
});

test('two valid saved judgments preserve every score and exact excerpt including tone failure',async()=>{
  for(const scores of [f.judge.scores,{...f.judge.scores,tone:0},{...f.judge.scores,clarity:0}]){
    const judgment={...f.judge,scores},text=JSON.stringify(judgment);
    const actual=await replay('JUDGE',f.case,text,{evaluatedOutput:f.answer});
    assert.deepEqual(actual.value.assessmentResult,validateJudge(judgment,f.answer));
    assert.equal(actual.evaluation.success,judgePass(judgment));
  }
});

test('missing, invalid, and fabricated judgment evidence cannot become accepted scores',async()=>{
  for(const text of ['{ broken',JSON.stringify({scores:{}}),JSON.stringify({...f.judge,evidence:[{quote:'fabricated',axis:'policy',reason:'wrong'}]})]){
    assert.equal(typeof adapter.evaluateRequest,'function');
    await assert.rejects(()=>replay('JUDGE',f.case,text,{evaluatedOutput:f.answer}),{code:'INVALID_JUDGE_ASSESSMENT'});
  }
});

test('OCI provider sends one exact frozen request, journals before assertions and retains telemetry',async()=>{
  assert.equal(typeof adapter.evaluateRequest,'function');let calls=0,received=false;
  const request={modelId:'configured-oci',messages:[{role:'USER',content:'Literal {{template}} $text'}],settings:{maxCompletionTokens:2048}},original=response(JSON.stringify(f.answer));
  const result=await adapter.evaluateRequest({stage:'GENERATE',c:f.case,request,identity:{taskId:'task',attemptId:'attempt'},call:async options=>{calls++;assert.deepEqual(options,request);return original;},onReceived:async r=>{assert.equal(r,original);received=true;},guard:async()=>{}});
  assert.equal(calls,1);assert.equal(received,true);assert.equal(result.response,original);
  assert.equal(result.evaluation.requestId,'saved-request');assert.deepEqual(result.evaluation.usage,original.usage);
  assert.equal(result.evaluation.cached,false);
});

test('provider errors keep their classification and never cause hidden retries',async()=>{
  assert.equal(typeof adapter.evaluateRequest,'function');
  const error=Object.assign(new Error('Throttled'),{statusCode:429,code:'HTTP_429',retryAfterMs:90000});let calls=0;
  await assert.rejects(()=>adapter.evaluateRequest({stage:'GENERATE',c:f.case,request:{},call:async()=>{calls++;throw error;}}),e=>e===error);
  assert.equal(calls,1);
});

test('cancelled providers never send requests and lost leases never accept received results',async()=>{
  assert.equal(typeof adapter.evaluateRequest,'function');let calls=0,checks=0,journaled=0;
  const lost=()=>Object.assign(new Error('Lease lost'),{code:'LEASE_LOST'});
  await assert.rejects(()=>adapter.evaluateRequest({stage:'GENERATE',c:f.case,request:{},guard:async()=>{throw lost();},call:async()=>{calls++;}}),{code:'LEASE_LOST'});
  assert.equal(calls,0);
  await assert.rejects(()=>adapter.evaluateRequest({stage:'GENERATE',c:f.case,request:{},guard:async()=>{if(++checks>1)throw lost();},call:async()=>{calls++;return response(JSON.stringify(f.answer));},onReceived:async()=>{journaled++;}}),{code:'LEASE_LOST'});
  assert.equal(calls,1);assert.equal(journaled,1,'receipt must survive loss of lease after response');
});

test('release execution retains 600 answers and 1200 independently identified dependent judges',()=>{
  const cases=Array.from({length:100},(_,i)=>({id:`case-${i}`})),tasks=evaluationTaskSpecs('release',cases);
  assert.equal(tasks.filter(t=>t.stage==='GENERATE').length,600);
  assert.equal(tasks.filter(t=>t.stage==='JUDGE').length,1200);
  assert.equal(new Set(tasks.map(t=>t.id)).size,1800);
  for(const judge of tasks.filter(t=>t.stage==='JUDGE'))assert.equal(judge.payload.outputId,judge.dependsOn);
});

test('concurrent Promptfoo attempts keep provider responses, findings and assessment identities separate',async()=>{
  const results=await Promise.all(Array.from({length:24},async(_,i)=>{
    const stage=i%2?'JUDGE':'GENERATE',identity={taskId:`concurrent-${i}`,attemptId:`attempt-${i}`,assessment:i%2?i%3%2:undefined};
    const judgment={...structuredClone(f.judge),scores:{...f.judge.scores,tone:i%4}};
    const saved={...response(JSON.stringify(stage==='JUDGE'?judgment:f.answer)),requestId:`request-${i}`};let calls=0;
    const actual=await adapter.evaluateRequest({stage,c:f.case,evaluatedOutput:f.answer,identity,request:{},call:async()=>{
      calls++;await new Promise(resolve=>setTimeout(resolve,(24-i)%5));return saved;
    }});
    assert.equal(calls,1);assert.equal(actual.response,saved);assert.equal(actual.evaluation.taskId,identity.taskId);
    assert.equal(actual.evaluation.requestId,`request-${i}`);
    if(stage==='JUDGE')assert.equal(actual.value.assessmentResult.scores.tone,i%4);
    return actual;
  }));
  assert.equal(new Set(results.map(r=>r.evaluation.requestId)).size,24);
});
