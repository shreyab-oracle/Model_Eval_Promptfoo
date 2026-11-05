import {repository} from '../db/repository.mjs';
import {comparison} from './runs.mjs';
import {assessOutput} from '../domain/decision.mjs';
import {callLedgerStatus} from '../optimization/ledger.mjs';
import {OPTIMIZER_DIGEST} from '../optimization/version.mjs';

export function historySummary(bundle,prompt){
  const {run,snapshot,result,progress}=bundle;
  return{id:run.id,kind:run.kind,status:run.status,createdAt:run.createdAt,historical:!!bundle.historical,decision:result.decision,decisionBasis:bundle.decisionBasis||'Current evaluation summary',
    models:Object.fromEntries(['baseline','candidate','judge'].map(role=>[role,{id:snapshot.models[role],displayName:snapshot.modelMetadata[role]?.displayName||snapshot.models[role]}])),
    prompt:{id:snapshot.promptId,version:prompt?.version||null},dataset:snapshot.dataset.version,policy:snapshot.policy.version,
    improvements:result.complete?result.comparisons.filter(c=>c.change==='IMPROVEMENT').map(c=>c.id):null,
    regressions:result.complete?result.comparisons.filter(c=>c.change==='REGRESSION').map(c=>c.id):null,
    reasons:result.reasons,pendingReviews:result.pendingReviews,criticalFailures:result.criticalCandidateFailures||0,outcomes:result.outcomes,criticalFindings:result.criticalFindings,reviewPolicyVersion:result.reviewPolicyVersion,
    pendingEvidence:Object.entries(bundle.evidence||{}).filter(([,approved])=>!approved).map(([key])=>key),
    reviewItems:(bundle.historical?[]:bundle.outputs||[]).filter(o=>assessOutput(o,bundle.reviews).pending).map(o=>{const index=snapshot.dataset.cases?.findIndex(c=>c.id===o.caseId);return{outputId:o.id,caseId:o.caseId,category:snapshot.dataset.cases?.[index]?.category,caseIndex:index>=0?index:undefined,role:o.role,repeat:o.repeat};}),
    executionErrors:progress.failed,progress};
}
export async function evaluationHistory(){
  const rows=[];
  for(const run of (await repository.runs()).filter(r=>r.kind!=='improvement')){
    try{
      // Comparison validates a current saved report without reloading every trace.
      // Saving a report and the CLI gate still verify all required artifacts.
      const b=await comparison(run.id,{verifyCompleted:false});
      if(b.historical)b.decisionBasis='Original historical report; prepare a new run for current eligibility';
      else if(b.artifactVerification?.verified)b.decisionBasis='Current results with a validated saved report';
      rows.push(historySummary(b,await repository.doc(b.snapshot.promptId)));
    }catch(e){rows.push({id:run.id,status:run.status,kind:run.kind,createdAt:run.createdAt,error:e.message});}
  }
  return rows;
}
export async function optimizationHistory(runs){
  const rows=[];
  for(const run of (runs||await repository.runs()).filter(r=>r.kind==='improvement')){
    const manifest=await repository.doc(run.manifestId),snapshot=manifest?.snapshot;if(!snapshot?.optimizer)continue;
    const starts=await repository.docs('GEPA_CALL_START',run.id),results=await repository.docs('GEPA_CALL_RESULT',run.id),tasks=await repository.tasks(run.id);
    const active=run.status==='RUNNING'?tasks.find(t=>t.stage==='PROPOSE'&&t.status==='RUNNING'):null;
    rows.push({...run,optimizer:snapshot.optimizer.name,optimizerCurrent:snapshot.optimizer.digest===OPTIMIZER_DIGEST,limits:snapshot.optimizer.limits,sourceRunId:snapshot.sourceRunId,candidateModel:snapshot.source.modelMetadata.candidate,promptId:snapshot.source.promptId,...callLedgerStatus(starts,results,{activeCycle:active?.cycle,leaseUntil:active?.leaseUntil}),evaluationErrors:results.filter(r=>r.evaluationFailure).map(r=>r.error),errors:tasks.filter(t=>t.error).map(t=>t.error),candidates:(await repository.docs('GEPA_CANDIDATE',run.id)).map(c=>({id:c.id,text:c.text,rationale:c.rationale,iteration:c.iteration}))});
  }
  return rows;
}
