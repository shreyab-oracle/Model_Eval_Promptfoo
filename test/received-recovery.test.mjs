import test from 'node:test';
import assert from 'node:assert/strict';
import {recoverReceivedAnswers} from '../src/services/received-recovery.mjs';
import {EXECUTION_PROTOCOL_VERSION} from '../src/services/execution-protocol.mjs';
import {MODEL_ANSWER_HANDLING_VERSION,observeModelAnswer} from '../src/services/model-answer.mjs';
import {generateDataset} from '../src/domain/dataset.mjs';
import {digest,expectedFor,modelInput,POLICY,INITIAL_PROMPT,sourceIds} from '../src/domain/policy.mjs';
import {ENGINE_DIGEST} from '../src/domain/version.mjs';
import {judgeTemplates,judgeInput} from '../src/domain/judge.mjs';
import {evaluationTaskSpecs} from '../src/services/task-policy.mjs';
import {chatBody} from '../src/oracle/genai.mjs';
import {runnerIdentity} from '../src/evaluation/version.mjs';
import * as worker from '../src/services/worker.mjs';

function fixture({stage='GENERATE',text,sourceStatus='FAILED'}={}){
  const dataset=generateDataset({kind:'development'});dataset.cases=dataset.cases.slice(0,1);
  const c=dataset.cases[0],runId='UNIT-RECOVERY',settings={family:'openai',maxCompletionTokens:2048,verbosity:'MEDIUM'};
  const snapshot={executionProtocolVersion:EXECUTION_PROTOCOL_VERSION,engineDigest:ENGINE_DIGEST,runId,dataset,datasetDigest:digest(dataset),prompt:INITIAL_PROMPT,promptDigest:digest(INITIAL_PROMPT),policy:POLICY,policyDigest:digest(POLICY),judgeTemplates:judgeTemplates(POLICY),models:{baseline:'unit-baseline',candidate:'unit-candidate',judge:'unit-judge'},modes:{baseline:'ON_DEMAND',candidate:'ON_DEMAND',judge:'ON_DEMAND'},modelSettings:{baseline:settings,candidate:settings,judge:settings},compartmentId:'unit-compartment',genaiEndpoint:'https://inference.generativeai.us-chicago-1.oci.oraclecloud.com'};
  snapshot.judgeTemplateDigest=digest(snapshot.judgeTemplates);
  const run={id:runId,manifestId:'manifest',status:'INCOMPLETE'},artifacts=new Map(),documents=new Map(),actions=[];
  const save=(key,value)=>{artifacts.set(key,structuredClone(value));return {key,digest:digest(value)};};
  const manifest={id:'manifest',kind:'MANIFEST',parentId:runId,snapshot,artifact:save('unit/manifest',snapshot)};documents.set(manifest.id,manifest);
  const taskSpec=evaluationTaskSpecs(runId,[c]).find(t=>t.stage===stage),task={...taskSpec,runId,status:'FAILED',cycle:0,attempts:1};
  const source={id:'source-attempt',taskId:task.id,status:sourceStatus,cycle:0,attempt:1,error:{code:'LEASE_LOST',message:'Interrupted after receiving answer'}};
  const attempts=[source],tasks=[task];
  const response={...expectedFor(c),sources:sourceIds(c),nextStep:'Accounts Payable should continue normal review.',reply:'Your invoice matches the supplied records. Accounts Payable should continue normal approval. Payment is not confirmed.'};
  const assessment={scores:{policy:3,evidence:3,tone:3,clarity:3,nextSteps:3},critical:false,rationale:'The response preserves the controls and gives an appropriate next step.',evidence:[{quote:'matches the supplied records',axis:'policy',reason:'The supplied facts match.'}]};
  if(stage==='JUDGE')documents.set(task.dependsOn,{id:task.dependsOn,kind:'OUTPUT',parentId:runId,response});
  const role=stage==='JUDGE'?'judge':task.role,messages=stage==='JUDGE'?judgeInput(c,response,task.assessment,POLICY,snapshot.judgeTemplates):modelInput(c,INITIAL_PROMPT,POLICY);
  const requestBody=chatBody({modelId:snapshot.models[role],mode:snapshot.modes[role],messages,settings,compartmentId:snapshot.compartmentId});
  const received=text??JSON.stringify(stage==='JUDGE'?assessment:response);
  const trace={taskId:task.id,attemptId:source.id,stage,modelId:snapshot.models[role],endpoint:snapshot.genaiEndpoint,requestBody,requestDigest:digest(requestBody),requestId:'unit-original-request',latencyMs:123,usage:null,raw:{chatResponse:{choices:[{finishReason:'STOP',message:{content:[{type:'TEXT',text:received}]}}]}}};
  const binding={taskId:task.id,runId,attemptId:source.id,stage},entry={schemaVersion:1,binding,trace};
  const refreshEntry=()=>{entry.digest=digest({schemaVersion:entry.schemaVersion,binding:entry.binding,trace:entry.trace});};refreshEntry();
  const entries=[entry];let commits=0;
  const store={
    run:async()=>structuredClone(run),doc:async id=>structuredClone(documents.get(id)||null),tasks:async()=>structuredClone(tasks),attempts:async()=>structuredClone(attempts),
    async recoverReceivedAnswer(input){
      actions.push('commit');commits++;
      const processing={id:'processing-attempt',taskId:task.id,status:'DONE',cycle:source.cycle,attempt:source.attempt+1,modelCall:false,sourceAttemptId:source.id,sourceTrace:input.document.value.trace,handlingVersion:input.handlingVersion,recoveryKind:'LOCAL_JOURNAL',journalDigest:input.journalDigest};attempts.push(processing);
      Object.assign(source,{trace:input.document.value.trace,receiptRecovered:true,journalDigest:input.journalDigest});
      Object.assign(task,{status:'DONE',attempts:processing.attempt});
      const value={...input.document.value,sourceAttemptId:source.id,processingAttemptId:processing.id,handlingVersion:input.handlingVersion,recoveryKind:'LOCAL_JOURNAL',journalDigest:input.journalDigest};
      documents.set(task.id,{...input.document,...value,digest:digest(value)});return task.id;
    },
  };
  const journal={list:async id=>{assert.equal(id,runId);return structuredClone(entries);},clear:async(attemptId,options)=>{actions.push('clear');assert.equal(attemptId,source.id);assert.deepEqual(options,{remoteCommitted:true,expectedDigest:entry.digest});entries.splice(0,entries.length);return true;}};
  const io={store,journal,writeTrace:async(kind,id,value)=>{actions.push('write-trace');assert.equal(kind,'traces');assert.equal(id,source.id);return save(`unit/traces/${id}`,value);},loadArtifact:async ref=>{actions.push(`read:${ref.key}`);const value=artifacts.get(ref.key);if(!value)throw new Error('Unit artifact is missing');assert.equal(digest(value),ref.digest);return structuredClone(value);}};
  const refreshManifest=()=>{manifest.artifact=save('unit/manifest',snapshot);};
  const commitNormally=()=>{
    source.status='DONE';task.status='DONE';
    const value={...(stage==='JUDGE'?{outputId:task.dependsOn,assessment:task.assessment,caseId:task.caseId,role:task.role,repeat:task.repeat,assessmentResult:assessment}:{caseId:task.caseId,role:task.role,repeat:task.repeat,...observeModelAnswer(c,received)}),trace:save('unit/original-trace',trace),latencyMs:trace.latencyMs,usage:trace.usage,requestId:trace.requestId};
    documents.set(task.id,{id:task.id,kind:stage==='JUDGE'?'JUDGE':'OUTPUT',parentId:runId,...value,digest:digest(value)});
    source.trace=value.trace;
  };
  return {runId,run,snapshot,manifest,task,source,trace,entry,entries,attempts,documents,artifacts,actions,io,save,refreshEntry,refreshManifest,commitNormally,response,assessment,get commits(){return commits;}};
}

test('a failed generation recovers its exact first received answer without a model call',async()=>{
  const f=fixture();assert.deepEqual(await recoverReceivedAnswers(f.runId,f.io),{recovered:1,alreadyCommitted:0,retiredInvalidJudges:0});
  const output=f.documents.get(f.task.id);assert.deepEqual(output.response,f.response);assert.equal(output.sourceAttemptId,f.source.id);assert.equal(output.handlingVersion,MODEL_ANSWER_HANDLING_VERSION);
  assert.equal(f.source.status,'FAILED');assert.equal(f.attempts[1].modelCall,false);assert.equal(f.entries.length,0);assert.equal(f.actions.at(-1),'clear');assert.ok(f.actions.indexOf('write-trace')<f.actions.indexOf('commit'));assert.ok(f.actions.indexOf('commit')<f.actions.lastIndexOf(`read:unit/traces/${f.source.id}`));
});

for(const stage of ['GENERATE','JUDGE'])test(`Promptfoo ${stage} recovery replays the original receipt and preserves its attempt identity`,async()=>{
  const f=fixture({stage});Object.assign(f.snapshot,{schemaVersion:4,runner:runnerIdentity()});f.refreshManifest();
  if(stage==='JUDGE')Object.assign(f.documents.get(f.task.dependsOn),{caseId:f.task.caseId,role:f.task.role,repeat:f.task.repeat});
  await recoverReceivedAnswers(f.runId,f.io);
  const output=f.documents.get(f.task.id);assert.equal(output.evaluation.runner,'promptfoo');assert.equal(output.evaluation.attemptId,f.source.id);
  assert.equal(f.attempts[1].modelCall,false);assert.equal(f.entries.length,0);
});

test('a worker trace-write interruption preserves the exact receipt for explicit resume',async()=>{
  assert.equal(typeof worker.processTask,'function');
  const f=fixture();Object.assign(f.snapshot,{schemaVersion:4,runner:runnerIdentity()});f.refreshManifest();
  Object.assign(f.task,{attemptId:f.source.id,owner:'worker',status:'RUNNING'});let writes=0,calls=0;
  f.io.store.heartbeat=async()=>true;
  f.io.store.finish=async()=>assert.fail('Interrupted trace must not commit an accepted output');
  f.io.store.fail=async(task,error,retry,trace)=>{
    assert.equal(retry.retry,false,'received answer cannot be retried');
    Object.assign(f.source,{status:'FAILED',trace,error:{code:error.code,message:error.message}});f.task.status='FAILED';
  };
  const journal={...f.io.journal,persistResponse:async(task,trace)=>{
    assert.deepEqual(trace,f.entry.trace);return{digest:f.entry.digest};
  }};
  await worker.processTask(f.task,{store:f.io.store,loadArtifact:f.io.loadArtifact,journal,
    call:async()=>{calls++;return{text:JSON.stringify(f.response),raw:f.trace.raw,requestId:f.trace.requestId,latencyMs:f.trace.latencyMs,usage:f.trace.usage};},
    writeArtifact:async(kind,id,trace)=>{
      if(++writes===1)throw Object.assign(new Error('First trace write interrupted'),{code:'ECONNRESET'});
      return f.save(`unit/fallback/${id}`,trace);
    }});
  assert.equal(calls,1);assert.equal(writes,2);
  await recoverReceivedAnswers(f.runId,f.io);
  assert.equal(f.documents.get(f.task.id).response.reply,f.response.reply);assert.equal(f.attempts[1].modelCall,false);
});

test('a malformed tested model answer remains the original measured format failure',async()=>{
  const text='{"action":"NO_MATCHING_EXCEPTION", broken',f=fixture({text,sourceStatus:'UNCERTAIN'});
  await recoverReceivedAnswers(f.runId,f.io);const output=f.documents.get(f.task.id);
  assert.equal(output.response,text);assert.equal(output.rawText,text);assert.equal(output.modelContractFailure.code,'INVALID_MODEL_JSON');assert.equal(output.checks[0].status,'FAIL');assert.equal(f.source.status,'UNCERTAIN');
});

test('a valid judge receipt is recovered against the original tested answer and slot',async()=>{
  const f=fixture({stage:'JUDGE'});await recoverReceivedAnswers(f.runId,f.io);const doc=f.documents.get(f.task.id);
  assert.equal(doc.kind,'JUDGE');assert.equal(doc.outputId,f.task.dependsOn);assert.equal(doc.assessment,f.task.assessment);assert.deepEqual(doc.assessmentResult,f.assessment);
});

test('missing execution protocol or mismatched engine prevents recovery',async()=>{
  for(const change of [snapshot=>delete snapshot.executionProtocolVersion,snapshot=>{snapshot.engineDigest='older-engine';}]){
    const f=fixture();change(f.snapshot);f.refreshManifest();await assert.rejects(()=>recoverReceivedAnswers(f.runId,f.io),/differs/i);assert.equal(f.commits,0);assert.equal(f.entries.length,1);assert.ok(!f.actions.includes('write-trace'));
  }
});

test('request, endpoint, model and receipt binding mismatches stop before persistence',async()=>{
  const changes=[f=>{f.trace.endpoint='https://different.example';},f=>{f.trace.modelId='different-model';},f=>{f.trace.requestBody.chatRequest.messages[0].content[0].text='replacement';f.trace.requestDigest=digest(f.trace.requestBody);},f=>{f.trace.attemptId='another-attempt';},f=>{f.entry.binding.runId='another-run';}];
  for(const change of changes){const f=fixture();change(f);f.refreshEntry();await assert.rejects(()=>recoverReceivedAnswers(f.runId,f.io),{code:'RECEIVED_RECOVERY_MISMATCH'});assert.equal(f.commits,0);assert.equal(f.entries.length,1);assert.ok(!f.actions.includes('write-trace'));}
});

test('a nonlatest source or a live task cannot be recovered over',async()=>{
  for(const change of [f=>{f.task.attempts=2;},f=>{f.task.status='RUNNING';},f=>{f.attempts.push({id:'later',taskId:f.task.id,status:'FAILED',cycle:0,attempt:2});},f=>{f.task.role='candidate';}]){
    const f=fixture();change(f);await assert.rejects(()=>recoverReceivedAnswers(f.runId,f.io),{code:'RECEIVED_RECOVERY_MISMATCH'});assert.equal(f.commits,0);assert.equal(f.entries.length,1);
  }
});

test('an already committed matching answer only verifies and clears its journal',async()=>{
  const f=fixture();f.commitNormally();assert.deepEqual(await recoverReceivedAnswers(f.runId,f.io),{recovered:0,alreadyCommitted:1,retiredInvalidJudges:0});
  assert.equal(f.commits,0);assert.ok(!f.actions.includes('write-trace'));assert.equal(f.actions.at(-1),'clear');
});

test('an existing different answer or different source is never replaced or cleared',async()=>{
  for(const change of [f=>{f.documents.get(f.task.id).response.reply='A replacement answer';},f=>{f.trace.requestId='a-different-response';f.refreshEntry();}]){
    const f=fixture();f.commitNormally();change(f);await assert.rejects(()=>recoverReceivedAnswers(f.runId,f.io),{code:'RECEIVED_RECOVERY_MISMATCH'});assert.equal(f.commits,0);assert.equal(f.entries.length,1);assert.ok(!f.actions.includes('write-trace'));
  }
});

test('an uncertain commit retains the receipt and the next recovery only clears the committed answer',async()=>{
  const f=fixture(),commit=f.io.store.recoverReceivedAnswer;
  f.io.store.recoverReceivedAnswer=async input=>{await commit(input);throw Object.assign(new Error('Commit response was lost'),{code:'ECONNRESET'});};
  await assert.rejects(()=>recoverReceivedAnswers(f.runId,f.io),{code:'ECONNRESET'});assert.equal(f.entries.length,1);assert.equal(f.commits,1);
  assert.deepEqual(await recoverReceivedAnswers(f.runId,f.io),{recovered:0,alreadyCommitted:1,retiredInvalidJudges:0});assert.equal(f.commits,1);assert.equal(f.entries.length,0);
});

test('a remote verification failure after commit preserves the only local receipt',async()=>{
  const f=fixture(),read=f.io.loadArtifact;let fail=true;
  f.io.loadArtifact=async ref=>{if(f.commits&&fail&&ref.key.includes('/traces/')){fail=false;throw new Error('Remote verification unavailable');}return read(ref);};
  await assert.rejects(()=>recoverReceivedAnswers(f.runId,f.io),/verification unavailable/);assert.equal(f.commits,1);assert.equal(f.entries.length,1);
  await recoverReceivedAnswers(f.runId,f.io);assert.equal(f.commits,1);assert.equal(f.entries.length,0);
});

test('invalid judge output is never fabricated into an assessment or removed without committed error evidence',async()=>{
  const f=fixture({stage:'JUDGE',text:'{"scores":"not valid"}'});
  await assert.rejects(()=>recoverReceivedAnswers(f.runId,f.io),{code:'INVALID_JUDGE_ASSESSMENT'});assert.equal(f.entries.length,1);assert.equal(f.commits,0);assert.ok(!f.actions.includes('write-trace'));assert.equal(f.documents.has(f.task.id),false);
});

test('an invalid judge receipt retires only after its exact remote trace and format error already committed',async()=>{
  const f=fixture({stage:'JUDGE',text:'{"scores":"not valid"}'});f.source.error.code='INVALID_JUDGE_ASSESSMENT';f.source.trace=f.save('unit/failed-judge',f.trace);
  assert.deepEqual(await recoverReceivedAnswers(f.runId,f.io),{recovered:0,alreadyCommitted:0,retiredInvalidJudges:1});assert.equal(f.task.status,'FAILED');assert.equal(f.commits,0);assert.equal(f.entries.length,0);assert.ok(!f.actions.includes('write-trace'));
});

test('a conflicting preexisting failed trace cannot be substituted by a journal answer',async()=>{
  const f=fixture();f.source.trace=f.save('unit/different-trace',{...f.trace,requestId:'different-response'});
  await assert.rejects(()=>recoverReceivedAnswers(f.runId,f.io),{code:'RECEIVED_RECOVERY_MISMATCH'});assert.equal(f.entries.length,1);assert.equal(f.commits,0);
});

test('an earlier failed generation with a received answer cannot be replaced by a later receipt',async()=>{
  const f=fixture();f.task.attempts=2;f.source.attempt=2;
  f.attempts.push({id:'first-attempt',taskId:f.task.id,status:'FAILED',cycle:0,attempt:1,trace:f.save('unit/first-received-trace',{...f.trace,attemptId:'first-attempt',requestId:'first-received-request'})});
  await assert.rejects(()=>recoverReceivedAnswers(f.runId,f.io),/earlier generation.*refuse replacement/i);assert.equal(f.commits,0);assert.equal(f.entries.length,1);
});

test('a prior transport error without a received answer does not replace the first actual answer',async()=>{
  const f=fixture();f.task.attempts=2;f.source.attempt=2;
  f.attempts.push({id:'transport-attempt',taskId:f.task.id,status:'FAILED',cycle:0,attempt:1,trace:f.save('unit/transport-error',{taskId:f.task.id,attemptId:'transport-attempt',raw:null,error:{code:'ETIMEDOUT'}})});
  await recoverReceivedAnswers(f.runId,f.io);assert.equal(f.commits,1);assert.equal(f.entries.length,0);
});

test('corrupt journals and multiple receipts for one task stop rather than choose an answer',async()=>{
  const f=fixture();f.entry.digest='0'.repeat(64);await assert.rejects(()=>recoverReceivedAnswers(f.runId,f.io),/digest mismatch/i);assert.equal(f.commits,0);
  const g=fixture(),duplicate=structuredClone(g.entry);duplicate.binding.attemptId='second-attempt';duplicate.trace.attemptId='second-attempt';duplicate.digest=digest({schemaVersion:duplicate.schemaVersion,binding:duplicate.binding,trace:duplicate.trace});g.entries.push(duplicate);
  await assert.rejects(()=>recoverReceivedAnswers(g.runId,g.io),/Multiple received answers/);assert.equal(g.commits,0);assert.equal(g.entries.length,2);
});

test('empty or truncated received text stays an error and retains the journal',async()=>{
  for(const change of [f=>{f.trace.raw.chatResponse.choices[0].message.content=[];},f=>{f.trace.raw.chatResponse.choices[0].finishReason='MAX_TOKENS';}]){
    const f=fixture();change(f);f.refreshEntry();await assert.rejects(()=>recoverReceivedAnswers(f.runId,f.io),/textual|truncated/i);assert.equal(f.entries.length,1);assert.equal(f.commits,0);
  }
});
