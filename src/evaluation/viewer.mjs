import {AXES} from '../domain/judge.mjs';
import {outputFindings} from './findings.mjs';

// Project saved Oracle evidence into the pinned native viewer import format.
// This module only reads recorded findings and never evaluates or calls models.
export const VIEWER_PROTOCOL_VERSION='oracle-promptfoo-viewer-v2';
const roles=['baseline','candidate'];
function awaitingReview(result){
  const metadata=result.metadata||{},judges=metadata.judgments||[];
  return metadata.outcome==='NEEDS_REVIEW'&&metadata.technicalDetails?.rawResponse!=null&&
    [0,1].every(slot=>judges.some(j=>j.assessment===slot));
}
export function viewerOutcomeCounts(results=[]){
  const counts={};
  for(const result of results){
    const role=result.provider?.id||result.provider;
    if(typeof role!=='string')continue;
    const count=counts[role]??={total:0,pass:0,fail:0,needsReview:0,incomplete:0};
    count.total++;
    const outcome=result.metadata?.outcome;
    count[outcome==='PASS'?'pass':outcome==='FAIL'?'fail':awaitingReview(result)?'needsReview':'incomplete']++;
  }
  return counts;
}
// Describe existing native error slots without changing any saved verdict.
export function viewerReviewCounts(results=[]){
  const counts={};
  for(const result of results){
    if(result.failureReason!==2)continue;
    const role=result.provider?.id||result.provider;
    if(typeof role!=='string')continue;
    const count=counts[role]??={needsReview:0,errors:0};
    count[awaitingReview(result)?'needsReview':'errors']++;
  }
  return counts;
}
const text=value=>value===undefined?'Not recorded':typeof value==='string'?value:JSON.stringify(value,null,2);
function recordedChange(c,complete){
  if(complete!==true||[c?.baseline,c?.candidate].some(r=>!r||r.outcome==='NEEDS_REVIEW'||r.pending>0))return 'PENDING';
  return ['REGRESSION','IMPROVEMENT','UNCHANGED'].includes(c.change)?c.change:'PENDING';
}
function caseMetadata(c,complete){
  const change=recordedChange(c,complete);
  return{change,newCandidateFailure:change==='REGRESSION',candidateImprovement:change==='IMPROVEMENT',
    confirmedCriticalFailure:(c?.candidate?.critical||0)>0,needsHumanReview:[c?.baseline,c?.candidate].some(r=>r?.pending>0),unresolved:change==='PENDING'};
}
function cell(output,b,role,testIdx,metadata){
  const outcome=output?.assessment?.outcome||'NOT_RECORDED',pass=outcome==='PASS',failed=outcome==='FAIL';
  const findings=output?outputFindings(output,{policyReference:b.snapshot.policy?.version??null,evaluatorVersion:b.snapshot.runner?.evaluatorVersion??null}):[];
  const judges=output?.judges||[],namedScores={};
  const components=findings.map(f=>({pass:f.status==='PASS',score:f.status==='PASS'?1:0,reason:`${f.name}: ${f.status}. ${f.explanation||'Not recorded'}`,
    assertion:{type:'javascript',metric:f.name},metadata:{finding:f}}));
  for(const [index,judge] of judges.entries()){
    const slot=Number.isInteger(judge.assessment)?judge.assessment:index;
    for(const axis of AXES)if(Number.isInteger(judge.scores?.[axis])){
      namedScores[`Judge ${slot+1} · ${axis}`]=judge.scores[axis];
      components.push({pass:judge.scores[axis]>=2,score:judge.scores[axis],reason:judge.rationale||'Not recorded',
        assertion:{type:'javascript',metric:`Judge ${slot+1} · ${axis}`},metadata:{source:'AI_JUDGE',confirmed:false,axis,assessment:slot,evidence:judge.evidence||[],critical:judge.critical,criticalReason:judge.criticalReason??null}});
    }
  }
  const reason=outcome==='NOT_RECORDED'?'Not recorded: no saved response outcome. Original findings and judgments are retained.':outcome==='NEEDS_REVIEW'?'NEEDS_REVIEW: evidence or adjudication is pending.':outcome;
  return{id:output?.id||`not-recorded-${testIdx}-${role}`,text:output?answerText(output.response):'Not recorded',pass,success:pass,score:pass?1:0,
    failureReason:failed?1:pass?0:2,...(!pass&&!failed?{error:reason}:{}),namedScores,
    gradingResult:{pass,score:pass?1:0,reason,componentResults:components},provider:role,
    prompt:b.snapshot.prompt||'Not recorded',testIdx,promptIdx:roles.indexOf(role),
    ...(Number.isFinite(output?.latencyMs)?{latencyMs:output.latencyMs}:{}),
    ...(output?.usage?{tokenUsage:{prompt:output.usage.promptTokens??output.usage.inputTokens,completion:output.usage.completionTokens??output.usage.outputTokens,total:output.usage.totalTokens}}:{}),
    metadata:{...metadata,outcome,critical:output?.assessment?.critical===true,responseSource:output?.responseSource||(output?.recoveryKind==='LOCAL_JOURNAL'?'SAVED_RESPONSE':'Not recorded'),
      findings,judgments:judges,reviewHistory:(b.reviews||[]).filter(r=>r.outputId===output?.id),
      technicalDetails:{rawResponse:output?.response??null,rawText:output?.rawText??null,requestId:output?.requestId??null,trace:output?.trace??null,
        usage:output?.usage??null,latencyMs:output?.latencyMs??null,evaluation:output?.evaluation??null,sourceAttemptId:output?.sourceAttemptId??null,processingAttemptId:output?.processingAttemptId??null}}};
}
function answerText(response){
  if(response===undefined||response===null)return 'Not recorded';
  if(typeof response==='string')return response;
  return [typeof response.reply==='string'?response.reply:'Reply: Not recorded',
    ...[['Action',response.action],['Holds',response.holdReasons],['Missing facts',response.missingFacts],['Owner',response.owner],['Next step',response.nextStep],['Payment status',response.paymentStatus],['Hold release status',response.holdReleaseStatus],['Calculations',response.calculations],['Sources',response.sources]].map(([key,value])=>`${key}: ${text(value)}`)].join('\n\n');
}
function metrics(rows,index){
  const outputs=rows.map(r=>r.outputs[index]);
  return{score:outputs.filter(o=>o.pass).length,testPassCount:outputs.filter(o=>o.pass).length,testFailCount:outputs.filter(o=>o.failureReason===1).length,
    testErrorCount:outputs.filter(o=>o.failureReason===2).length,assertPassCount:outputs.flatMap(o=>o.gradingResult.componentResults).filter(c=>c.pass).length,
    assertFailCount:outputs.flatMap(o=>o.gradingResult.componentResults).filter(c=>!c.pass).length,namedScores:{},namedScoresCount:{},
    totalLatencyMs:outputs.reduce((sum,o)=>sum+(o.latencyMs||0),0),tokenUsage:{total:outputs.reduce((sum,o)=>sum+(o.tokenUsage?.total||0),0),prompt:outputs.reduce((sum,o)=>sum+(o.tokenUsage?.prompt||0),0),completion:outputs.reduce((sum,o)=>sum+(o.tokenUsage?.completion||0),0),cached:0,numRequests:outputs.filter(o=>o.metadata.responseSource==='FRESH_MODEL_RESPONSE').length}};
}
export function viewerTable(b){
  const cases=b.snapshot.dataset?.cases||[];
  const rows=cases.flatMap((c,index)=>[0,1,2].map(repeat=>{
    const comparison=b.result.comparisons?.find(row=>row.id===c.id),metadata={caseId:c.id,repeat,...caseMetadata(comparison,b.result.complete)},testIdx=index*3+repeat;
    const vars={'Case':`Example ${index+1} · ${c.category||'Not recorded'}`,'Repetition':String(repeat+1),'Invoice facts':text({po:c.po??null,receipt:c.receipt??null,invoice:c.invoice??null,supplierMessage:c.supplierMessage??null,evidence:c.evidence??null}),'Expected behaviour':text(c.expectedBehaviour??c.expected)};
    return{testIdx,description:`Example ${index+1}, repetition ${repeat+1}`,vars:Object.values(vars),test:{description:`Example ${index+1}, repetition ${repeat+1}`,vars,metadata:{caseId:c.id,repeat,...metadata}},
      outputs:roles.map(role=>cell(b.outputs.find(o=>o.caseId===c.id&&o.role===role&&o.repeat===repeat),b,role,testIdx,metadata))};
  }));
  const prompts=roles.map((role,index)=>({id:role,raw:b.snapshot.prompt||'Not recorded',label:`${role==='baseline'?'Baseline':'Candidate'} · ${b.snapshot.modelMetadata?.[role]?.displayName||'Not recorded'}`,provider:role,metrics:metrics(rows,index)}));
  return{table:{head:{prompts,vars:['Case','Repetition','Invoice facts','Expected behaviour']},body:rows},
    config:{description:`${b.run.kind} · ${b.run.createdAt||'Not recorded'}`,prompts:prompts.map(p=>({raw:p.raw,label:p.label})),providers:roles,tests:[],sharing:false,
      metadata:{viewerProtocol:VIEWER_PROTOCOL_VERSION,oracleRunId:b.run.id,historical:!!b.historical,businessGate:b.result.decision,businessGateReasons:b.result.reasons}}};
}
