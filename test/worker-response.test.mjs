import test from 'node:test';
import assert from 'node:assert/strict';
import {responseRetryDisposition} from '../src/services/worker.mjs';
import {parseJudgeAssessment} from '../src/evaluation/assertions.mjs';
import {retryDisposition} from '../src/services/task-policy.mjs';

test('malformed AI review JSON gets a recorded retryable reviewer error',()=>{
  let error;try{parseJudgeAssessment('{"scores":',{});}catch(e){error=e;}
  assert.equal(error.code,'INVALID_JUDGE_ASSESSMENT');
  assert.equal(retryDisposition(error,1,'JUDGE').retry,true);
  assert.equal(retryDisposition(error,3,'JUDGE').retry,false);
  assert.equal(retryDisposition(error,1,'GENERATE').retry,false);
});
test('a fabricated reviewer quote remains invalid and can receive a bounded new assessment',()=>{
  const value={scores:{policy:2,evidence:2,tone:2,clarity:2,nextSteps:2},critical:false,rationale:'Checks the facts.',evidence:[{quote:'Invented words',axis:'evidence',reason:'Unsupported quote'}]};
  assert.throws(()=>parseJudgeAssessment(JSON.stringify(value),{reply:'Actual invoice answer'}),e=>e.code==='INVALID_JUDGE_ASSESSMENT'&&/quote/i.test(e.message));
});
test('valid poor or critical reviewer findings are accepted unchanged rather than retried',()=>{
  const value={scores:{policy:0,evidence:1,tone:2,clarity:2,nextSteps:1},critical:true,criticalReason:'A required hold was removed.',rationale:'Unsafe recommendation in the answer.',evidence:[{quote:'Remove the hold',axis:'policy',reason:'Bypasses a required control'}]};
  assert.deepEqual(parseJudgeAssessment(JSON.stringify(value),{reply:'Remove the hold'}),value);
  assert.equal(retryDisposition({code:'INVALID_OUTPUT_SCHEMA'},1,'GENERATE').retry,false);
});
test('received answers cannot be resampled after a database or storage interruption',()=>{
  for(const stage of ['GENERATE','JUDGE'])for(const code of ['ECONNRESET','NJS-040','LEASE_LOST'])assert.deepEqual(responseRetryDisposition({stage,attempts:1},{code},{received:true,persistedTrace:true}),{retry:false,delayMs:0});
  assert.deepEqual(responseRetryDisposition({stage:'GENERATE',attempts:1},{statusCode:429}),{retry:true,delayMs:30000});
});
test('only an already persisted invalid AI review can request a new assessment',()=>{
  const task={stage:'JUDGE',attempts:1},error={code:'INVALID_JUDGE_ASSESSMENT'};
  assert.equal(responseRetryDisposition(task,error,{received:true,persistedTrace:true}).retry,true);
  assert.equal(responseRetryDisposition(task,error,{received:true,persistedTrace:false}).retry,false);
});
