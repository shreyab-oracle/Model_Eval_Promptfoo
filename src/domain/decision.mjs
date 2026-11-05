import {AXES,judgePass,judgesDisagree,validJudgeScores,REVIEW_POLICY_VERSION} from './judge.mjs';
const failed=c=>c.status!=='PASS';
export function assessOutput(o,reviews=[],{reviewPolicyVersion=REVIEW_POLICY_VERSION}={}) {
  const review=reviews.filter(r=>r.outputId===o.id).sort((a,b)=>(a.createdAt||'').localeCompare(b.createdAt||'')).at(-1);
  const failures=(o.checks||[]).filter(failed),critical=failures.some(f=>f.severity==='critical'&&f.confirmed)||reviews.some(r=>r.outputId===o.id&&r.resolution==='CONFIRM_CRITICAL');
  const flagged=failures.some(f=>f.severity==='critical'&&!f.confirmed)||(o.judges||[]).some(j=>j.critical);
  const disagreement=judgesDisagree(o.judges||[],reviewPolicyVersion);
  const validJudges=o.judges?.length===2&&o.judges.every(validJudgeScores)&&(!o.judges.some(j=>j.assessment!==undefined)||[0,1].every(slot=>o.judges.some(j=>j.assessment===slot)));
  const adjudicated=['ACCEPT_OUTPUT','REJECT_OUTPUT','CONFIRM_CRITICAL'].includes(review?.resolution);
  const reviewRequired=flagged||disagreement||!validJudges||!!o.error||!o.response;
  const pending=reviewRequired&&(!adjudicated||!validJudges||!!o.error||!o.response);
  // Human acceptance can adjudicate judge/prose ambiguity, never deterministic financial facts.
  const factualFailures=failures.filter(f=>f.confirmed);
  const pass=!o.error&&!!o.response&&validJudges&&!critical&&!pending&&!factualFailures.length&&(adjudicated?review.resolution==='ACCEPT_OUTPUT':o.judges.every(judgePass))&&(!flagged||adjudicated);
  // Agreed failing quality evidence is a failure. An unresolved score boundary
  // alone is uncertainty, and acceptance never repairs missing judge evidence.
  const qualityFailure=validJudges&&!adjudicated&&AXES.some(a=>o.judges.every(j=>j.scores[a]<2));
  const confirmedFailure=critical||factualFailures.length>0||review?.resolution==='REJECT_OUTPUT'||qualityFailure;
  return{pass:!!pass,outcome:confirmedFailure?'FAIL':pass?'PASS':'NEEDS_REVIEW',critical,pending,disagreement,flagged,reviewRequired,reviewResolved:reviewRequired&&!pending};
}
export function decideRun(run,cases,outputs,reviews=[],evidence={}) {
  const reasons=[],comparisons=[];let complete=cases.length>0&&run.status==='COMPLETED';
  const keys=new Set();
  for(const o of outputs){const key=`${o.caseId}/${o.role}/${o.repeat}`;if(keys.has(key))complete=false;keys.add(key);}
  for(const c of cases){const result={id:c.id,category:c.category};for(const role of ['baseline','candidate']){
    const rows=outputs.filter(o=>o.caseId===c.id&&o.role===role);const full=rows.length===3&&[0,1,2].every(n=>rows.some(o=>o.repeat===n))&&rows.every(o=>o.response&&!o.error&&o.judges?.length===2&&[0,1].every(slot=>o.judges.some(j=>j.assessment===slot))&&o.judges.every(j=>typeof j.critical==='boolean'&&AXES.every(a=>Number.isInteger(j.scores?.[a])&&j.scores[a]>=0&&j.scores[a]<=3))&&Array.isArray(o.checks));
    if(!full)complete=false;const a=rows.map(o=>assessOutput(o,reviews));
    const confirmedFailure=a.some(x=>x.outcome==='FAIL');
    const pass=full&&a.every(x=>x.pass);
    result[role]={pass,outcome:confirmedFailure?'FAIL':pass?'PASS':'NEEDS_REVIEW',critical:a.filter(x=>x.critical).length,pending:a.filter(x=>x.pending).length,confirmedFailure};
  }result.change=[result.baseline,result.candidate].some(r=>r.outcome==='NEEDS_REVIEW')?'PENDING':result.baseline.pass&&!result.candidate.pass?'REGRESSION':!result.baseline.pass&&result.candidate.pass?'IMPROVEMENT':'UNCHANGED';comparisons.push(result);}
  if(outputs.length!==cases.length*6)complete=false;
  if(!complete)for(const c of comparisons)c.change='PENDING';
  const categories=Object.fromEntries([...new Set(cases.map(c=>c.category))].map(category=>{const rows=comparisons.filter(c=>c.category===category);return[category,{total:rows.length,baseline:rows.filter(c=>c.baseline.pass).length/rows.length,candidate:rows.filter(c=>c.candidate.pass).length/rows.length}];}));
  const total=cases.length,baseline=total?comparisons.filter(c=>c.baseline.pass).length/total:0,candidate=total?comparisons.filter(c=>c.candidate.pass).length/total:0;
  const critical=comparisons.reduce((n,c)=>n+c.candidate.critical,0),pending=comparisons.reduce((n,c)=>n+c.baseline.pending+c.candidate.pending,0);
  // Unfinished work/reviews may still pass. Only a bound that already fails
  // establishes a numerical BLOCK before those unknown outcomes are resolved.
  const maximumCandidate=total?comparisons.filter(c=>!c.candidate.confirmedFailure).length/total:1;
  let numericFailure=maximumCandidate<0.9;
  if(!complete)reasons.push('Incomplete run: every case requires three outputs per model, all checks and two valid judge assessments.');
  if(!run.live)reasons.push('Only live OCI evaluations may qualify.');
  if(!run.artifactsVerified)reasons.push('Frozen dataset, manifest, traces and report artifacts are not fully verified.');
  if(critical)reasons.push(`${critical} confirmed critical candidate failure(s).`);
  if(maximumCandidate<0.9)reasons.push('Candidate overall pass rate is below 90%.');
  for(const [name,c] of Object.entries(categories)){
    const maximum=comparisons.filter(r=>r.category===name&&!r.candidate.confirmedFailure).length/c.total;
    if(maximum<0.9){numericFailure=true;reasons.push(`${name}: candidate pass rate is below 90%.`);}
    if(maximum<c.baseline){numericFailure=true;reasons.push(`${name}: category regression against baseline.`);}
  }
  const pairs=new Map();
  for(const c of cases)if(c.pairId){if(!pairs.has(c.pairId))pairs.set(c.pairId,[]);pairs.get(c.pairId).push(comparisons.find(r=>r.id===c.id));}
  const pairedRows=[...pairs].map(([id,rows])=>({id,caseIds:rows.map(r=>r.id),complete:rows.length===2,
    pass:rows.length===2&&rows.every(r=>r.candidate.pass),confirmedFailure:rows.some(r=>r.candidate.confirmedFailure)}));
  const pairedTests={complete:pairedRows.every(p=>p.complete),failed:pairedRows.filter(p=>p.confirmedFailure).length,pairs:pairedRows};
  if(!pairedTests.complete)reasons.push('Declared paired tests require exactly two case members.');
  if(pairedTests.failed)reasons.push(`${pairedTests.failed} paired test(s) have a confirmed candidate failure.`);
  if(pending)reasons.push(`${pending} critical findings or judge disagreements require human review.`);
  if(run.datasetKind!=='release')reasons.push('Development results cannot establish release eligibility.');
  for(const type of ['labels','calibration','release'])if(!evidence[type])reasons.push(`${type} evidence approval is pending.`);
  const mandatoryFailure=critical>0||numericFailure||pairedTests.failed>0;
  const decision=mandatoryFailure?'BLOCK':!complete||!run.live||!run.artifactsVerified||reasons.length?'REVIEW':'ELIGIBLE FOR PILOT';
  const outcomes=Object.fromEntries(['baseline','candidate'].map(role=>{
    const rows=outputs.filter(o=>o.role===role&&cases.some(c=>c.id===o.caseId)),unique=new Map();
    for(const o of rows){const key=`${o.caseId}/${o.repeat}`;if([0,1,2].includes(o.repeat)&&!unique.has(key))unique.set(key,o);}
    const assessments=[...unique.values()].map(o=>assessOutput(o,reviews)),expected=total*3;
    const responsePass=assessments.filter(a=>a.outcome==='PASS').length,responseFail=assessments.filter(a=>a.outcome==='FAIL').length;
    const roleCases=comparisons.map(c=>c[role]),casePass=roleCases.filter(c=>c.outcome==='PASS').length,caseFail=roleCases.filter(c=>c.outcome==='FAIL').length;
    const required=assessments.filter(a=>a.reviewRequired).length,resolved=assessments.filter(a=>a.reviewResolved).length;
    return[role,{responses:{pass:responsePass,fail:responseFail,needsReview:expected-responsePass-responseFail,total:expected,expected,recorded:unique.size,passRate:expected?responsePass/expected:0},
      cases:{pass:casePass,fail:caseFail,needsReview:total-casePass-caseFail,total,passRate:total?casePass/total:0},reviews:{required,resolved,pending:required-resolved,coverage:required?resolved/required:1}}];
  }));
  const pendingCritical=outputs.filter(o=>o.role==='candidate'&&assessOutput(o,reviews).flagged&&assessOutput(o,reviews).pending&&!assessOutput(o,reviews).critical);
  const criticalFindings={confirmedCandidateResponses:critical,confirmedCandidateCases:comparisons.filter(c=>c.candidate.critical>0).length,pendingCandidateResponses:pendingCritical.length,pendingCandidateCases:new Set(pendingCritical.map(o=>o.caseId)).size};
  return{decision,reasons,complete,total,baseline,candidate,categories,pairedTests,criticalCandidateFailures:critical,pendingReviews:pending,comparisons,outcomes,criticalFindings,reviewPolicyVersion:REVIEW_POLICY_VERSION};
}
