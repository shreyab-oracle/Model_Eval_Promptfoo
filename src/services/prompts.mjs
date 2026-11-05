import {repository} from '../db/repository.mjs';
import {digest} from '../domain/policy.mjs';
import {assertDevelopment,lineDiff} from '../domain/prompt.mjs';
import {runBundle,createRun} from './runs.mjs';
import {putJSON} from '../oracle/storage.mjs';
import {optimizationPlan,optimizationLimits} from '../domain/optimization.mjs';
import {OPTIMIZER_NAME,OPTIMIZER_VERSION,OPTIMIZER_DIGEST} from '../optimization/version.mjs';
import {verifyOptimizer} from '../optimization/runner.mjs';
import {assertFrozenEngine} from '../domain/version.mjs';

export async function createPrompt({text,parentId=null,version,actor}){
  if(typeof text!=='string'||text.trim().length<40||text.length>20000)throw new Error('Prompt must contain 40–20,000 characters');
  if(parentId&&(await repository.doc(parentId))?.kind!=='PROMPT')throw new Error('Parent prompt not found');
  return repository.saveDoc({kind:'PROMPT',parentId,version:version||`manual-${Date.now()}`,value:{text,generated:false,actor}});
}
export async function approvePrompt({promptId,reason,actor}){
  const p=await repository.doc(promptId);if(p?.kind!=='PROMPT'||!reason?.trim())throw new Error('Prompt and approval rationale required');
  return repository.saveDoc({kind:'PROMPT_APPROVAL',parentId:promptId,value:{approved:true,reason,actor,textDigest:digest(p.text)}});
}
export const improvementJobId=({sourceRunId,inputDigest,autoRetest,actor,optimizer})=>digest({operation:'improve',sourceRunId,inputDigest,autoRetest,actor,...(optimizer?{optimizer}:{})});
export async function proposeImprovement({sourceRunId,autoRetest=true,actor,limits}){
  const b=await runBundle(sourceRunId);assertDevelopment(b.snapshot.dataset);
  assertFrozenEngine(b.snapshot);
  const optimizer={name:OPTIMIZER_NAME,version:OPTIMIZER_VERSION,digest:OPTIMIZER_DIGEST,limits:optimizationLimits(limits),plan:optimizationPlan(b.snapshot.dataset)};
  await verifyOptimizer();
  if(!['COMPLETED','INCOMPLETE'].includes(b.run.status))throw new Error('Use a completed or incomplete development run with recorded failures');
  const failed=b.outputs.filter(o=>o.checks.some(c=>c.status==='FAIL')||o.judges.some(j=>j.critical||Object.values(j.scores).some(s=>s<2)));
  if(!failed.length)throw new Error('No completed development outputs with failures are available for improvement');
  const id=improvementJobId({sourceRunId,inputDigest:b.inputDigest,autoRetest,actor,optimizer});
  const previous=await repository.run(id);if(previous)return{jobId:id,reused:true,status:previous.status};
  const snapshot={jobType:'IMPROVEMENT',optimizer,sourceRunId,sourceManifestDigest:b.manifest.digest,autoRetest,actor,source:b.snapshot};
  const artifact=await putJSON('improvement-snapshots',id,snapshot),manifestId=await repository.saveDoc({kind:'IMPROVEMENT_MANIFEST',parentId:id,value:{snapshot,artifact}});
  const taskId=digest({id,stage:'PROPOSE'}),tasks=[{id:taskId,stage:'PROPOSE'}];if(autoRetest)tasks.push({id:digest({id,stage:'RETEST'}),stage:'RETEST',dependsOn:taskId,payload:{proposalId:taskId}});
  try{await repository.createRun({id,manifestId,kind:'improvement',tasks});}catch(e){if(e.errorNum!==1||!await repository.run(id))throw e;}
  if((await repository.run(id)).status==='DRAFT'){try{await repository.startRun(id);}catch(e){if((await repository.run(id)).status!=='RUNNING')throw e;}}
  return{jobId:id,optimizer:OPTIMIZER_NAME,maxOptimizationCalls:optimizer.limits.maxCalls,maxRetestCalls:autoRetest?b.snapshot.dataset.cases.length*18:0,autoRetest,developmentCaseCount:b.snapshot.dataset.cases.length};
}
export async function createRetest(snapshot,proposal,jobId){
  assertDevelopment(snapshot.source.dataset);
  const promptId=proposal.promptId||digest({proposal:proposal.id,text:proposal.text});
  if(!proposal.promptId)await repository.saveDoc({id:promptId,kind:'PROMPT',parentId:snapshot.source.promptId,version:`proposal-${proposal.id.slice(0,8)}`,value:{text:proposal.text,generated:true,proposalId:proposal.id,diff:proposal.diff}});
  const id=digest({jobId,operation:'development-retest'});
  await createRun({id,datasetId:snapshot.source.datasetId,promptId,policyId:snapshot.source.policyId,baselineModelId:snapshot.source.models.baseline,candidateModelId:snapshot.source.models.candidate,judgeModelId:snapshot.source.models.judge,settings:snapshot.source.settings,modelSettings:snapshot.source.modelSettings,allowProposed:true});
  // The worker atomically starts this draft with its fenced parent-task completion.
  // Cancellation or loss of the parent lease must never launch new model requests.
  return{runId:id,promptId};
}
export const IMPROVEMENT_INSTRUCTIONS='Propose clearer evaluator instructions using only the supplied DEVELOPMENT failures. The demonstration policy is immutable and is supplied separately to the tested model. Do not alter policy, financial tolerances, output contract, evidence requirements or reference labels. Do not embed answers, case-specific amounts, invoice IDs or supplier names into the prompt. Return only JSON {"text":"complete improved reusable prompt","rationale":"explain instruction changes"}. This is a proposal; never claim it is active or deployed.';
export function validateProposal(value,snapshot){
  if(typeof value.text!=='string'||value.text.length<40||value.text.length>20000||typeof value.rationale!=='string'||value.rationale.length<10)throw new Error('Invalid prompt proposal contract');
  const cases=snapshot.source.dataset?.cases||[];
  for(const c of cases)for(const id of [c.id,c.invoice.id,c.po?.id,c.receipt?.id].filter(Boolean))if(value.text.includes(id))throw new Error('Proposal embeds a development-case identifier');
  return{text:value.text,rationale:value.rationale,diff:lineDiff(snapshot.source.prompt,value.text),sourceRunId:snapshot.sourceRunId,parentPromptId:snapshot.source.promptId,policyDigest:snapshot.source.policyDigest,policyReviewRequired:true};
}
