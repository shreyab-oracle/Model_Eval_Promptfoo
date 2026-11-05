import {config} from '../config.mjs';
import {comparison,isCurrentEvaluation} from './runs.mjs';
import {gateExitCode} from './task-policy.mjs';
import {settingsForModel,settingsForRole,validateModelSettings} from '../domain/model-settings.mjs';
import {runnerIdentity} from '../evaluation/version.mjs';
import {ENGINE_DIGEST} from '../domain/version.mjs';

function releaseTargets(snapshot){
  const roles=['baseline','candidate','judge'];
  const settings=Object.fromEntries(roles.map(role=>[role,settingsForModel(snapshot.modelMetadata[role],{openai:config.settings,gemini:config.geminiSettings})]));
  // Bind promotion to the evaluated immutable prompt/policy/data as well as the
  // configured model switch. An explicit expectedTarget can narrow this further.
  const frozen={promptId:snapshot.promptId,promptDigest:snapshot.promptDigest,policyId:snapshot.policyId,policyDigest:snapshot.policyDigest,
    datasetId:snapshot.datasetId,datasetDigest:snapshot.datasetDigest,labelDigest:snapshot.labelDigest,judgeTemplateDigest:snapshot.judgeTemplateDigest};
  return{expectedTarget:{...frozen,models:config.models,modes:config.modes,settings,endpoint:config.genaiEndpoint,compartment:config.compartment,runner:runnerIdentity(),engineDigest:ENGINE_DIGEST},
    evaluatedTarget:{...frozen,models:snapshot.models,modes:snapshot.modes,
      settings:Object.fromEntries(roles.map(role=>[role,validateModelSettings(settingsForRole(snapshot,role))])),
      endpoint:snapshot.genaiEndpoint,compartment:snapshot.compartmentId,runner:snapshot.runner,engineDigest:snapshot.engineDigest}};
}

export function releaseGateResult(bundle,{expectedTarget,evaluatedTarget,currentEvidence=!bundle.eligibilityRequiresNewRun}={}){
  const exitCode=gateExitCode(bundle.result,{expectedTarget,evaluatedTarget,currentEvidence});
  const reasons=[...bundle.result.reasons];
  if(!currentEvidence)reasons.unshift('Prepare a new Promptfoo evaluation for current release eligibility; the historical decision is retained separately.');
  else if(exitCode&&bundle.result.decision==='ELIGIBLE FOR PILOT')reasons.unshift('The evaluation does not match the exact configured promotion target.');
  return{...bundle.result,reasons,decision:exitCode&&bundle.result.decision==='ELIGIBLE FOR PILOT'?'REVIEW':bundle.result.decision,
    ...(!currentEvidence?{historicalDecision:bundle.result.decision}:{}),exitCode,
    ...(exitCode?{gateFailure:reasons[0]||'Release evidence is not eligible.'}:{})};
}
export async function releaseGate(id,{expectedTarget}={}){
  const bundle=await comparison(id,{verify:true}),currentEvidence=isCurrentEvaluation(bundle.snapshot)&&!bundle.eligibilityRequiresNewRun;
  const targets=currentEvidence?releaseTargets(bundle.snapshot):{};
  return releaseGateResult(bundle,{...targets,...(expectedTarget?{expectedTarget}:{}),currentEvidence});
}
