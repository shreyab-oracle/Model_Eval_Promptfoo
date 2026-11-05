import {loadPromptfoo,EVALUATE_OPTIONS} from './runtime.mjs';
import {OciTaskProvider} from './provider.mjs';
import {invoiceAssertion,judgeAssertion} from './assertions.mjs';
import {runnerIdentity} from './version.mjs';

// One evaluation is deliberately the size of one durable database attempt.
// There is no second whole-run scheduler or Promptfoo-owned history store.
export async function evaluateRequest({stage,c,evaluatedOutput,policyReference=null,invalidJudgmentAsFeedback=false,...options}){
  if(!['GENERATE','JUDGE'].includes(stage))throw new Error('Unsupported evaluation stage');
  const provider=new OciTaskProvider(options),state={};
  const assertion=stage==='GENERATE'?invoiceAssertion(c,{policyReference,evaluatorVersion:runnerIdentity().evaluatorVersion}):judgeAssertion(evaluatedOutput,state);
  const promptfoo=await loadPromptfoo();
  const record=await promptfoo.evaluate({
    prompts:['durable-oci-task'],providers:[provider],
    tests:[{vars:{},assert:[assertion],options:{disableConversationVar:true,disableVarExpansion:true,disableDefaultAsserts:true}}],
    defaultTest:{assert:[]},writeLatestResults:false,sharing:false,tracing:{enabled:false},
  },EVALUATE_OPTIONS);
  if(provider.error)throw provider.error;
  const invalidFeedback=state.error&&invalidJudgmentAsFeedback&&provider.response?.evaluationError;
  if(state.error&&!invalidFeedback)throw state.error;
  const summary=await record.toEvaluateSummary();
  if(summary.results.length!==1||provider.calls!==1)throw new Error('Promptfoo violated the single durable attempt boundary');
  const result=summary.results[0],gradingResult=result.gradingResult?.componentResults?.[0];
  if(!gradingResult?.metadata?.business&&!invalidFeedback)throw Object.assign(new Error(result.error||'Promptfoo did not return the required business assertion evidence'),{code:'EVALUATION_ADAPTER_ERROR'});
  const evaluation={runner:'promptfoo',identity:runnerIdentity(),...options.identity,stage,
    success:result.success,gradingResult,cached:false,requestId:provider.response.requestId,
    ...(stage==='GENERATE'?{findings:gradingResult.metadata.findings}:{namedScores:gradingResult.namedScores??{}}),
    latencyMs:provider.response.latencyMs,usage:provider.response.usage??null};
  return{response:provider.response,value:gradingResult.metadata.business||{},evaluation,
    responseSource:provider.receivedResponse?'SAVED_RESPONSE':provider.response.responseSource||'FRESH_MODEL_RESPONSE'};
}
