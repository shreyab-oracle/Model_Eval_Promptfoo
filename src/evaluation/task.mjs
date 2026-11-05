import {digest,modelInput} from '../domain/policy.mjs';
import {judgeInput} from '../domain/judge.mjs';
import {settingsForRole} from '../domain/model-settings.mjs';
import {evaluateRequest} from './adapter.mjs';

export async function prepareTask({snapshot,task,loadDocument}){
  const c=snapshot.dataset.cases.find(c=>c.id===task.caseId);
  if(!c||task.runId!==snapshot.runId||!['baseline','candidate'].includes(task.role)||![0,1,2].includes(task.repeat))throw new Error('Task differs from frozen evaluation plan');
  const generation=digest({run:snapshot.runId,case:c.id,role:task.role,repeat:task.repeat,stage:'GENERATE'});
  const isJudge=task.stage==='JUDGE';
  if(!['GENERATE','JUDGE'].includes(task.stage)||task.id!==(isJudge?digest({generation,assessment:task.assessment}):generation))throw new Error('Task identity differs from frozen evaluation plan');
  let evaluatedOutput,messages;
  if(isJudge){
    if(![0,1].includes(task.assessment)||task.dependsOn!==generation||task.payload?.outputId!==generation)throw new Error('Judge dependency differs from frozen plan');
    const output=await loadDocument(generation);
    if(output?.id!==generation||output.parentId!==snapshot.runId||output.kind!=='OUTPUT'||output.caseId!==c.id||output.role!==task.role||output.repeat!==task.repeat)throw new Error('Judge dependency output is missing or belongs to another answer');
    evaluatedOutput=output.response;
    messages=judgeInput(c,evaluatedOutput,task.assessment,snapshot.policy,snapshot.judgeTemplates);
  }else messages=modelInput(c,snapshot.prompt,snapshot.policy);
  const role=isJudge?'judge':task.role;
  const request={modelId:snapshot.models[role],mode:snapshot.modes[role],messages,settings:settingsForRole(snapshot,role),compartmentId:snapshot.compartmentId,endpoint:snapshot.genaiEndpoint};
  return{c,request,evaluatedOutput};
}

export async function evaluateTask({snapshot,task,loadDocument,...options}){
  const context=await prepareTask({snapshot,task,loadDocument});
  const result=await evaluateRequest({...options,...context,stage:task.stage,policyReference:snapshot.policy?.version??null,
    identity:{taskId:task.id,attemptId:task.attemptId,role:task.role,repeat:task.repeat,assessment:task.assessment},
    onReceived:response=>options.onReceived?.(response,context.request)});
  return{...result,value:{caseId:task.caseId,role:task.role,repeat:task.repeat,
    ...(task.stage==='JUDGE'?{outputId:task.dependsOn,assessment:task.assessment}:{}),...result.value}};
}
