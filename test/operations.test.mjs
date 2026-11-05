import test from 'node:test';
import assert from 'node:assert/strict';
const ui=await import('../src/http/operations.mjs').catch(()=>({}));
const boot={datasets:[{id:'dev',kind:'development',caseCount:24,version:'v1'}],prompts:[{id:'prompt',text:'Frozen instructions',version:'v1'}],policies:[{id:'policy',policy:{version:'demo-policy-v1'}}],configuration:{models:{baseline:'b',candidate:'c',judge:'j'},modelNames:{baseline:'Baseline',candidate:'Candidate',judge:'Judge'}},runs:[],promptApprovals:[],proposals:[],retestLinks:[],optimizationJobs:[]};
test('exhausted optimizer cards expose spent budget without offering another resume',()=>{
  const b={...boot,optimizationJobs:[{id:'spent',optimizer:'Promptfoo',status:'INCOMPLETE',optimizerCurrent:true,callAttempts:433,recordedResults:433,limits:{maxCalls:433},remainingCalls:0,errors:[],candidates:[]}]};
  const html=ui.renderOperations({boot:b,tab:'prompts'});
  assert.match(html,/433\/433/);assert.match(html,/budget exhausted/i);assert.doesNotMatch(html,/Resume with remaining|spent\/resume/);
});
test('archived optimizer evidence is collapsed instead of rendered as an active failure card',()=>{
  const b={...boot,optimizationJobs:[{id:'old',optimizer:'Promptfoo',status:'INCOMPLETE',archived:true,callAttempts:433,limits:{maxCalls:433},errors:[],candidates:[]}]};
  const html=ui.renderOperations({boot:b,tab:'prompts'});
  assert.match(html,/<details[^>]*>\s*<summary>Archived optimization jobs/);assert.doesNotMatch(html,/<h2>Promptfoo · INCOMPLETE/);
});
test('generated prompt omits the suggestion rationale and retains its recorded selection result',()=>{
  const text='Generated reusable instructions only.',rationale='Explanation that must not be copied into the prompt.';
  const b={...boot,optimizationJobs:[{id:'completed',status:'COMPLETED',archived:true,optimizer:'Promptfoo',candidates:[{id:'candidate',text,rationale}]}],proposals:[{parentId:'completed',changed:false,selection:{validationCases:7,candidates:[{text,passed:2}]}}]};
  const html=ui.renderOperations({boot:b,tab:'prompts'});
  assert.match(html,/Generated prompt · Not selected · 2\/7 validation cases/);assert.match(html,/>Copy prompt<\/button>/);assert.doesNotMatch(html,/Why this was suggested/);
  assert.match(html,/<pre id="generated-prompt-completed-candidate">Generated reusable instructions only\.<\/pre>/);
  assert.doesNotMatch(html,/Explanation that must not be copied/);
  assert.doesNotMatch(html,/Saved improvement proposal/);
});
test('archived jobs have distinct groups and unfinished drafts never imply tested success',()=>{
  const b={...boot,optimizationJobs:[{id:'unfinished',status:'INCOMPLETE',archived:true,optimizer:'Promptfoo',candidates:[{id:'one',text:'First draft',rationale:'First explanation'},{id:'two',text:'Second draft',rationale:'Second explanation'}]}]};
  const html=ui.renderOperations({boot:b,tab:'prompts'});
  assert.match(html,/data-optimization-job="unfinished"/);assert.match(html,/Generated draft 1 · Evaluation incomplete/);assert.match(html,/Generated draft 2 · Evaluation incomplete/);
  assert.doesNotMatch(html,/Remove from view|name="hide"/);
});

test('removed optimization jobs and all their drafts disappear while other saved jobs remain',()=>{
  const b={...boot,optimizationJobs:[
    {id:'removed',status:'INCOMPLETE',archived:true,hidden:true,optimizer:'Promptfoo',candidates:[{text:'Removed first draft'},{text:'Removed second draft'}]},
    {id:'kept',status:'COMPLETED',archived:true,optimizer:'Promptfoo',candidates:[{text:'Keep this completed prompt'}]}
  ]};
  const html=ui.renderOperations({boot:b,tab:'prompts'});
  assert.doesNotMatch(html,/Removed first draft|Removed second draft|data-optimization-job="removed"/);
  assert.match(html,/data-optimization-job="kept"/);assert.match(html,/Keep this completed prompt/);
  assert.match(html,/Archived optimization jobs \(1\)/);
});
test('native viewer controls preserve model setup and explicit request estimates',()=>{
  assert.equal(typeof ui.renderOperations,'function');const html=ui.renderOperations({boot,tab:'setup'});
  assert.match(html,/action="\/api\/runs"/);assert.match(html,/name="datasetId"/);assert.match(html,/name="candidateModelId"/);assert.match(html,/432/);
  assert.match(html,/Promptfoo/);assert.doesNotMatch(html,/react|vite|type="checkbox".*acknowledge/i);
  const navigation=html.match(/<nav>(.*?)<\/nav>/s)[1];
  assert.doesNotMatch(navigation,/Run controls|tab=run/);assert.match(navigation,/Human reviews/);
});
test('review extensions preserve both explanations, exact evidence, audit history and deterministic acceptance locks',()=>{
  assert.equal(typeof ui.renderOperations,'function');const html=ui.renderOperations({boot,tab:'reviews',queue:[{runId:'r',outputId:'o',caseId:'case',repeat:1,role:'candidate',reviewReady:true,checks:[{code:'HOLD_PRESERVATION',status:'FAIL',confirmed:true,severity:'critical',message:'Required hold omitted'}],judges:[{assessment:0,rationale:'Judge one',evidence:[{quote:'Exact quote',axis:'policy',reason:'Reason'}]},{assessment:1,rationale:'Judge two',evidence:[]}]}]});
  assert.match(html,/Judge one/);assert.match(html,/Judge two/);assert.match(html,/Exact quote/);assert.match(html,/name="reason"[^>]*required/);
  assert.match(html,/value="ACCEPT_OUTPUT"[^>]*disabled/);assert.match(html,/value="CONFIRM_CRITICAL"/);
});
test('historical review controls cannot submit a new adjudication',()=>{
  assert.equal(typeof ui.renderOperations,'function');const html=ui.renderOperations({boot,tab:'reviews',queue:[{historical:true,runId:'r',outputId:'o',repeat:0,checks:[],judges:[]}]});
  assert.match(html,/Original/);assert.doesNotMatch(html,/action="\/api\/reviews"/);
});
test('operation HTML escapes saved supplier, judge and prompt text',()=>{
  assert.equal(typeof ui.renderOperations,'function');const b=structuredClone(boot);b.prompts[0].text='<script>alert("supplier")</script>';
  const html=ui.renderOperations({boot:b,tab:'prompts'});assert.doesNotMatch(html,/<script>alert/);assert.match(html,/&lt;script&gt;/);
});
test('business run controls preserve cancellation, resume, reports, gate explanation and audit history',()=>{
  assert.equal(typeof ui.renderOperations,'function');const bundle={run:{id:'saved',status:'COMPLETED',reportId:'report'},snapshot:{dataset:{cases:[]}},result:{decision:'BLOCK',reasons:['Critical failure cannot be averaged away']},progress:{done:18,total:18,failed:0,running:0},reviews:[{actor:'Reviewer',resolution:'REJECT_OUTPUT',reason:'Retain this audit reason'}],attempts:[]};
  const html=ui.renderOperations({boot,tab:'run',bundle});assert.match(html,/BLOCK/);assert.match(html,/Critical failure cannot be averaged away/);assert.match(html,/Check and save report/);assert.match(html,/Download original report/);assert.match(html,/Retain this audit reason/);
  bundle.run.status='CANCELLED';assert.match(ui.renderOperations({boot,tab:'run',bundle}),/Resume/);
  bundle.run.status='RUNNING';assert.match(ui.renderOperations({boot,tab:'run',bundle}),/Cancel/);
});
test('Promptfoo optimization controls keep development selection, call limits, approval and retest opt-in',()=>{
  assert.equal(typeof ui.renderOperations,'function');const b=structuredClone(boot);b.runs=[{id:'dev-run',kind:'development',status:'COMPLETED'},{id:'release-run',kind:'release',status:'COMPLETED'}];
  const html=ui.renderOperations({boot:b,tab:'prompts'});assert.match(html,/Promptfoo prompt optimization/);assert.match(html,/action="\/api\/improvements"/);assert.match(html,/name="limits.maxCaseEvaluations"/);assert.match(html,/name="autoRetest"/);assert.doesNotMatch(html,/<option value="release-run"/);
});

test('run controls preserve recorded response/case outcomes and review denominators',()=>{
  const counts={responses:{pass:7,fail:1,needsReview:4,total:12},cases:{pass:2,fail:1,needsReview:1,total:4},reviews:{required:5,resolved:2,pending:3}};
  const bundle={run:{id:'saved',status:'COMPLETED'},snapshot:{dataset:{cases:[]}},result:{decision:'REVIEW',reasons:[],outcomes:{baseline:counts,candidate:counts}},progress:{done:18,total:18,failed:0}};
  const html=ui.renderOperations({boot,tab:'run',bundle});
  assert.match(html,/7 Pass · 1 Fail · 4 Needs review/);assert.match(html,/2 Pass · 1 Fail · 1 Needs review/);assert.match(html,/2 of 5 required reviews resolved/);
});
test('historical controls display original rates and explicitly mark unrecorded response outcomes',()=>{
  const bundle={historical:true,run:{id:'saved',status:'COMPLETED'},snapshot:{dataset:{cases:[]}},result:{decision:'BLOCK',baseline:0.9,candidate:0.7,reasons:[]},progress:{done:18,total:18,failed:0}};
  const html=ui.renderOperations({boot,tab:'run',bundle});assert.match(html,/90.0%/);assert.match(html,/70.0%/);assert.match(html,/Response outcomes: Not recorded/);
});
test('review search retains saved example numbering and case identities',()=>{
  const html=ui.renderOperations({boot,tab:'reviews',queue:[{caseIndex:13,caseId:'REL-014',category:'payment',runId:'r',outputId:'o',repeat:2,checks:[],judges:[],reviewReady:false}]});
  assert.match(html,/id="review-search"/);assert.match(html,/data-case-index="13"/);assert.match(html,/data-case-id="REL-014"/);assert.match(html,/Example 14/);
  const target=new URL(html.match(/href="([^"]+)"[^>]*>Compare invoice facts/)[1],'http://127.0.0.1');
  assert.deepEqual(JSON.parse(target.searchParams.get('filter')),[{type:'metadata',operator:'equals',field:'caseId',value:'REL-014'}]);
});
