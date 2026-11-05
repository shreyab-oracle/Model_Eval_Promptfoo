import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {evaluationTaskSpecs} from '../src/services/task-policy.mjs';
import {POLICY,INITIAL_PROMPT,digest} from '../src/domain/policy.mjs';
import {judgeTemplates} from '../src/domain/judge.mjs';
import {runnerIdentity,assertFrozenRunner} from '../src/evaluation/version.mjs';
import {ENGINE_DIGEST} from '../src/domain/version.mjs';
import {EXECUTION_PROTOCOL_VERSION} from '../src/services/execution-protocol.mjs';
import * as worker from '../src/services/worker.mjs';
const integration=await import('../src/evaluation/task.mjs').catch(()=>({}));
const f=JSON.parse(fs.readFileSync(new URL('./fixtures/promptfoo-parity.json',import.meta.url)));
const templates=judgeTemplates(POLICY);
const snapshot={runId:'durable-run',dataset:{cases:[f.case]},prompt:INITIAL_PROMPT,policy:POLICY,judgeTemplates:templates,
  models:{baseline:'baseline',candidate:'candidate',judge:'judge'},modes:{baseline:'ON_DEMAND',candidate:'ON_DEMAND',judge:'ON_DEMAND'},settings:{maxCompletionTokens:2048,verbosity:'MEDIUM'},compartmentId:'compartment',genaiEndpoint:'https://oci.oraclecloud.com'};
const plan=evaluationTaskSpecs(snapshot.runId,[f.case]);
const claimed=task=>({...task,runId:snapshot.runId,attemptId:`attempt-${task.id}`,owner:'worker',status:'RUNNING'});

test('durable task adapter binds each judge to the accepted output and exact assessment slot',async()=>{
  assert.equal(typeof integration.evaluateTask,'function');
  const task=claimed(plan.find(t=>t.stage==='JUDGE'&&t.assessment===1)),output={id:task.dependsOn,parentId:snapshot.runId,kind:'OUTPUT',caseId:f.case.id,role:task.role,repeat:task.repeat,response:f.answer};let calls=0;
  const actual=await integration.evaluateTask({snapshot,task,loadDocument:async()=>output,call:async request=>{calls++;assert.equal(request.modelId,'judge');assert.equal(request.messages[0].content,templates[1]);assert.deepEqual(JSON.parse(request.messages[1].content).evaluatedOutput,f.answer);return{text:JSON.stringify(f.judge)};}});
  assert.equal(calls,1);assert.equal(actual.value.outputId,output.id);assert.equal(actual.value.assessment,1);
  assert.deepEqual(actual.value.assessmentResult,f.judge);assert.equal(actual.evaluation.attemptId,task.attemptId);
});

test('wrong judge dependency, output identity and frozen task identity stop before calls',async()=>{
  assert.equal(typeof integration.evaluateTask,'function');let calls=0;
  const task=claimed(plan.find(t=>t.stage==='JUDGE')),output={id:task.dependsOn,parentId:snapshot.runId,kind:'OUTPUT',caseId:f.case.id,role:task.role,repeat:task.repeat,response:f.answer};
  for(const bad of [{...output,id:'other'},{...output,repeat:2},{...output,parentId:'other-run'},null])await assert.rejects(()=>integration.evaluateTask({snapshot,task,loadDocument:async()=>bad,call:async()=>{calls++;}}),/dependency|output/i);
  await assert.rejects(()=>integration.evaluateTask({snapshot,task:{...task,payload:{outputId:'wrong'}},loadDocument:async()=>output,call:async()=>{calls++;}}),/dependency/i);
  await assert.rejects(()=>integration.evaluateTask({snapshot,task:{...task,id:'wrong'},loadDocument:async()=>output,call:async()=>{calls++;}}),/task/i);
  assert.equal(calls,0);
});

test('receipt callback precedes assertion and failed persistence prevents any accepted observation',async()=>{
  assert.equal(typeof integration.evaluateTask,'function');const task=claimed(plan.find(t=>t.stage==='GENERATE'));let received=0,calls=0;
  const error=Object.assign(new Error('Object Storage unavailable'),{code:'ECONNRESET'});
  await assert.rejects(()=>integration.evaluateTask({snapshot,task,call:async()=>{calls++;return{text:JSON.stringify(f.answer)};},onReceived:async(response,request)=>{received++;assert.equal(response.text,JSON.stringify(f.answer));assert.equal(request.modelId,'baseline');throw error;}}),e=>e===error);
  assert.equal(received,1);assert.equal(calls,1);
});

test('runner identity freezes package, adapter and evaluator and rejects drift or removal',()=>{
  const runner=runnerIdentity();assert.equal(runner.version,'0.125.1');assert.match(runner.adapterDigest,/^[a-f0-9]{64}$/);
  assert.doesNotThrow(()=>assertFrozenRunner({runner}));
  for(const bad of [undefined,{...runner,version:'other'},{...runner,adapterDigest:digest('other')},{...runner,cache:true}])assert.throws(()=>assertFrozenRunner({runner:bad}),{code:'RUNNER_VERSION_MISMATCH'});
});
test('worker compatibility selection excludes historical runs before claims or settlement',async()=>{
  assert.equal(typeof worker.eligibleWorkerRuns,'function');
  const current={...snapshot,schemaVersion:4,runner:runnerIdentity(),engineDigest:ENGINE_DIGEST,executionProtocolVersion:EXECUTION_PROTOCOL_VERSION,judgeTemplateDigest:digest(templates)};
  const runs=[{id:'current',manifestId:'current-manifest',kind:'release'},{id:'legacy',manifestId:'legacy-manifest',kind:'release'},{id:'diagnostic',manifestId:'diagnostic-manifest',kind:'diagnostic'}];
  const manifests={'current-manifest':{snapshot:current},'legacy-manifest':{snapshot:{...current,engineDigest:'old-engine'}}};
  const selected=await worker.eligibleWorkerRuns(runs,{loadManifest:async id=>manifests[id]});
  assert.deepEqual(selected.map(r=>r.id),['current']);
});
