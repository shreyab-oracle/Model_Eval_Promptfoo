// Pure evidence fixtures with stubbed low-level storage reads only. No provider,
// database records, OCI model calls, or application fallback data are created.
import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyBundle} from '../src/services/runs.mjs';
import {generateDataset} from '../src/domain/dataset.mjs';
import {digest,expectedFor,modelInput,POLICY,INITIAL_PROMPT,sourceIds} from '../src/domain/policy.mjs';
import {ENGINE_DIGEST} from '../src/domain/version.mjs';
import {judgeTemplates,judgeInput} from '../src/domain/judge.mjs';
import {evaluationTaskSpecs} from '../src/services/task-policy.mjs';
import {chatBody} from '../src/oracle/genai.mjs';
import {checkOutput} from '../src/domain/checks.mjs';
import {EXECUTION_PROTOCOL_VERSION} from '../src/services/execution-protocol.mjs';
import {receiptDigest} from '../src/services/response-journal.mjs';
import {runnerIdentity} from '../src/evaluation/version.mjs';
import {evaluateTask} from '../src/evaluation/task.mjs';
function evidenceFixture({gemini=false}={}){
  const dataset=generateDataset({kind:'development'});dataset.cases=dataset.cases.slice(0,1);const c=dataset.cases[0];
  const snapshot={executionProtocolVersion:EXECUTION_PROTOCOL_VERSION,engineDigest:ENGINE_DIGEST,judgeTemplates:judgeTemplates(POLICY),dataset,runId:'UNIT-ONLY',datasetId:'DATASET',datasetDigest:digest(dataset),prompt:INITIAL_PROMPT,promptDigest:digest(INITIAL_PROMPT),policy:POLICY,policyDigest:digest(POLICY),models:{baseline:'b',candidate:'c',judge:'j'},modes:{baseline:'ON_DEMAND',candidate:'ON_DEMAND',judge:'ON_DEMAND'},settings:{maxCompletionTokens:2048,verbosity:'MEDIUM'},judgeSettings:{maxCompletionTokens:2048,verbosity:'MEDIUM'},compartmentId:'unit-compartment',genaiEndpoint:'https://inference.generativeai.us-chicago-1.oci.oraclecloud.com'};snapshot.judgeTemplateDigest=digest(snapshot.judgeTemplates);
  const candidateSettings={family:'gemini',maxTokens:6000,temperature:1,frequencyPenalty:0,presencePenalty:0,topP:0.95,fixedTopK:64};
  if(gemini)snapshot.modelSettings={baseline:{family:'openai',...snapshot.settings},candidate:candidateSettings,judge:{family:'openai',...snapshot.judgeSettings}};
  const artifacts=new Map(),save=(key,value)=>{artifacts.set(key,structuredClone(value));return{key,digest:digest(value)};};
  const datasetArtifact=save('dataset',dataset),manifestArtifact=save('manifest',snapshot),tasks=evaluationTaskSpecs(snapshot.runId,[c]).map(t=>({...t,status:'DONE'})),outputs=[],judges=[],attempts=[];
  function trace(task,response,messages,role){const requestBody=chatBody({modelId:snapshot.models[role],mode:snapshot.modes[role],messages,settings:gemini&&role==='candidate'?candidateSettings:snapshot.settings,compartmentId:snapshot.compartmentId}),attemptId=`attempt-${task.id}`;attempts.push({id:attemptId,taskId:task.id,status:'DONE'});return save(task.id,{taskId:task.id,attemptId,endpoint:snapshot.genaiEndpoint,requestBody,requestDigest:digest(requestBody),raw:{chatResponse:{choices:[{message:{content:[{type:'TEXT',text:JSON.stringify(response)}]}}]}}});}
  for(const task of tasks.filter(t=>t.stage==='GENERATE')){const response={...expectedFor(c),sources:sourceIds(c),nextStep:'Accounts Payable should continue normal review.',reply:'Your invoice matches the supplied records. Accounts Payable should continue normal approval. Payment is not confirmed.'};outputs.push({...task,kind:'OUTPUT',response,checks:checkOutput(c,response),trace:trace(task,response,modelInput(c,snapshot.prompt,POLICY),task.role)});}
  for(const task of tasks.filter(t=>t.stage==='JUDGE')){const output=outputs.find(o=>o.id===task.dependsOn),assessmentResult={scores:{policy:3,evidence:3,tone:3,clarity:3,nextSteps:3},critical:false,criticalReason:'',rationale:'The response preserves controls and describes a useful next step.',evidence:[{quote:'matches the supplied records',axis:'policy',reason:'The facts match'}]};judges.push({...task,kind:'JUDGE',outputId:output.id,assessmentResult,trace:trace(task,assessmentResult,judgeInput(c,output.response,task.assessment,POLICY,snapshot.judgeTemplates),'judge')});}
  for(const o of outputs)o.judges=judges.filter(j=>j.outputId===o.id).map(j=>({...j.assessmentResult,assessment:j.assessment}));
  const report={inputDigest:'current-input'},reportDoc={report,artifact:save('report',report)};
  const b={run:{id:snapshot.runId,status:'COMPLETED',reportId:'report'},snapshot,manifest:{artifact:manifestArtifact},tasks,outputs,judges,attempts,inputDigest:'current-input'};
  const io={loadArtifact:async ref=>{const value=artifacts.get(ref.key);if(!value)throw new Error('Required object missing');if(digest(value)!==ref.digest)throw new Error('Object digest mismatch');return structuredClone(value);},loadDataset:async()=>({artifact:datasetArtifact}),loadDocument:async()=>reportDoc};return{b,io,artifacts};
}

function formatFailureFixture({reconciled=false}={}){
  const f=evidenceFixture(),output=f.b.outputs.find(o=>o.role==='baseline'),c=f.b.snapshot.dataset.cases[0];
  const text='{"action":"NO_MATCHING_EXCEPTION", broken';
  const save=(ref,value)=>{f.artifacts.set(ref.key,value);ref.digest=digest(value);};
  const trace=f.artifacts.get(output.trace.key);trace.raw.chatResponse.choices[0].message.content[0].text=text;save(output.trace,trace);
  Object.assign(output,{response:text,rawText:text,checks:checkOutput(c,text),handlingVersion:'received-answer-v1',modelContractFailure:{code:'INVALID_MODEL_JSON',message:'Invalid JSON in the original answer'}});
  for(const judge of f.b.judges.filter(j=>j.outputId===output.id)){
    const assessment={scores:{policy:1,evidence:1,tone:2,clarity:1,nextSteps:1},critical:false,rationale:'The original answer is not a valid structured response.',evidence:[{quote:'NO_MATCHING_EXCEPTION',axis:'clarity',reason:'The answer is incomplete and malformed.'}]};
    judge.assessmentResult=assessment;const value=f.artifacts.get(judge.trace.key);
    value.requestBody=chatBody({modelId:f.b.snapshot.models.judge,mode:f.b.snapshot.modes.judge,messages:judgeInput(c,text,judge.assessment,POLICY,f.b.snapshot.judgeTemplates),settings:f.b.snapshot.judgeSettings,compartmentId:f.b.snapshot.compartmentId});value.requestDigest=digest(value.requestBody);value.raw.chatResponse.choices[0].message.content[0].text=JSON.stringify(assessment);save(judge.trace,value);
  }
  if(reconciled){
    const journalDigest=receiptDigest({taskId:output.id,runId:f.b.run.id,attemptId:trace.attemptId,stage:'GENERATE'},trace);
    const source=f.b.attempts.find(a=>a.id===trace.attemptId);Object.assign(source,{status:'UNCERTAIN',trace:output.trace,cycle:0,attempt:1,receiptRecovered:true,journalDigest,error:{code:'NJS-040',message:'Connection queue timeout after receipt'}});
    const processing={id:'processing-attempt',taskId:output.id,status:'DONE',cycle:0,attempt:2,modelCall:false,sourceAttemptId:source.id,sourceTrace:output.trace,handlingVersion:'received-answer-v1',recoveryKind:'LOCAL_JOURNAL',journalDigest};f.b.attempts.push(processing);
    Object.assign(f.b.tasks.find(t=>t.id===output.id),{cycle:0,attempts:2});
    Object.assign(output,{sourceAttemptId:source.id,processingAttemptId:processing.id,recoveryKind:'LOCAL_JOURNAL',journalDigest});
  }
  return{...f,output};
}

test('a received malformed answer remains an auditable failed observation with two real assessments',async()=>{
  const f=formatFailureFixture();assert.equal(await verifyBundle(f.b,f.io),true);assert.equal(f.output.checks[0].status,'FAIL');assert.equal(typeof f.output.response,'string');
});
test('processing-only reconciliation retains and binds the original failed source attempt',async()=>{
  const f=formatFailureFixture({reconciled:true});assert.equal(await verifyBundle(f.b,f.io),true);
  f.b.attempts.find(a=>a.id==='processing-attempt').sourceAttemptId='another-source';await assert.rejects(()=>verifyBundle(f.b,f.io),/attempt|provenance/i);
});
test('reconciled evidence rejects a later task cycle or divergent model attempt',async()=>{
  const f=formatFailureFixture({reconciled:true});f.b.tasks.find(t=>t.id===f.output.id).cycle=1;await assert.rejects(()=>verifyBundle(f.b,f.io),/provenance/i);
  const g=formatFailureFixture({reconciled:true});g.b.attempts.push({id:'replacement-model-attempt',taskId:g.output.id,status:'DONE',cycle:0,attempt:3});await assert.rejects(()=>verifyBundle(g.b,g.io),/provenance/i);
});
test('the exact original valid judge can be recovered without a replacement assessment',async()=>{
  const f=evidenceFixture(),output=f.b.judges[0],trace=f.artifacts.get(output.trace.key),source=f.b.attempts.find(a=>a.id===trace.attemptId);
  const journalDigest=receiptDigest({taskId:output.id,runId:f.b.run.id,attemptId:source.id,stage:'JUDGE'},trace);
  Object.assign(source,{status:'UNCERTAIN',cycle:0,attempt:1,trace:output.trace,receiptRecovered:true,journalDigest});
  Object.assign(output,{sourceAttemptId:source.id,processingAttemptId:'recovered-judge',recoveryKind:'LOCAL_JOURNAL',journalDigest,handlingVersion:'received-answer-v1'});
  Object.assign(f.b.tasks.find(t=>t.id===output.id),{cycle:0,attempts:2});
  f.b.attempts.push({id:'recovered-judge',taskId:output.id,status:'DONE',cycle:0,attempt:2,modelCall:false,sourceAttemptId:source.id,sourceTrace:output.trace,handlingVersion:'received-answer-v1',recoveryKind:'LOCAL_JOURNAL',journalDigest});
  assert.equal(await verifyBundle(f.b,f.io),true);
  output.journalDigest='0'.repeat(64);await assert.rejects(()=>verifyBundle(f.b,f.io),/provenance/i);
});
test('a fabricated contract-failure marker cannot bypass decoding or turn a valid answer into a failed source',async()=>{
  const f=evidenceFixture(),output=f.b.outputs[0];Object.assign(output,{rawText:JSON.stringify(output.response),handlingVersion:'received-answer-v1',modelContractFailure:{code:'INVALID_MODEL_JSON'}});
  await assert.rejects(()=>verifyBundle(f.b,f.io),/contract|format/i);
  const g=formatFailureFixture({reconciled:true});g.b.attempts.find(a=>a.id===g.output.sourceAttemptId).trace={key:'other-trace',digest:'other-digest'};await assert.rejects(()=>verifyBundle(g.b,g.io),/attempt|provenance/i);
});
test('complete evidence verifies both assessment slots and original request digests',async()=>{const f=evidenceFixture();assert.equal(await verifyBundle(f.b,f.io),true);});
test('an unrecorded earlier model or reviewer outcome prevents authoritative release evidence',async()=>{
  for(const stage of ['GENERATE','JUDGE']){const f=evidenceFixture(),task=f.b.tasks.find(t=>t.stage===stage);f.b.attempts.push({id:'unknown-earlier-request',taskId:task.id,status:'UNCERTAIN',cycle:0,attempt:0});await assert.rejects(()=>verifyBundle(f.b,f.io),/unresolved outcome/i);}
});
test('full evidence verification bounds parallel conversation reads and still verifies every output',async()=>{const f=evidenceFixture();let active=0,maximum=0,reads=0;const loadArtifact=f.io.loadArtifact;f.io.loadArtifact=async ref=>{if(f.b.outputs.some(o=>o.trace.key===ref.key)||f.b.judges.some(o=>o.trace.key===ref.key)){active++;maximum=Math.max(maximum,active);reads++;try{await new Promise(resolve=>setTimeout(resolve,5));return await loadArtifact(ref);}finally{active--;}}return loadArtifact(ref);};assert.equal(await verifyBundle(f.b,f.io),true);assert.equal(reads,18);assert.ok(maximum>1&&maximum<=4);});
test('evidence verification reconstructs Gemini candidate and GPT judge requests from their distinct frozen settings',async()=>{const f=evidenceFixture({gemini:true});const output=f.b.outputs.find(o=>o.role==='candidate'),wire=f.artifacts.get(output.id).requestBody.chatRequest;assert.equal(wire.maxTokens,6000);assert.equal('maxCompletionTokens' in wire,false);assert.equal(await verifyBundle(f.b,f.io),true);});
test('a missing or corrupt required object prevents authoritative eligibility',async()=>{const f=evidenceFixture();f.artifacts.delete(f.b.judges[0].trace.key);await assert.rejects(()=>verifyBundle(f.b,f.io),/missing/);const g=evidenceFixture();g.artifacts.get('report').inputDigest='tampered';await assert.rejects(()=>verifyBundle(g.b,g.io),/digest/);});
test('wrong judge slot or missing planned task fails evidence verification',async()=>{const f=evidenceFixture();f.b.judges[1].assessment=0;await assert.rejects(()=>verifyBundle(f.b,f.io),/slot/);const g=evidenceFixture();g.b.tasks.pop();await assert.rejects(()=>verifyBundle(g.b,g.io),/task set/);});
test('evaluator changes cannot be mixed into a frozen resumed run',async()=>{const f=evidenceFixture();f.b.snapshot.engineDigest='old-engine';await assert.rejects(()=>verifyBundle(f.b,f.io),/engine/i);});

test('new evidence replays every Promptfoo assertion from saved raw responses and rejects altered runner results',async()=>{
  const f=evidenceFixture();Object.assign(f.b.snapshot,{schemaVersion:4,runner:runnerIdentity()});
  f.artifacts.set('manifest',structuredClone(f.b.snapshot));f.b.manifest.artifact.digest=digest(f.b.snapshot);
  for(const output of [...f.b.outputs,...f.b.judges]){
    output.parentId=f.b.run.id;
    const trace=f.artifacts.get(output.trace.key),task=f.b.tasks.find(t=>t.id===output.id);
    const evaluated=await evaluateTask({snapshot:f.b.snapshot,task:{...task,runId:f.b.run.id,attemptId:trace.attemptId},loadDocument:async id=>f.b.outputs.find(o=>o.id===id),receivedResponse:{text:trace.raw.chatResponse.choices[0].message.content[0].text,raw:trace.raw}});
    output.evaluation=evaluated.evaluation;
  }
  assert.equal(await verifyBundle(f.b,f.io),true);
  f.b.outputs[0].evaluation.success=false;
  await assert.rejects(()=>verifyBundle(f.b,f.io),/Promptfoo assertion evidence/i);
});
