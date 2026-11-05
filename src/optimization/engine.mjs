import {repository} from '../db/repository.mjs';
import {digest,modelInput} from '../domain/policy.mjs';
import {parseJSON,validateModelResponse} from '../domain/checks.mjs';
import {judgeInput,validateJudge} from '../domain/judge.mjs';
import {assessOutput} from '../domain/decision.mjs';
import {selectOptimizationCandidate} from '../domain/optimization.mjs';
import {assertOptimizer,OPTIMIZER_NAME} from './version.mjs';
import {runPromptfooOptimizer} from './runner.mjs';
import {createCallLedger} from './ledger.mjs';
import {chat} from '../oracle/genai.mjs';
import {getJSON,putJSON} from '../oracle/storage.mjs';
import {IMPROVEMENT_INSTRUCTIONS,validateProposal} from '../services/prompts.mjs';
import {settingsForRole} from '../domain/model-settings.mjs';
import {evaluateRequest} from '../evaluation/adapter.mjs';

function evaluationValidator(c,response){
  const judging=response!==undefined;
  return result=>{
    let parsed;
    try{parsed=parseJSON(result.text);}catch(error){throw Object.assign(new Error(`${judging?'Judge assessment':'Model answer'} is not a JSON object: ${error.message}`),{code:'INVALID_EVALUATION_JSON',evaluationFailure:true});}
    if(judging){
      try{return validateJudge(parsed,response);}catch(error){throw Object.assign(error,{code:'INVALID_JUDGE_ASSESSMENT',evaluationFailure:true});}
    }
    try{return validateModelResponse(c,parsed);}catch(error){
      if(error.code!=='INVALID_OUTPUT_SCHEMA')throw error;
      // Diagnostic guidance only. The shared checker remains the authority.
      const actions=['NO_MATCHING_EXCEPTION','RETAIN_HOLD','REQUEST_EVIDENCE','REVIEW'];
      if(!actions.includes(parsed.action))error.message+=`. action returned ${JSON.stringify(parsed.action)??'missing'}; expected one of ${actions.join(', ')}. Exception codes such as PRICE_TOLERANCE belong in holdReasons.`;
      const calculations=parsed.calculations;
      if(calculations)for(const key of ['billedTotalCents','quantityDiscrepancy','discrepancyAmountCents','priceDeltaCents']){
        if(!Number.isSafeInteger(calculations[key])&&!(key!=='billedTotalCents'&&calculations[key]===null))error.message+=` calculations.${key} returned ${JSON.stringify(calculations[key])??'missing'}; expected an integer${key==='billedTotalCents'?'':' or null'}.`;
      }
      throw Object.assign(error,{evaluationFailure:true});
    }
  };
}

export async function evaluateOptimizationCase({snapshot,jobId,text,c,invoke,store=repository,guard=async()=>{}}){
  // Keep the established document kinds and storage prefixes readable by old
  // records and reports. Promptfoo is the only active optimization engine.
  const source=snapshot.source,outputs=[];
  for(let repeat=0;repeat<3;repeat++){
    const id=digest({jobId,text,caseId:c.id,repeat}),old=await store.doc(id);
    if(old){outputs.push(old);continue;}
    const generated=await evaluateRequest({stage:'GENERATE',c,guard,policyReference:source.policy?.version??null,identity:{taskId:id,role:'candidate',repeat},
      request:{modelId:source.models.candidate,mode:source.modes.candidate,messages:modelInput(c,text,source.policy),settings:settingsForRole(source,'candidate'),compartmentId:source.compartmentId,endpoint:source.genaiEndpoint},
      call:request=>invoke(`generate/${c.id}/${repeat}`,request,evaluationValidator(c))});
    const response=generated.response,parsed=generated.value.modelContractFailure?.code==='INVALID_MODEL_JSON'?null:generated.value.response;
    const checks=generated.value.checks,judges=[],judgeErrors=[],judgeEvaluations=[];
    if(!response.evaluationError)for(let assessment=0;assessment<2;assessment++){
      const assessed=await evaluateRequest({stage:'JUDGE',c,evaluatedOutput:parsed,invalidJudgmentAsFeedback:true,guard,
        identity:{taskId:digest({id,assessment}),role:'candidate',repeat,assessment},
        request:{modelId:source.models.judge,mode:source.modes.judge,messages:judgeInput(c,parsed,assessment,source.policy,source.judgeTemplates),settings:settingsForRole(source,'judge'),compartmentId:source.compartmentId,endpoint:source.genaiEndpoint},
        call:request=>invoke(`judge/${c.id}/${repeat}/${assessment}`,request,evaluationValidator(c,parsed))});
      const judged=assessed.response;judgeEvaluations.push(assessed.evaluation);
      if(judged.evaluationError)judgeErrors.push({assessment,error:judged.evaluationError,rawText:judged.text,trace:judged.trace});
      else judges.push({...assessed.value.assessmentResult,assessment,responseSource:assessed.responseSource});
    }
    await guard();
    const value={caseId:c.id,role:'candidate',repeat,response:parsed,checks,judges,judgeErrors,evaluation:generated.evaluation,responseSource:generated.responseSource,judgeEvaluations,promptDigest:digest(text),caseFacts:c,latencyMs:response.latencyMs,usage:response.usage,trace:response.trace,
      ...(response.evaluationError?{error:response.evaluationError,rawText:response.text}:judgeErrors.length?{error:judgeErrors[0].error}:{})};
    await store.saveDoc({id,kind:'GEPA_OUTPUT',parentId:jobId,value});outputs.push({id,...value});
  }
  const assessments=outputs.map(o=>assessOutput(o));
  const executionErrors=outputs.reduce((n,o)=>n+(o.error?Math.max(1,o.judgeErrors?.length||0):0),0);
  const value={text,caseId:c.id,attempted:outputs.length===3,complete:outputs.length===3&&executionErrors===0&&outputs.every(o=>o.response&&o.judges.length===2),executionErrors,pass:assessments.every(a=>a.pass),critical:assessments.some(a=>a.critical||a.flagged),pending:assessments.some(a=>a.pending||a.disagreement),outputIds:outputs.map(o=>o.id),feedback:{facts:c,outputs:outputs.map(o=>({repeat:o.repeat,response:o.response,checks:o.checks,judges:o.judges,evaluation:o.evaluation,...(o.error?{error:o.error,rawText:o.rawText,judgeErrors:o.judgeErrors}:{} )}))}};
  await store.saveDoc({id:digest({jobId,text,caseId:c.id}),kind:'GEPA_EVALUATION',parentId:jobId,value});return value;
}

export function createOptimizationProposer({snapshot,jobId,invoke,store=repository,guard=async()=>{},loadTrace=getJSON}){
  let iteration=0;
  return async request=>{
    await guard();const slot=++iteration;
    if(slot>snapshot.optimizer.limits.maxProposals)throw new Error('Prompt optimization proposal limit exceeded');
    const parentPromptDigest=digest(request.text),saved=(await store.docs('GEPA_CANDIDATE',jobId)).filter(c=>c.iteration===slot);
    if(saved.length>1)throw new Error('Ambiguous saved proposal iteration; keep its evidence and start a new job.');
    if(saved.length){
      if(saved[0].parentPromptDigest!==parentPromptDigest)throw new Error('Saved proposal parent differs from the frozen search chain');
      const proposal=validateProposal(saved[0],snapshot);return{text:proposal.text,rationale:proposal.rationale,responseSource:'SAVED_RESPONSE'};
    }
    // A received suggestion may have been saved before its candidate document.
    // Recover by logical operation, not mutable feedback serialization.
    const operation=`propose/${slot}`,starts=(await store.docs('GEPA_CALL_START',jobId)).filter(s=>s.operation===operation);
    const results=await store.docs('GEPA_CALL_RESULT',jobId),received=results.find(r=>r.success&&starts.some(s=>s.id===r.startId));
    let response;
    if(received){
      response=await loadTrace(received.artifact);
      const recorded=JSON.parse(response.options?.messages?.at(-1)?.content||'{}');
      if(digest(recorded.currentPrompt)!==parentPromptDigest)throw new Error('Received proposal parent differs from the frozen search chain');
    }else{
      const source=snapshot.source,messages=[{role:'SYSTEM',content:IMPROVEMENT_INSTRUCTIONS},{role:'USER',content:JSON.stringify({currentPrompt:request.text,immutablePolicy:source.policy,developmentFeedback:request.feedback})}];
      response=await invoke(operation,{modelId:source.models.judge,mode:source.modes.judge,messages,settings:settingsForRole(source,'judge'),compartmentId:source.compartmentId,endpoint:source.genaiEndpoint},r=>validateProposal(parseJSON(r.text),snapshot));
    }
    await guard();const proposal=validateProposal(parseJSON(response.text),snapshot),id=digest({jobId,proposal:slot,text:proposal.text});
    await store.saveDoc({id,kind:'GEPA_CANDIDATE',parentId:jobId,value:{...proposal,iteration:slot,parentPromptDigest}});
    return{text:proposal.text,rationale:proposal.rationale,responseSource:received?'SAVED_RESPONSE':response.responseSource};
  };
}

export async function optimizePrompt(snapshot,task,{isAlive=()=>true,signal}={}){
  assertOptimizer(snapshot);const source=snapshot.source;
  let runnerAlive=true;
  const guard=async()=>{if(!runnerAlive||signal?.aborted||!isAlive()||!await repository.heartbeat(task))throw Object.assign(new Error('Prompt optimization cancelled or worker lease lost'),{code:'LEASE_LOST'});};
  const invoke=createCallLedger({jobId:task.runId,cycle:task.cycle,maxCalls:snapshot.optimizer.limits.maxCalls,store:repository,guard,call:chat,writeTrace:(id,value)=>putJSON('optimization-traces',id,value),loadTrace:getJSON});
  let evaluated=0;const propose=createOptimizationProposer({snapshot,jobId:task.runId,invoke,guard});
  const handle=async request=>{
    await guard();
    // Validate all proposed text on the Node side before any tested-model call.
    validateProposal({text:request.text,rationale:'Promptfoo development candidate validation.'},snapshot);
    if(request.operation==='evaluate'){
      if(!Array.isArray(request.caseIds)||!request.caseIds.length||new Set(request.caseIds).size!==request.caseIds.length||request.caseIds.some(id=>!source.dataset.cases.some(c=>c.id===id)))throw new Error('Promptfoo requested invalid development cases');
      if(evaluated+request.caseIds.length>snapshot.optimizer.limits.maxCaseEvaluations)throw new Error('Prompt optimization case evaluation limit exceeded');
      evaluated+=request.caseIds.length;const rows=[];
      for(const id of request.caseIds){await guard();rows.push(await evaluateOptimizationCase({snapshot,jobId:task.runId,text:request.text,c:source.dataset.cases.find(c=>c.id===id),invoke,guard}));}
      return{rows};
    }
    return propose(request);
  };
  const search=await runPromptfooOptimizer({prompt:source.prompt,...snapshot.optimizer.plan,limits:snapshot.optimizer.limits,requestTimeoutMs:snapshot.optimizer.requestTimeoutMs},handle,{signal,onAbort:()=>{runnerAlive=false;}});
  await guard();const evaluations=await repository.docs('GEPA_EVALUATION',task.runId),validation=source.dataset.cases.filter(c=>snapshot.optimizer.plan.validationIds.includes(c.id));
  const selected=selectOptimizationCandidate(source.prompt,validation,evaluations);
  const artifact=await putJSON('optimization-results',task.runId,{search,selected,evaluations,limits:snapshot.optimizer.limits});
  const proposal=validateProposal({text:selected.text,rationale:selected.rationale},snapshot);
  const promptId=selected.changed?digest({proposal:task.id,text:selected.text}):source.promptId;
  if(selected.changed)await repository.saveDoc({id:promptId,kind:'PROMPT',parentId:source.promptId,version:`promptfoo-${task.id.slice(0,8)}`,value:{text:selected.text,generated:true,proposalId:task.id,diff:proposal.diff}});
  return{...proposal,promptId,changed:selected.changed,optimizer:OPTIMIZER_NAME,optimizerVersion:search.version,artifact,selection:selected,search:{evaluated:search.evaluated,proposed:search.proposed,stopped:search.stopped},callAttempts:(await repository.docs('GEPA_CALL_START',task.runId)).length};
}
