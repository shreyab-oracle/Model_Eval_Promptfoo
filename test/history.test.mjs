import test from 'node:test';
import assert from 'node:assert/strict';
const history=await import('../src/services/history.mjs').catch(()=>({}));
const fixture=complete=>({run:{id:'keep-existing-id',status:complete?'COMPLETED':'RUNNING'},snapshot:{models:{baseline:'mini-id',candidate:'large-id',judge:'large-id'},modelMetadata:{baseline:{displayName:'mini'},candidate:{displayName:'large'},judge:{displayName:'large'}},promptId:'original-prompt-id',policy:{version:'demo'},dataset:{version:'dev-v1'}},result:{decision:complete?'BLOCK':'REVIEW',complete,reasons:['Pending calibration'],comparisons:[{id:'case-a',change:'IMPROVEMENT'},{id:'case-b',change:'REGRESSION'}],pendingReviews:1},progress:{done:1,total:18,failed:1,running:0}});
test('history retains chosen identifiers, models, prompt and actual completed changes',()=>{
  assert.equal(typeof history.historySummary,'function');const value=history.historySummary(fixture(true),{version:'reviewer-v1'});
  assert.equal(value.id,'keep-existing-id');assert.equal(value.prompt.id,'original-prompt-id');assert.equal(value.models.candidate.id,'large-id');assert.equal(value.improvements[0],'case-a');assert.equal(value.regressions[0],'case-b');assert.equal(value.executionErrors,1);assert.equal(value.pendingReviews,1);
});
test('incomplete history never treats unrun outputs as measured regressions',()=>{
  assert.equal(typeof history.historySummary,'function');const value=history.historySummary(fixture(false));assert.equal(value.improvements,null);assert.equal(value.regressions,null);assert.equal(value.decision,'REVIEW');
});

test('history identifies the invoice example and answer attempt needing review',()=>{
  const bundle=fixture(false);bundle.snapshot.dataset.cases=[{id:'case-a',category:'payment'}];
  bundle.outputs=[{id:'output-a',caseId:'case-a',role:'candidate',repeat:2,checks:[{status:'FAIL',severity:'critical',confirmed:false}]}];
  const value=history.historySummary(bundle);
  assert.deepEqual(value.reviewItems,[{outputId:'output-a',caseId:'case-a',category:'payment',caseIndex:0,role:'candidate',repeat:2}]);
});
