// Supported Promptfoo file-provider and JavaScript-assertion contracts. The CLI
// has no OCI credentials; all generation/judging stays in the durable backend.
function optimizationFeedback(row){
  // Promptfoo 0.125.1 clips both output and gradingReason to 1200 characters.
  // Keep the recorded failures ahead of large facts, replies and evaluator
  // metadata so the native search can act on the received assessment.
  const lines=[`Case ${row.caseId}: ${row.pass?'PASS':'FAIL'}; complete=${row.complete}; critical=${row.critical}; pending=${row.pending}; executionErrors=${row.executionErrors??0}.`],details=new Set();
  const add=value=>{if(value&&!details.has(value)){details.add(value);lines.push(value.slice(0,700));}};
  for(const output of row.feedback?.outputs??[]){
    if(output.error)add(`Answer action=${JSON.stringify(output.response?.action)}; ${output.error.code??'EVALUATION_ERROR'}: ${output.error.message}`);
    for(const failure of output.judgeErrors??[])add(`Judge ${failure.assessment}: ${failure.error?.code??'INVALID_JUDGE_ASSESSMENT'}: ${failure.error?.message}`);
  }
  for(const output of row.feedback?.outputs??[]){
    for(const check of output.checks??[])if(check.status!=='PASS')add(`Check ${check.id??check.checkId??check.name??''}: ${JSON.stringify(check)}`);
    for(const judge of output.judges??[])if(judge.critical||Object.values(judge.scores??{}).some(score=>score<2))add(`Judge: ${JSON.stringify({scores:judge.scores,critical:judge.critical,rationale:judge.rationale})}`);
  }
  add(JSON.stringify(row.feedback??{}));
  return lines.join('\n').slice(0,1200);
}

export default class OptimizationCaseProvider {
  handlesOwnRetries=true;
  config={maxRetries:0};
  id(){return 'oracle-optimization-case';}
  async callApi(prompt,context){
    const response=await fetch(process.env.AIE_OPTIMIZER_ENDPOINT+'/case',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+process.env.AIE_OPTIMIZER_TOKEN},
      body:JSON.stringify({text:context.prompt.raw,caseId:context.vars.caseId})});
    const value=await response.json();if(!response.ok||value.error)throw new Error(value.error||'Backend optimization assessment failed');
    return{output:optimizationFeedback(value),metadata:{assessment:value},cached:false};
  }
}

export function assertAssessment(_output,context){
  const row=context.providerResponse?.metadata?.assessment;
  if(typeof row?.pass!=='boolean')throw new Error('Missing backend business assessment');
  return{pass:row.pass,score:row.pass?1:0,reason:optimizationFeedback(row),
    metadata:{businessAssessment:row}};
}
