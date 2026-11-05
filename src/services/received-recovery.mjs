import {repository} from '../db/repository.mjs';
import {digest,modelInput} from '../domain/policy.mjs';
import {parseJSON} from '../domain/checks.mjs';
import {assertFrozenEngine} from '../domain/version.mjs';
import {judgeInput,validateJudge} from '../domain/judge.mjs';
import {settingsForRole} from '../domain/model-settings.mjs';
import {chatBody,parseChatResponse} from '../oracle/genai.mjs';
import {putJSON,getJSON} from '../oracle/storage.mjs';
import {evaluationTaskSpecs} from './task-policy.mjs';
import {assertExecutionProtocol} from './execution-protocol.mjs';
import {observeModelAnswer,MODEL_ANSWER_HANDLING_VERSION} from './model-answer.mjs';
import {responseJournal} from './response-journal.mjs';
import {evaluateTask} from '../evaluation/task.mjs';

const same=(a,b)=>digest({value:a})===digest({value:b});
const requireThat=(ok,message)=>{if(!ok)throw Object.assign(new Error(message),{code:'RECEIVED_RECOVERY_MISMATCH'});};
const later=(a,b)=>a.cycle>b.cycle||(a.cycle===b.cycle&&a.attempt>b.attempt);

async function verifiedArtifact(ref,loadArtifact){
  requireThat(typeof ref?.key==='string'&&/^[a-f0-9]{64}$/.test(ref.digest),'Required recovery artifact reference is invalid');
  const value=await loadArtifact(ref);
  requireThat(digest(value)===ref.digest,'Recovery artifact digest mismatch');return value;
}

function verifyEntry(entry,runId){
  const {schemaVersion,binding,trace}=entry;
  requireThat(schemaVersion===1&&binding?.runId===runId,'Journal belongs to a different run or schema');
  requireThat(entry.digest===digest({schemaVersion,binding,trace}),'Journal digest mismatch');
  requireThat(binding.taskId===trace?.taskId&&binding.attemptId===trace.attemptId,'Journal receipt identity mismatch');
  requireThat(trace.runId===undefined||trace.runId===runId,'Journal trace run identity mismatch');
  for(const key of ['runId','taskId','attemptId'])requireThat(entry[key]===undefined||entry[key]===binding[key],'Journal descriptor identity mismatch');
  requireThat(!binding.stage||binding.stage===trace.stage,'Journal stage binding mismatch');
  return {taskId:binding.taskId,attemptId:binding.attemptId};
}

async function frozenContext(runId,store,loadArtifact){
  const run=await store.run(runId);requireThat(run?.id===runId,'Recovery run is missing');
  const manifest=await store.doc(run.manifestId);
  requireThat(manifest?.id===run.manifestId&&manifest.kind==='MANIFEST'&&manifest.parentId===runId,'Recovery manifest identity mismatch');
  const snapshot=await verifiedArtifact(manifest.artifact,loadArtifact);
  requireThat(same(snapshot,manifest.snapshot)&&snapshot.runId===runId,'Frozen recovery snapshot mismatch');
  assertExecutionProtocol(snapshot);assertFrozenEngine(snapshot);
  requireThat(digest(snapshot.dataset)===snapshot.datasetDigest&&digest(snapshot.prompt)===snapshot.promptDigest&&digest(snapshot.policy)===snapshot.policyDigest,'Frozen recovery input digest mismatch');
  const tasks=await store.tasks(runId),attempts=await store.attempts(runId);
  const expected=new Map(evaluationTaskSpecs(runId,snapshot.dataset.cases).map(t=>[t.id,t]));
  return {run,snapshot,tasks,attempts,expected};
}

function taskForReceipt(context,taskId,attemptId,trace){
  const task=context.tasks.find(t=>t.id===taskId),expected=context.expected.get(taskId);
  requireThat(task?.runId===context.run.id&&expected&&['GENERATE','JUDGE'].includes(task.stage),'Journal task is not a frozen evaluation task');
  for(const key of ['stage','caseId','role','repeat','assessment','dependsOn'])requireThat((task[key]??null)===(expected[key]??null),'Recovery task differs from its frozen plan');
  const source=context.attempts.find(a=>a.id===attemptId);
  requireThat(source?.taskId===taskId&&trace.stage===task.stage,'Journal source attempt does not match its task');
  return {task,source};
}

async function observedDocument(context,task,trace,store){
  const snapshot=context.snapshot,c=snapshot.dataset.cases.find(c=>c.id===task.caseId);
  requireThat(c,'Frozen recovery case is missing');
  let messages,output;
  if(task.stage==='GENERATE')messages=modelInput(c,snapshot.prompt,snapshot.policy);
  else{
    requireThat(task.payload?.outputId===task.dependsOn,'Frozen judge dependency differs from its task payload');
    output=await store.doc(task.dependsOn);
    requireThat(output?.id===task.dependsOn&&output.kind==='OUTPUT'&&output.parentId===context.run.id,'Original tested model output is missing');
    messages=judgeInput(c,output.response,task.assessment,snapshot.policy,snapshot.judgeTemplates);
  }
  const role=task.stage==='GENERATE'?task.role:'judge',requestBody=chatBody({modelId:snapshot.models[role],mode:snapshot.modes[role],messages,settings:settingsForRole(snapshot,role),compartmentId:snapshot.compartmentId});
  requireThat(trace.modelId===snapshot.models[role]&&trace.endpoint===snapshot.genaiEndpoint&&trace.requestDigest===digest(requestBody)&&digest(trace.requestBody)===trace.requestDigest,'Journal request differs from the exact frozen model request');
  requireThat(typeof trace.requestId==='string'&&trace.requestId.trim(),'Journal request identifier is missing');
  const parsed=parseChatResponse(trace.raw,trace.requestId);
  let value;
  if(snapshot.runner){
    const evaluated=await evaluateTask({snapshot,task:{...task,attemptId:trace.attemptId},loadDocument:id=>store.doc(id),
      receivedResponse:{...parsed,raw:trace.raw,requestId:trace.requestId,latencyMs:trace.latencyMs,usage:trace.usage}});
    value={...evaluated.value,evaluation:evaluated.evaluation};
  }
  else if(task.stage==='GENERATE')value={caseId:task.caseId,role:task.role,repeat:task.repeat,...observeModelAnswer(c,parsed.text)};
  else{
    let assessmentResult;
    try{assessmentResult=validateJudge(parseJSON(parsed.text),output.response);}
    catch(error){throw Object.assign(error,{code:'INVALID_JUDGE_ASSESSMENT'});}
    value={outputId:output.id,assessment:task.assessment,caseId:task.caseId,role:task.role,repeat:task.repeat,assessmentResult};
  }
  return {id:task.id,kind:task.stage==='GENERATE'?'OUTPUT':'JUDGE',parentId:context.run.id,value:{...value,latencyMs:trace.latencyMs,usage:trace.usage,requestId:trace.requestId}};
}

function requireRecoverable(context,task,source){
  requireThat(task.status==='FAILED'&&['FAILED','UNCERTAIN'].includes(source.status),'Recovery requires a failed task and failed or uncertain source attempt');
  requireThat(task.cycle===source.cycle&&task.attempts===source.attempt,'Journal source is not the current task attempt');
  requireThat(!context.attempts.some(a=>a.taskId===task.id&&a.id!==source.id&&(later(a,source)||['RUNNING','DONE'].includes(a.status)||(a.cycle===source.cycle&&a.attempt===source.attempt))),'A competing or later task attempt prevents recovery');
}

async function requireFirstGenerationReceipt(context,task,source,loadArtifact){
  if(task.stage!=='GENERATE')return;
  for(const prior of context.attempts.filter(a=>a.taskId===task.id&&a.id!==source.id&&a.trace)){
    const trace=await verifiedArtifact(prior.trace,loadArtifact);
    requireThat(!trace.raw?.chatResponse,'An earlier generation attempt already received a model answer; refuse replacement');
  }
}

async function verifyCommitted(context,task,source,entry,expected,doc,loadArtifact){
  requireThat(doc?.id===expected.id&&doc.kind===expected.kind&&doc.parentId===expected.parentId&&task.status==='DONE','Committed recovery document identity or task state differs');
  for(const [key,value] of Object.entries(expected.value))requireThat(same(doc[key],value),'Committed output differs from the original received answer');
  const trace=await verifiedArtifact(doc.trace,loadArtifact);
  requireThat(same(trace,entry.trace)&&trace.attemptId===source.id,'Committed output references a different received answer');
  requireThat(source.trace?.key===doc.trace.key&&source.trace.digest===doc.trace.digest,'Committed source attempt references a different trace');
  if(doc.processingAttemptId){
    const processing=context.attempts.find(a=>a.id===doc.processingAttemptId);
    requireThat(doc.sourceAttemptId===source.id&&doc.recoveryKind==='LOCAL_JOURNAL'&&doc.journalDigest===entry.digest&&doc.handlingVersion===MODEL_ANSWER_HANDLING_VERSION,'Committed recovery provenance differs from the journal');
    requireThat(['FAILED','UNCERTAIN'].includes(source.status)&&processing?.status==='DONE'&&processing.taskId===task.id&&processing.modelCall===false&&processing.sourceAttemptId===source.id&&processing.recoveryKind==='LOCAL_JOURNAL'&&processing.journalDigest===entry.digest&&processing.handlingVersion===MODEL_ANSWER_HANDLING_VERSION&&same(processing.sourceTrace,doc.trace),'Processing attempt does not prove a committed local-journal recovery');
    requireThat(processing.cycle===source.cycle&&processing.attempt===source.attempt+1&&task.cycle===processing.cycle&&task.attempts===processing.attempt,'Committed recovery task position differs');
    requireThat(source.receiptRecovered===true&&source.journalDigest===entry.digest,'Source attempt does not record this recovered journal');
  }else requireThat(source.status==='DONE'&&(!doc.sourceAttemptId||doc.sourceAttemptId===source.id)&&task.cycle===source.cycle&&task.attempts===source.attempt,'Committed output does not belong to this completed source attempt');
  requireThat(!context.attempts.some(a=>a.taskId===task.id&&a.id!==source.id&&a.id!==doc.processingAttemptId&&(later(a,source)||['RUNNING','DONE'].includes(a.status))),'A competing attempt conflicts with the committed original answer');
}

async function retireRecordedInvalidJudge(task,source,entry,journal,loadArtifact){
  requireThat(task.status==='FAILED'&&source.status==='FAILED'&&source.error?.code==='INVALID_JUDGE_ASSESSMENT'&&source.trace,'Invalid judge receipt has no committed failed assessment evidence');
  const stored=await verifiedArtifact(source.trace,loadArtifact);
  requireThat(same(stored,entry.trace),'Failed judge attempt references a different received answer');
  await journal.clear(source.id,{remoteCommitted:true,expectedDigest:entry.digest});
}

// Recovery reprocesses an already received answer. It never samples a model.
export async function recoverReceivedAnswers(runId,{store=repository,journal=responseJournal,writeTrace=putJSON,loadArtifact=getJSON}={}){
  const entries=await journal.list(runId),result={recovered:0,alreadyCommitted:0,retiredInvalidJudges:0};
  if(!entries.length)return result;
  let context=await frozenContext(runId,store,loadArtifact);
  const identities=entries.map(entry=>({entry,...verifyEntry(entry,runId)})),taskIds=new Set();
  for(const receipt of identities){requireThat(!taskIds.has(receipt.taskId),'Multiple received answers exist for the same task; refuse replacement');taskIds.add(receipt.taskId);}
  for(const {entry,taskId,attemptId} of identities){
    let {task,source}=taskForReceipt(context,taskId,attemptId,entry.trace);
    const existing=await store.doc(task.id);let document;
    try{document=await observedDocument(context,task,entry.trace,store);}
    catch(error){
      if(error.code!=='INVALID_JUDGE_ASSESSMENT'||existing)throw error;
      requireRecoverable(context,task,source);
      // An invalid judge can only retire after its exact trace and format error
      // already committed. Otherwise preserve the journal and surface the error.
      if(source.status!=='FAILED'||source.error?.code!=='INVALID_JUDGE_ASSESSMENT'||!source.trace)throw error;
      await retireRecordedInvalidJudge(task,source,entry,journal,loadArtifact);result.retiredInvalidJudges++;continue;
    }
    if(existing){
      await verifyCommitted(context,task,source,entry,document,existing,loadArtifact);
      await journal.clear(attemptId,{remoteCommitted:true,expectedDigest:entry.digest});result.alreadyCommitted++;continue;
    }
    requireRecoverable(context,task,source);
    await requireFirstGenerationReceipt(context,task,source,loadArtifact);
    if(source.trace){const stored=await verifiedArtifact(source.trace,loadArtifact);requireThat(same(stored,entry.trace),'Existing failed source trace differs from journal receipt');}
    const trace=await writeTrace('traces',source.id,entry.trace);
    requireThat(same(await verifiedArtifact(trace,loadArtifact),entry.trace),'Persisted recovery trace differs from the journal receipt');
    document.value.trace=trace;
    await store.recoverReceivedAnswer({taskId,sourceAttemptId:source.id,document,handlingVersion:MODEL_ANSWER_HANDLING_VERSION,journalDigest:entry.digest});
    // A commit acknowledgment is insufficient to remove the only local receipt:
    // reread immutable output, attempts, and its remotely verified trace first.
    context={...context,tasks:await store.tasks(runId),attempts:await store.attempts(runId)};
    ({task,source}=taskForReceipt(context,taskId,attemptId,entry.trace));
    await verifyCommitted(context,task,source,entry,document,await store.doc(taskId),loadArtifact);
    await journal.clear(attemptId,{remoteCommitted:true,expectedDigest:entry.digest});result.recovered++;
  }
  return result;
}
