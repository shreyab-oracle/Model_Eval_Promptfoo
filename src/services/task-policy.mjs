export function retryDisposition(error,attempt,stage){
  const throttled=error.statusCode===429||error.code==='429'||error.code==='HTTP_429';
  const transient=throttled||[408,500,502,503,504].includes(error.statusCode)||['ETIMEDOUT','ECONNRESET','EAI_AGAIN','ECONNREFUSED'].includes(error.code)||(stage==='JUDGE'&&error.code==='INVALID_JUDGE_ASSESSMENT');
  const retry=transient&&attempt<3;
  const delayMs=throttled?Math.min(300000,Math.max(30000*2**(attempt-1),Number(error.retryAfterMs)||0)):2000*2**(attempt-1);
  return{retry,delayMs:retry?delayMs:0};
}
export const canAutoReclaim=task=>task.stage==='RETEST';
export function assertReportReady(bundle){if(bundle.run.status!=='COMPLETED'||!bundle.tasks.length||bundle.tasks.some(task=>task.status!=='DONE'))throw Object.assign(new Error('Finish every evaluation step before saving the final report'),{code:'REPORT_NOT_READY',statusCode:409});}
export function gateExitCode(result,{expectedTarget,evaluatedTarget,currentEvidence=true}={}){const matches=!expectedTarget||(evaluatedTarget&&['baseline','candidate','judge'].every(role=>typeof expectedTarget.models?.[role]==='string'&&expectedTarget.models[role]&&evaluatedTarget.models?.[role]===expectedTarget.models[role])&&digest(expectedTarget)===digest(evaluatedTarget));return currentEvidence&&result?.decision==='ELIGIBLE FOR PILOT'&&result.complete===true&&matches?0:1;}
import {digest} from '../domain/policy.mjs';
export function evaluationTaskSpecs(runId,cases){const tasks=[];for(const c of cases)for(const role of ['baseline','candidate'])for(let repeat=0;repeat<3;repeat++){const generation=digest({run:runId,case:c.id,role,repeat,stage:'GENERATE'});tasks.push({id:generation,caseId:c.id,role,repeat,stage:'GENERATE'});for(let assessment=0;assessment<2;assessment++)tasks.push({id:digest({generation,assessment}),caseId:c.id,role,repeat,assessment,stage:'JUDGE',dependsOn:generation,payload:{outputId:generation}});}return tasks;}
