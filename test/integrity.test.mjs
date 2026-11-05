import test from 'node:test';
import assert from 'node:assert/strict';
import {verifiedPayload,readAttempt} from '../src/db/repository.mjs';
import {canonical,digest} from '../src/domain/policy.mjs';
test('immutable database payload digest detects tampering',()=>{
  const value={status:'UNKNOWN'};assert.deepEqual(verifiedPayload(JSON.stringify(value),digest(value)),value);
  assert.throws(()=>verifiedPayload('{"status":"PAID"}',digest(value)),/digest mismatch/);
});

test('Oracle attempt dates retain their timestamps in canonical report artifacts',()=>{
  const startedAt='2026-11-02T09:10:11.123Z',finishedAt='2026-11-02T09:10:41.456Z';
  const attempt=readAttempt({ID:'attempt-1',TASK_ID:'task-1',STATUS:'DONE',RETRY_CYCLE:1,ATTEMPT_NUMBER:2,STARTED_AT:new Date(startedAt),FINISHED_AT:new Date(finishedAt),RESULT:JSON.stringify({latencyMs:30333,trace:{key:'trace-1'}})});
  const saved=JSON.parse(canonical({attempts:[attempt]})).attempts[0];
  assert.equal(saved.startedAt,startedAt);assert.equal(saved.finishedAt,finishedAt);
  assert.equal(saved.id,'attempt-1');assert.equal(saved.taskId,'task-1');assert.equal(saved.cycle,1);assert.equal(saved.attempt,2);
  assert.equal(saved.latencyMs,30333);assert.deepEqual(saved.trace,{key:'trace-1'});
});

test('unfinished Oracle attempts retain a null completion timestamp in reports',()=>{
  const attempt=readAttempt({ID:'attempt-2',TASK_ID:'task-2',STATUS:'RUNNING',RETRY_CYCLE:0,ATTEMPT_NUMBER:1,STARTED_AT:new Date('2026-11-02T09:10:11.123Z'),FINISHED_AT:null,RESULT:null});
  const saved=JSON.parse(canonical({attempts:[attempt]})).attempts[0];
  assert.equal(saved.startedAt,'2026-11-02T09:10:11.123Z');assert.equal(saved.finishedAt,null);
});
