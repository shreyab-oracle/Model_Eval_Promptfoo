import {randomUUID} from 'node:crypto';
import {outputFindings} from '../evaluation/findings.mjs';
import {repository} from '../db/repository.mjs';
import {config} from '../config.mjs';
import {digest} from '../domain/policy.mjs';
import {parseJSON} from '../domain/checks.mjs';
import {validateJudge,judgeTemplates,judgeInput} from '../domain/judge.mjs';
import {modelInput} from '../domain/policy.mjs';
import {chatBody,parseChatResponse} from '../oracle/genai.mjs';
import {ENGINE_DIGEST,assertFrozenEngine} from '../domain/version.mjs';
import {evaluationTaskSpecs,assertReportReady} from './task-policy.mjs';
import {decideRun,assessOutput} from '../domain/decision.mjs';
import {RUBRIC_VERSION,REVIEW_POLICY_VERSION} from '../domain/judge.mjs';
import {datasetById} from './datasets.mjs';
import {putJSON,getJSON} from '../oracle/storage.mjs';
import {modelMetadata} from '../oracle/genai.mjs';
import {assertOptimizer} from '../optimization/version.mjs';
import {settingsForModel,settingsForRole} from '../domain/model-settings.mjs';
import {observeModelAnswer,MODEL_ANSWER_HANDLING_VERSION} from './model-answer.mjs';
import {EXECUTION_PROTOCOL_VERSION,assertExecutionProtocol} from './execution-protocol.mjs';
import {recoverReceivedAnswers} from './received-recovery.mjs';
import {receiptDigest} from './response-journal.mjs';
import {runnerIdentity,assertFrozenRunner} from '../evaluation/version.mjs';
import {evaluateTask} from '../evaluation/task.mjs';

export async function createRun({datasetId,promptId,policyId,baselineModelId,candidateModelId,judgeModelId,settings,modelSettings:frozenSettings,id=randomUUID(),allowProposed=false}){
  const previous=await repository.run(id);if(previous)return previous;
  const d=await datasetById(datasetId),prompt=await repository.doc(promptId),policy=await repository.doc(policyId);
  if(prompt?.kind!=='PROMPT'||policy?.kind!=='POLICY')throw new Error('Select immutable prompt and policy versions');
  if(d.dataset.policyVersion!==policy.policy.version)throw new Error('Dataset and policy versions do not match');
  if(prompt.generated&&!(await repository.docs('PROMPT_APPROVAL',prompt.id)).some(a=>a.approved)&&!(allowProposed&&d.dataset.kind==='development'))throw new Error('Generated prompts require explicit approval before selection');
  const models={baseline:baselineModelId||config.models.baseline,candidate:candidateModelId||config.models.candidate,judge:judgeModelId||config.models.judge};
  if(Object.values(models).some(x=>!x))throw new Error('Baseline, candidate and judge model identifiers are required');
  const chosen=settings||config.settings,modelSettings={},metadata={};
  for(const role of Object.keys(models)){
    const m=await modelMetadata(models[role]);if(m.lifecycleState!=='ACTIVE')throw new Error(`${role} model is not ACTIVE`);
    metadata[role]={id:m.id,displayName:m.displayName,vendor:m.vendor,version:m.version,lifecycleState:m.lifecycleState};
    modelSettings[role]=settingsForModel(m,{openai:chosen,gemini:config.geminiSettings},frozenSettings?.[role]);
  }
  const snapshot={schemaVersion:4,runner:runnerIdentity(),executionProtocolVersion:EXECUTION_PROTOCOL_VERSION,runId:id,datasetId,promptId,policyId,datasetDigest:digest(d.dataset),labelDigest:d.labelDigest,promptDigest:digest(prompt.text),policyDigest:digest(policy.policy),models,modes:config.modes,modelMetadata:metadata,settings:chosen,judgeSettings:modelSettings.judge,modelSettings,rubricVersion:RUBRIC_VERSION,judgeCandidateOverlap:models.judge===models.candidate,judgeFamilyOverlap:{baseline:modelSettings.judge.family===modelSettings.baseline.family,candidate:modelSettings.judge.family===modelSettings.candidate.family},repeats:3,assessments:2,datasetKind:d.dataset.kind,compartmentId:config.compartment,genaiEndpoint:config.genaiEndpoint,genaiRegion:config.genaiRegion,dataset:d.dataset,prompt:prompt.text,policy:policy.policy};
  snapshot.reviewPolicyVersion=REVIEW_POLICY_VERSION;snapshot.engineDigest=ENGINE_DIGEST;snapshot.judgeTemplates=judgeTemplates(policy.policy);snapshot.judgeTemplateDigest=digest(snapshot.judgeTemplates);
  const artifact=await putJSON('snapshots',id,snapshot);await getJSON(artifact);
  const manifestId=await repository.saveDoc({kind:'MANIFEST',parentId:id,value:{snapshot,artifact}}),tasks=[];
  tasks.push(...evaluationTaskSpecs(id,d.dataset.cases));
  await repository.createRun({id,manifestId,kind:d.dataset.kind,tasks});return repository.run(id);
}
export async function startRun(id){await snapshotFor(id,true);await repository.startRun(id);return repository.run(id);}
export async function resumeRun(id){await snapshotFor(id,true);await recoverReceivedAnswers(id);await repository.resume(id);return repository.run(id);}
async function snapshotFor(id,verify=false){const run=await repository.run(id);if(!run)throw new Error('Run not found');const manifest=await repository.doc(run.manifestId);if(!manifest)throw new Error('Run manifest missing');const value=verify?await getJSON(manifest.artifact):manifest.snapshot;if(digest(value)!==digest(manifest.snapshot))throw new Error('Frozen manifest mismatch');if(verify){assertFrozenEngine(value.source||value);assertExecutionProtocol(value.source||value);if(value.optimizer)assertOptimizer(value);}return{run,manifest,snapshot:value};}
export async function runBundle(id){
  const {run,manifest,snapshot}=await snapshotFor(id),outputDocs=await repository.docs('OUTPUT',id),judges=await repository.docs('JUDGE',id),reviews=await repository.docs('REVIEW',id),evidenceDocs=[...await repository.docs('EVIDENCE',id),...await repository.docs('EVIDENCE',snapshot.datasetId)];
  const provenance=o=>o.responseSource||(o.recoveryKind==='LOCAL_JOURNAL'?'SAVED_RESPONSE':null);
  const outputs=outputDocs.map(o=>({...o,responseSource:provenance(o),
    findings:outputFindings(o,{evaluatorVersion:snapshot.runner?.evaluatorVersion??null,policyReference:snapshot.policy?.version??null}),
    judges:judges.filter(j=>j.outputId===o.id).sort((a,b)=>a.assessment-b.assessment).map(j=>({...j.assessmentResult,assessment:j.assessment,id:j.id,
      evaluation:j.evaluation,responseSource:provenance(j),requestId:j.requestId,trace:j.trace,usage:j.usage,latencyMs:j.latencyMs}))}));
  const evidence={};for(const type of ['labels','calibration','release']){const latest=evidenceDocs.find(e=>e.type===type&&e.targetDigest===(type==='labels'?snapshot.labelDigest:manifest.digest));evidence[type]=latest?.approved===true;}
  const tasks=await repository.tasks(id),attempts=await repository.attempts(id);
  const inputDigest=digest({manifest:manifest.digest,outputs:outputDocs.map(o=>[o.id,o.digest]).sort(),judges:judges.map(o=>[o.id,o.digest]).sort(),reviews:reviews.map(o=>[o.id,o.digest]).sort(),evidence:evidenceDocs.map(o=>[o.id,o.digest]).sort(),status:run.status});
  return{run,manifest,snapshot,outputs,judges,reviews,evidence,evidenceDocs,tasks,attempts,inputDigest};
}
export async function verifyBundle(b,{report=true,loadArtifact=getJSON,loadDataset=datasetById,loadDocument=repository.doc}={}){
  assertFrozenEngine(b.snapshot);assertExecutionProtocol(b.snapshot);
  const expected=evaluationTaskSpecs(b.run.id,b.snapshot.dataset.cases),tasks=new Map(b.tasks.map(t=>[t.id,t]));
  if(expected.length!==b.tasks.length)throw new Error('Frozen task set is incomplete or contains extra tasks');
  for(const e of expected){const t=tasks.get(e.id);if(!t||['stage','caseId','role','repeat','assessment','dependsOn'].some(k=>(t[k]??null)!==(e[k]??null)))throw new Error('Task identity differs from the frozen evaluation plan');}
  const recoveredSources=new Set([...b.outputs,...b.judges].filter(o=>o.processingAttemptId&&o.recoveryKind==='LOCAL_JOURNAL').map(o=>o.sourceAttemptId));
  if(b.attempts.some(a=>a.status==='UNCERTAIN'&&['GENERATE','JUDGE'].includes(tasks.get(a.taskId)?.stage)&&!recoveredSources.has(a.id)))throw new Error('A previous model request has an unresolved outcome; complete received evidence is required');
  const stored=await loadArtifact(b.manifest.artifact);if(digest(stored)!==digest(b.snapshot))throw new Error('Frozen snapshot differs from stored manifest');
  if(digest(b.snapshot.dataset)!==b.snapshot.datasetDigest||digest(b.snapshot.prompt)!==b.snapshot.promptDigest||digest(b.snapshot.policy)!==b.snapshot.policyDigest)throw new Error('Frozen input digest mismatch');
  const dataset=await loadDataset(b.snapshot.datasetId);await loadArtifact(dataset.artifact);
  const seenAttempts=new Set();
  const records=[...b.outputs,...b.judges];
  for(let offset=0;offset<records.length;offset+=4)await Promise.all(records.slice(offset,offset+4).map(async output=>{
    if(!output.trace)throw new Error('Required output/judge trace missing');const trace=await loadArtifact(output.trace);
    const {text}=parseChatResponse(trace.raw,trace.requestId);
    const task=tasks.get(output.id),attempt=b.attempts.find(a=>a.id===trace.attemptId);
    const processing=output.processingAttemptId&&b.attempts.find(a=>a.id===output.processingAttemptId);
    const divergentAttempt=processing&&b.attempts.some(a=>a.taskId===output.id&&a.id!==attempt?.id&&a.id!==processing.id&&(['RUNNING','DONE'].includes(a.status)||a.cycle>processing.cycle||(a.cycle===processing.cycle&&a.attempt>processing.attempt)));
    const expectedReceipt=receiptDigest({taskId:output.id,runId:b.run.id,attemptId:trace.attemptId,stage:task?.stage},trace);
    const reconciled=['FAILED','UNCERTAIN'].includes(attempt?.status)&&output.sourceAttemptId===attempt.id&&output.handlingVersion===MODEL_ANSWER_HANDLING_VERSION&&output.recoveryKind==='LOCAL_JOURNAL'&&output.journalDigest===expectedReceipt&&attempt.receiptRecovered===true&&attempt.journalDigest===expectedReceipt&&processing?.status==='DONE'&&processing.taskId===output.id&&processing.modelCall===false&&processing.sourceAttemptId===attempt.id&&processing.handlingVersion===MODEL_ANSWER_HANDLING_VERSION&&processing.recoveryKind==='LOCAL_JOURNAL'&&processing.journalDigest===expectedReceipt&&processing.cycle===attempt.cycle&&processing.attempt===attempt.attempt+1&&processing.cycle===task?.cycle&&processing.attempt===task?.attempts&&!divergentAttempt&&digest(processing.sourceTrace)===digest(output.trace)&&digest(attempt.trace)===digest(output.trace);
    if(seenAttempts.has(trace.attemptId))throw new Error('Separate outputs and judge assessments must have distinct committed attempts');seenAttempts.add(trace.attemptId);
    if(trace.taskId!==output.id||!text||!task||task.status!=='DONE'||!attempt||(attempt.status!=='DONE'&&!reconciled)||attempt.taskId!==task.id)throw new Error('Output/task/attempt trace identity mismatch or invalid reconciliation provenance');
    if(output.processingAttemptId&&!reconciled)throw new Error('Invalid processing-only reconciliation provenance');
    if(output.caseId!==task.caseId||output.role!==task.role||output.repeat!==task.repeat)throw new Error('Output case, model role or repetition mismatch');
    const c=b.snapshot.dataset.cases.find(c=>c.id===task.caseId);
    if(output.kind==='JUDGE'&&(output.outputId!==task.dependsOn||output.assessment!==task.assessment))throw new Error('Judge slot/dependency identity mismatch');
    const messages=output.kind==='OUTPUT'?modelInput(c,b.snapshot.prompt,b.snapshot.policy):judgeInput(c,b.outputs.find(o=>o.id===output.outputId)?.response,output.assessment,b.snapshot.policy,b.snapshot.judgeTemplates);
    const role=output.kind==='OUTPUT'?output.role:'judge';
    const request=chatBody({modelId:b.snapshot.models[role],mode:b.snapshot.modes[role],messages,settings:settingsForRole(b.snapshot,role),compartmentId:b.snapshot.compartmentId});
    if(digest(request)!==trace.requestDigest||digest(trace.requestBody)!==trace.requestDigest||trace.endpoint!==b.snapshot.genaiEndpoint)throw new Error('Frozen request settings/messages differ from the recorded OCI request');
    if(b.snapshot.runner){
      const evaluated=await evaluateTask({snapshot:b.snapshot,task:{...task,runId:b.run.id,attemptId:trace.attemptId},
        loadDocument:async id=>b.outputs.find(o=>o.id===id),receivedResponse:{...parseChatResponse(trace.raw,trace.requestId),raw:trace.raw,requestId:trace.requestId,latencyMs:trace.latencyMs,usage:trace.usage}});
      if(digest(evaluated.evaluation)!==digest(output.evaluation))throw new Error('Stored Promptfoo assertion evidence differs from the frozen trace');
    }
    if(output.kind==='OUTPUT'){
      const observed=observeModelAnswer(c,text);
      if(!!observed.modelContractFailure!==!!output.modelContractFailure)throw new Error('Model contract-failure marker differs from the original answer format');
      if(observed.modelContractFailure&&(output.rawText!==text||output.modelContractFailure.code!==observed.modelContractFailure.code||output.handlingVersion!==MODEL_ANSWER_HANDLING_VERSION))throw new Error('Model contract-failure evidence differs from the original received answer');
      if(digest(observed.response)!==digest(output.response))throw new Error('Stored output differs from original OCI trace');
      if(digest(observed.checks)!==digest(output.checks))throw new Error('Stored deterministic checks differ from recomputed checks');
    }else if(digest(validateJudge(parseJSON(text),b.outputs.find(o=>o.id===output.outputId)?.response))!==digest(output.assessmentResult))throw new Error('Stored judge differs from original OCI trace');
  }));
  if(report){const doc=b.run.reportId&&await loadDocument(b.run.reportId);if(!doc||doc.report.inputDigest!==b.inputDigest)throw new Error('A current release report is required; generate it after all reviews/evidence changes');const value=await loadArtifact(doc.artifact);if(digest(value)!==digest(doc.report))throw new Error('Report digest mismatch');}
  return true;
}
export async function readSavedReport(b,{loadDocument=repository.doc,loadArtifact=getJSON}={}){
  if(b.run.status!=='COMPLETED'||!b.run.reportId)return null;
  const doc=await loadDocument(b.run.reportId);
  if(doc?.kind!=='REPORT'||doc.parentId!==b.run.id||doc.report?.runId!==b.run.id||doc.report.manifestDigest!==b.manifest.digest||doc.report.inputDigest!==b.inputDigest)return null;
  const report=await loadArtifact(doc.artifact);if(digest(report)!==digest(doc.report))throw new Error('Saved report digest mismatch');return report;
}
export async function comparison(id,{verify=false,requireReport=true,verifyCompleted=false}={}){
  const b=await runBundle(id);let verified=false,artifactError,verificationMode='pending',savedReport;
  if(!isCurrentEvaluation(b.snapshot)){
    const historical=await historicalComparison(b);
    return{...b,...historical,progress:progressFor(b),metrics:metricsFor(b)};
  }
  try{
    if(verify||(verifyCompleted&&b.run.status==='COMPLETED')){verified=await verifyBundle(b,{report:requireReport});verificationMode='full';}
    else if(b.run.status==='COMPLETED'){assertFrozenEngine(b.snapshot);assertExecutionProtocol(b.snapshot);savedReport=await readSavedReport(b);verified=!!savedReport;verificationMode=verified?'saved-report':'pending';}
  }catch(e){artifactError=e.message;}
  const result=decideRun({...b.run,datasetKind:b.snapshot.datasetKind,artifactsVerified:verified},b.snapshot.dataset.cases,b.outputs,b.reviews,b.evidence);
  if(artifactError)result.reasons.unshift(artifactError);
  return{...b,outputs:b.outputs.map(o=>({...o,assessment:assessOutput(o,b.reviews)})),result,progress:progressFor(b),artifactVerification:{verified,mode:verificationMode,reportGeneratedAt:savedReport?.generatedAt||null},metrics:metricsFor(b)};
}
const progressFor=b=>({done:b.tasks.filter(t=>t.status==='DONE').length,total:b.tasks.length,failed:b.tasks.filter(t=>t.status==='FAILED').length,running:b.tasks.filter(t=>t.status==='RUNNING').length});
function metricsFor(b){const usage=b.outputs.map(o=>o.usage).filter(Boolean),latencies=b.outputs.map(o=>o.latencyMs).filter(Number.isFinite).sort((a,b)=>a-b);return{p95LatencyMs:latencies.length?latencies[Math.min(latencies.length-1,Math.ceil(latencies.length*.95)-1)]:null,usageKnown:usage.length,usageUnknown:b.outputs.length-usage.length};}
export function isCurrentEvaluation(snapshot){try{assertFrozenEngine(snapshot);assertFrozenRunner(snapshot);assertExecutionProtocol(snapshot);return true;}catch{return false;}}

// Historical decisions come from original versioned reports, never today's rules.
export async function historicalComparison(b,{loadDocument=repository.doc,loadArtifact=getJSON}={}){
  const doc=b.run.reportId&&await loadDocument(b.run.reportId);
  let report;
  if(doc?.kind==='REPORT'&&doc.parentId===b.run.id&&doc.report?.runId===b.run.id&&doc.report.manifestDigest===b.manifest.digest){
    report=await loadArtifact(doc.artifact);
    if(digest(report)!==digest(doc.report))throw new Error('Historical report digest mismatch');
  }
  const result=report?.result||{decision:'REVIEW',complete:false,total:b.snapshot?.dataset?.cases?.length||0,baseline:0,candidate:0,categories:{},comparisons:[],criticalCandidateFailures:0,pendingReviews:0,reasons:['Historical evaluator evidence has no readable saved decision. Prepare a new run for current eligibility.']};
  return{result,historical:true,eligibilityRequiresNewRun:true,
    artifactVerification:{verified:!!report,mode:'historical-report',reportGeneratedAt:report?.generatedAt||null}};
}
export async function writeReport(id){
  const b=await runBundle(id);assertReportReady(b);await verifyBundle(b,{report:false});
  const result=decideRun({...b.run,datasetKind:b.snapshot.datasetKind,artifactsVerified:true},b.snapshot.dataset.cases,b.outputs,b.reviews,b.evidence);
  const modelContractFailures=b.outputs.filter(o=>o.modelContractFailure).map(o=>({caseId:o.caseId,role:o.role,repeat:o.repeat,error:o.modelContractFailure,trace:o.trace,sourceAttemptId:o.sourceAttemptId||null,processingAttemptId:o.processingAttemptId||null,handlingVersion:o.handlingVersion}));
  const executionSummary={unresolvedTaskFailures:b.tasks.filter(t=>t.status==='FAILED').length,recordedFailedAttempts:b.attempts.filter(a=>a.status==='FAILED').length,recoveredReceivedResults:b.attempts.filter(a=>a.modelCall===false&&a.recoveryKind==='LOCAL_JOURNAL').length,unrecoveredUncertainAttempts:b.attempts.filter(a=>a.status==='UNCERTAIN'&&!a.receiptRecovered).length};
  const report={schemaVersion:2,executionProtocolVersion:b.snapshot.executionProtocolVersion,runId:id,generatedAt:new Date().toISOString(),manifestDigest:b.manifest.digest,inputDigest:b.inputDigest,
    modelAnswerHandlingVersion:MODEL_ANSWER_HANDLING_VERSION,modelContractFailures,
    judgeCandidateOverlap:b.snapshot.judgeCandidateOverlap,judgeFamilyOverlap:b.snapshot.judgeFamilyOverlap,
    evidence:b.evidence,result,executionSummary,executionErrors:b.tasks.filter(t=>t.error).map(t=>({id:t.id,error:t.error})),attempts:b.attempts};
  report.runner=b.snapshot.runner;report.engineDigest=b.snapshot.engineDigest;report.reviewPolicyVersion=b.snapshot.reviewPolicyVersion;
  const artifact=await putJSON('reports',id,report);await getJSON(artifact);
  const docId=await repository.saveDoc({kind:'REPORT',parentId:id,value:{report,artifact}});await repository.setReport(id,docId);
  return{reportId:docId,artifact,result};
}
export async function reviewOutput({runId,outputId,resolution,reason,actor},{store=repository}={}){
  if(!['CONFIRM_CRITICAL','ACCEPT_OUTPUT','REJECT_OUTPUT'].includes(resolution)||!reason?.trim())throw new Error('Review resolution and rationale required');
  const output=await store.doc(outputId);if(!['OUTPUT','GEPA_OUTPUT'].includes(output?.kind)||output.parentId!==runId)throw new Error('Output does not belong to this run');
  const judges=output.kind==='GEPA_OUTPUT'?output.judges:(await store.docs('JUDGE',runId)).filter(j=>j.outputId===outputId).map(j=>({...j.assessmentResult,assessment:j.assessment}));
  if(judges?.length!==2||![0,1].every(slot=>judges.some(j=>j.assessment===slot)))throw new Error('Wait for two valid committed judge assessments before adjudication');
  try{for(const j of judges)validateJudge(j,output.response);}catch{throw new Error('Wait for two valid committed judge assessments before adjudication');}
  const run=await store.run(runId),manifest=await store.doc(run.manifestId);
  if(!isCurrentEvaluation(manifest.snapshot.source||manifest.snapshot))throw new Error('Historical evidence retains its original decision; create a new run before current review');
  if(resolution==='ACCEPT_OUTPUT'&&output.checks.some(c=>c.status!=='PASS'&&c.confirmed))throw new Error('Human acceptance cannot waive deterministic policy or calculation failures');
  if(resolution==='ACCEPT_OUTPUT'&&(await store.docs('REVIEW',runId)).some(r=>r.outputId===outputId&&r.resolution==='CONFIRM_CRITICAL'))throw new Error('A confirmed critical finding is permanent for this run and cannot be waived by later acceptance');
  return store.saveDoc({kind:'REVIEW',parentId:runId,value:{outputId,resolution,reason,actor}});
}
export async function reviewQueue(){const queue=[];for(const r of await repository.runs()){
  const optimization=r.kind==='improvement',b=optimization?{outputs:await repository.docs('GEPA_OUTPUT',r.id),reviews:await repository.docs('REVIEW',r.id)}:await runBundle(r.id);
  const source=optimization?(await repository.doc(r.manifestId))?.snapshot?.source:b.snapshot;
  const historical=!isCurrentEvaluation(source||{}),reviewPolicyVersion=source?.reviewPolicyVersion||'score-difference-v1';
  const caseMetadata=new Map((source?.dataset?.cases||[]).map((c,caseIndex)=>[c.id,{caseIndex,category:c.category}]));
  for(const o of b.outputs){const a=assessOutput(o,b.reviews,{reviewPolicyVersion});let reviewReady=!historical&&!!o.response&&!o.error&&o.judges?.length===2&&[0,1].every(slot=>o.judges.some(j=>j.assessment===slot));try{if(reviewReady)for(const j of o.judges)validateJudge(j,o.response);}catch{reviewReady=false;}if(a.pending||a.critical)queue.push({runId:r.id,outputId:o.id,caseId:o.caseId,...caseMetadata.get(o.caseId),role:o.role,repeat:o.repeat,optimization,historical,reviewReady,reviewPolicyVersion,...a,checks:o.checks,judges:o.judges,...(optimization?{caseFacts:o.caseFacts,response:o.response,promptDigest:o.promptDigest}:{})});}
}return queue;}
