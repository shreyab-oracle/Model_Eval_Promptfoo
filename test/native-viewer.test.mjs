import test from 'node:test';
import assert from 'node:assert/strict';
const viewer=await import('../src/evaluation/viewer.mjs').catch(()=>({}));
test('review badges read saved outcomes and retain missing evidence as errors',()=>{
  const pending={failureReason:2,provider:{id:'candidate'},metadata:{outcome:'NEEDS_REVIEW',technicalDetails:{rawResponse:{reply:'Saved answer'}},judgments:[{assessment:0},{assessment:1}]}};
  const missing=structuredClone(pending);missing.metadata.judgments.pop();
  const absent=structuredClone(pending);absent.metadata.outcome='NOT_RECORDED';
  const failed={...pending,failureReason:1};
  const input=[pending,missing,absent,failed],before=structuredClone(input);
  assert.deepEqual(viewer.viewerReviewCounts(input),{candidate:{needsReview:1,errors:2}});
  assert.deepEqual(input,before);assert.deepEqual(viewer.viewerReviewCounts(),{});
});
test('whole-run outcome counts include pending and unrecorded rows without inventing verdicts',()=>{
  const row=outcome=>({provider:{id:'candidate'},metadata:{outcome,technicalDetails:{rawResponse:{}},judgments:[{assessment:0},{assessment:1}]}});
  const rows=[row('PASS'),row('FAIL'),row('NEEDS_REVIEW'),row('NOT_RECORDED')],original=structuredClone(rows);
  assert.deepEqual(viewer.viewerOutcomeCounts(rows),{candidate:{total:4,pass:1,fail:1,needsReview:1,incomplete:1}});
  assert.deepEqual(viewer.viewerOutcomeCounts(),{});assert.deepEqual(rows,original);
});
function bundle(){
  return {run:{id:'saved',kind:'release',status:'COMPLETED',createdAt:'2026-11-01T08:00:00Z'},snapshot:{dataset:{cases:[{id:'invoice-case',category:'routine',invoice:{id:'invoice',quantity:10,unitCents:100},expected:{action:'RETAIN_HOLD'}}]},prompt:'Frozen prompt',modelMetadata:{baseline:{displayName:'Baseline model'},candidate:{displayName:'Candidate model'}}},
    result:{complete:true,decision:'BLOCK',reasons:['Confirmed candidate failure'],comparisons:[{id:'invoice-case',change:'REGRESSION',baseline:{outcome:'PASS',pass:true,pending:0,critical:0},candidate:{outcome:'FAIL',pass:false,pending:0,critical:1}}]},
    outputs:[{id:'baseline-0',caseId:'invoice-case',role:'baseline',repeat:0,response:{reply:'Keep the hold.'},checks:[],assessment:{outcome:'PASS'},judges:[]},
      {id:'candidate-0',caseId:'invoice-case',role:'candidate',repeat:0,response:{reply:'The invoice has been paid.'},checks:[{code:'UNSUPPORTED_PAYMENT_CLAIM',status:'FAIL',severity:'critical',confirmed:true,message:'Unsupported payment'}],assessment:{outcome:'FAIL',critical:true},judges:[{assessment:0,scores:{policy:1,evidence:0,tone:2,clarity:2,nextSteps:1},rationale:'First explanation',evidence:[{quote:'has been paid',axis:'evidence',reason:'No ledger receipt'}]},{assessment:1,scores:{policy:2,evidence:1,tone:2,clarity:2,nextSteps:2},rationale:'Second explanation',evidence:[{quote:'has been paid',axis:'evidence',reason:'Unsupported assertion'}]}]}],reviews:[]};
}

test('native Promptfoo table pairs answers by case and repetition and retains both judgments',()=>{
  assert.equal(typeof viewer.viewerTable,'function');const b=bundle(),original=structuredClone(b),page=viewer.viewerTable(b);
  assert.equal(page.table.head.prompts.length,2);assert.equal(page.table.body.length,3);
  const row=page.table.body[0];assert.equal(row.outputs[0].text.includes('Keep the hold.'),true);assert.match(row.outputs[1].text,/has been paid/);
  assert.equal(row.outputs[1].metadata.caseId,'invoice-case');assert.equal(row.outputs[1].metadata.repeat,0);
  assert.equal(row.outputs[1].namedScores['Judge 1 · evidence'],0);assert.equal(row.outputs[1].namedScores['Judge 2 · evidence'],1);
  assert.match(JSON.stringify(row.outputs[1].gradingResult),/First explanation/);assert.match(JSON.stringify(row.outputs[1].gradingResult),/Second explanation/);
  assert.equal(row.outputs[1].metadata.critical,true);assert.equal(row.outputs[1].pass,false);assert.equal(row.outputs[1].failureReason,1);
  assert.equal(page.table.body[1].outputs[1].failureReason,2);assert.match(page.table.body[1].outputs[1].text,/Not recorded/);
  assert.deepEqual(b,original);
});

test('historical table never derives new response verdicts from old checks or judges',()=>{
  assert.equal(typeof viewer.viewerTable,'function');const b=bundle();b.historical=true;delete b.outputs[0].assessment;delete b.outputs[1].assessment;
  const page=viewer.viewerTable(b);assert.equal(page.table.body[0].outputs[1].metadata.outcome,'NOT_RECORDED');
  assert.equal(page.table.body[0].outputs[1].failureReason,2);assert.match(page.table.body[0].outputs[1].gradingResult.reason,/Not recorded/);
  assert.equal(b.result.decision,'BLOCK');
});

test('filter metadata keeps new failures, critical findings, human review and incomplete comparisons separate',()=>{
  assert.equal(typeof viewer.viewerTable,'function');const b=bundle();
  const saved=viewer.viewerTable(b).table.body[0].outputs[1].metadata;
  assert.equal(saved.newCandidateFailure,true);assert.equal(saved.candidateImprovement,false);assert.equal(saved.confirmedCriticalFailure,true);
  b.result.complete=false;
  const partial=viewer.viewerTable(b).table.body[0].outputs[1].metadata;
  assert.equal(partial.newCandidateFailure,false);assert.equal(partial.unresolved,true);assert.equal(partial.confirmedCriticalFailure,true);
});

test('malformed recorded answers remain intact and extra judge fields cannot become rubric scores',()=>{
  const b=bundle();b.outputs[0].response='{"action": broken';b.outputs[1].judges[0].scores.extra=99;
  const page=viewer.viewerTable(b);assert.equal(page.table.body[0].outputs[0].text,'{"action": broken');assert.equal(page.table.body[0].outputs[1].namedScores['Judge 1 · extra'],undefined);
});
