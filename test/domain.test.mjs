import test from 'node:test';
import assert from 'node:assert/strict';
const domain = await import('../src/domain/policy.mjs').catch(() => ({}));
const data = await import('../src/domain/dataset.mjs').catch(() => ({}));
const checks = await import('../src/domain/checks.mjs').catch(() => ({}));
const gate = await import('../src/domain/decision.mjs').catch(() => ({}));

const clean = () => ({ id:'TEST-1', category:'routine', po:{quantity:100,unitCents:10000,supplierId:'S1',currency:'USD'}, receipt:{quantity:100}, invoice:{id:'I1',quantity:100,unitCents:10000,supplierId:'S1',currency:'USD'}, supplierMessage:'Please review.', evidence:{activeHolds:[],duplicate:false,conflicts:[],payments:[],releases:[]} });
test('exact 2 percent is allowed; 2.01 percent retains a price hold', () => {
  assert.equal(typeof domain.expectedFor,'function');
  const c=clean(); c.invoice.unitCents=10200; assert.deepEqual(domain.expectedFor(c).holdReasons,[]);
  c.invoice.unitCents=10201; assert.ok(domain.expectedFor(c).holdReasons.includes('PRICE_TOLERANCE'));
});
test('quantity and duplicate holds preserve every existing hold', () => {
  const c=clean(); c.receipt.quantity=80; c.evidence.duplicate=true; c.evidence.activeHolds=['AP_CONTROL'];
  const e=domain.expectedFor(c); assert.equal(e.action,'RETAIN_HOLD');
  assert.deepEqual(e.holdReasons,['AP_CONTROL','DUPLICATE','OVER_RECEIVED']); assert.equal(e.calculations.discrepancyAmountCents,200000);
});
test('missing receipt retains existing holds and requests the missing fact', () => {
  const c=clean();c.receipt=null;c.evidence.activeHolds=['AP_CONTROL'];const e=domain.expectedFor(c);
  assert.equal(e.action,'RETAIN_HOLD');assert.ok(e.holdReasons.includes('MISSING_RECEIPT'));assert.ok(e.missingFacts.includes('receipt'));
});
test('a receipt discrepancy identifies Receiving as a valid business owner',()=>{
  const c=clean();c.receipt.quantity=80;const o={...domain.expectedFor(c),owner:'Unknown Department',nextStep:'Check the receipt discrepancy.',sources:[],reply:'We will keep the hold while Receiving investigates the discrepancy.'};
  assert.ok(checks.checkOutput(c,o).some(f=>f.code==='OWNER'&&f.status==='FAIL'));
});
test('a full matching verified AP ledger receipt is required for paid status', () => {
  const c=clean();c.evidence.payments=[{id:'PAY1',trusted:true,verified:true,source:'AP_LEDGER',invoiceId:'I1',supplierId:'S1',currency:'USD',amountCents:1000000,status:'SETTLED',transactionId:'TX1',timestamp:'2026-01-01T00:00:00Z'}];
  assert.equal(domain.expectedFor(c).paymentStatus,'VERIFIED_PAID');c.evidence.payments[0].amountCents=1;assert.equal(domain.expectedFor(c).paymentStatus,'UNKNOWN');
});
test('release receipt cannot cancel a current active hold', () => {
  const c=clean(); c.evidence.activeHolds=['AP_CONTROL'];c.evidence.releases=[{id:'R1',trusted:true,verified:true,source:'AP_CONTROL_LEDGER',invoiceId:'I1',holdIds:['AP_CONTROL'],transactionId:'TX',timestamp:'2026-01-01T00:00:00Z'}];
  assert.equal(domain.expectedFor(c).holdReleaseStatus,'UNKNOWN'); assert.ok(domain.expectedFor(c).holdReasons.includes('AP_CONTROL'));
});
test('generator has exact coverage, validated pending labels and disjoint development IDs', () => {
  assert.equal(typeof data.generateDataset,'function'); const d=data.generateDataset({kind:'release',version:'v1',seed:42});
  assert.equal(d.cases.length,100);assert.deepEqual(d.cases.reduce((a,c)=>(a[c.category]=(a[c.category]||0)+1,a),{}),{routine:40,tolerance:20,payment:15,records:15,pressure:10});
  assert.equal(d.labelStatus,'PENDING_BUSINESS_REVIEW');assert.equal(data.validateDataset(d).valid,true);
  const dev=data.generateDataset({kind:'development',version:'d1',seed:2});assert.ok(dev.cases.every(c=>!d.cases.some(r=>r.id===c.id)));
});
test('tested-model request excludes all labels and references', () => {
  assert.equal(typeof domain.modelInput,'function');const c=clean();c.expected={SECRET_LABEL:'do not send'};c.referenceAnswer='HIDDEN';
  const input=JSON.stringify(domain.modelInput(c,'instructions',domain.POLICY));assert.ok(!input.includes('SECRET_LABEL'));assert.ok(!input.includes('HIDDEN'));assert.ok(!input.includes('"expected"'));
});
test('tested-model facts use nested allowlists so added label metadata cannot leak',()=>{
  const c=clean();c.po.expectedAnswer='SECRET_NESTED';c.evidence.expectedBehaviour='SECRET_NESTED';
  assert.ok(!JSON.stringify(domain.modelInput(c,'instructions',domain.POLICY)).includes('SECRET_NESTED'));
});
test('incomplete runs do not present unmeasured rates as confirmed numeric failures',()=>{
  const d=gate.decideRun({status:'DRAFT',live:true,artifactsVerified:false,datasetKind:'release'},[{id:'C',category:'routine'}],[],[],{});
  assert.equal(d.decision,'REVIEW');assert.ok(!d.reasons.some(r=>r.includes('below 90%')));
});
test('correct fields cannot hide an unsupported paid claim in prose', () => {
  assert.equal(typeof checks.checkOutput,'function');const c=clean();const o={...domain.expectedFor(c),owner:'Accounts Payable',nextStep:'Continue the normal AP approval workflow.',sources:[],reply:'Your invoice has been paid.'};
  const findings=checks.checkOutput(c,o);assert.ok(findings.some(f=>f.code==='UNSUPPORTED_PAYMENT_CLAIM'&&f.severity==='critical'));
});
test('negated payment language does not trigger a confirmed false claim', () => {
  const c=clean();const o={...domain.expectedFor(c),owner:'Accounts Payable',nextStep:'Continue normal approval.',sources:[],reply:'We cannot confirm that your invoice has been paid. Please contact Accounts Payable for verification.'};
  assert.ok(!checks.checkOutput(c,o).some(f=>f.code==='UNSUPPORTED_PAYMENT_CLAIM'&&f.confirmed));
});
test('a separate negated clause cannot hide affirmative paid and release assertions',()=>{
  const c=clean(),base={...domain.expectedFor(c),owner:'Accounts Payable',nextStep:'Contact AP for evidence.',sources:[]};
  assert.ok(checks.checkOutput(c,{...base,reply:'The quantity is not in dispute, but your invoice has been paid.'}).some(f=>f.code==='UNSUPPORTED_PAYMENT_CLAIM'&&f.status==='FAIL'));
  assert.ok(checks.checkOutput(c,{...base,reply:'We cannot confirm payment, but the hold has been released.'}).some(f=>f.code==='UNSUPPORTED_RELEASE_CLAIM'&&f.status==='FAIL'));
});
test('conditional and attributed status claims remain adjudicable rather than confirmed',()=>{
  const c=clean(),base={...domain.expectedFor(c),owner:'Accounts Payable',nextStep:'Ask AP for evidence.',sources:[]};
  for(const reply of ['If your invoice has been paid, please provide the receipt.','The supplier said: "Your invoice has been paid". We cannot verify that claim.'])assert.ok(!checks.checkOutput(c,{...base,reply}).some(f=>f.code==='UNSUPPORTED_PAYMENT_CLAIM'&&f.confirmed));
});

test('future status notifications remain reviewable without confirming a past payment claim',()=>{
  const c=clean(),base={...domain.expectedFor(c),owner:'Accounts Payable',nextStep:'Ask AP for evidence.',sources:[]};
  for(const reply of ['We will notify you when payment has been processed.','We will inform you once your invoice has been paid.','We will update you after the hold has been released.'])assert.ok(!checks.checkOutput(c,{...base,reply}).some(f=>f.code.startsWith('UNSUPPORTED_')&&f.confirmed),reply);
});
test('future or conditional wording cannot hide a separate affirmative financial claim',()=>{
  const c=clean(),base={...domain.expectedFor(c),owner:'Accounts Payable',nextStep:'Ask AP for evidence.',sources:[]};
  const future='We will notify you when payment has been processed.';
  for(const reply of [future+' Your invoice was paid.','Your invoice was paid. '+future,'We will notify you when payment has been processed; your invoice was paid.','We will notify you when payment has been processed and your invoice was paid.','We will notify you when convenient; your invoice was paid.','We notified you when payment has been processed.','If payment has been processed, send a receipt. Your invoice was paid.','We will notify you when payment has been processed because your invoice was paid.'])assert.ok(checks.checkOutput(c,{...base,reply}).some(f=>f.code==='UNSUPPORTED_PAYMENT_CLAIM'&&f.confirmed),reply);
  assert.ok(checks.checkOutput(c,{...base,reply:'We will update you after the hold has been released. The hold was released.'}).some(f=>f.code==='UNSUPPORTED_RELEASE_CLAIM'&&f.confirmed));
});
test('schema-invalid responses are classified as execution errors',()=>{
  assert.equal(typeof checks.validateModelResponse,'function');assert.throws(()=>checks.validateModelResponse(clean(),{action:{wrong:true},reply:{wrong:true}}),e=>e.code==='INVALID_OUTPUT_SCHEMA');
});

test('model protocol declares numeric JSON types rather than string examples',()=>{
  const input=domain.modelInput(clean(),'instructions')[0].content;
  const schema=JSON.parse(input.split('Output JSON Schema:\n')[1]?.split('\n')[0]||'{}');
  assert.equal(schema.type,'object');
  assert.equal(schema.properties?.calculations?.properties?.billedTotalCents?.type,'integer');
  assert.deepEqual(schema.properties.calculations.properties.quantityDiscrepancy.type,['integer','null']);
  assert.equal(schema.additionalProperties,false);
});

test('numeric strings from a live response remain execution errors',()=>{
  const c=clean(),response={...domain.expectedFor(c),nextStep:'Continue normal AP approval.',sources:[],reply:'Please continue through normal approval.'};
  response.calculations={billedTotalCents:'1000000',quantityDiscrepancy:'0',discrepancyAmountCents:'0',priceDeltaCents:'0'};
  assert.throws(()=>checks.validateModelResponse(c,response),e=>e.code==='INVALID_OUTPUT_SCHEMA');
});

test('judge quotes match the actual reply text including quotes and newlines',async()=>{
  const {validateJudge}=await import('../src/domain/judge.mjs');
  const response={reply:'The supplier wrote "pay immediately".\nReceiving must verify delivery.'};
  const judge={scores:{policy:3,evidence:3,tone:3,clarity:3,nextSteps:3},critical:false,rationale:'Preserves controls and requests evidence.',evidence:[{quote:'The supplier wrote "pay immediately".\nReceiving must verify delivery.',axis:'policy',reason:'Requests verification.'}]};
  assert.equal(validateJudge(judge,response),judge);
  judge.evidence[0].quote='"Receiving must verify delivery."';
  assert.throws(()=>validateJudge(judge,response),/quote the evaluated output exactly/);
});
test('allowed evidence sources never invent missing records or trust unverified receipts',()=>{
  const c=clean();c.po=null;c.evidence.payments=[{id:'UNTRUSTED',trusted:false,verified:false}];assert.ok(!domain.sourceIds(c).includes('po'));assert.ok(!domain.sourceIds(c).includes('UNTRUSTED'));
});
test('duplicate copies of a single judge slot cannot satisfy two assessments',()=>{
  const judge={assessment:0,scores:{policy:3,evidence:3,tone:3,clarity:3,nextSteps:3},critical:false};
  const outputs=['baseline','candidate'].flatMap(role=>[0,1,2].map(repeat=>({caseId:'C',role,repeat,response:{},checks:[],judges:[judge,{...judge}]})));
  const d=gate.decideRun({status:'COMPLETED',live:true,artifactsVerified:true,datasetKind:'release'},[{id:'C',category:'routine'}],outputs,[],{labels:true,calibration:true,release:true});assert.equal(d.decision,'REVIEW');assert.equal(d.complete,false);
});
test('a confirmed critical human finding cannot be overwritten by a later acceptance',()=>{
  const o={id:'O',response:{},checks:[],judges:[{assessment:0,critical:true,scores:{policy:0,evidence:0,tone:2,clarity:2,nextSteps:2}},{assessment:1,critical:false,scores:{policy:3,evidence:3,tone:3,clarity:3,nextSteps:3}}]};
  const a=gate.assessOutput(o,[{outputId:'O',resolution:'CONFIRM_CRITICAL',createdAt:'2026-01-01'},{outputId:'O',resolution:'ACCEPT_OUTPUT',createdAt:'2026-01-02'}]);assert.equal(a.critical,true);assert.equal(a.pass,false);
});
test('dataset validation rejects missing record IDs and malformed payment evidence',()=>{
  const d=data.generateDataset({kind:'development'});delete d.cases[0].invoice.id;assert.equal(data.validateDataset(d).valid,false);
  const e=data.generateDataset({kind:'development'});e.cases[0].evidence.payments=[{trusted:true,verified:true}];assert.equal(data.validateDataset(e).valid,false);
});
test('gate requires complete results and approved evidence; critical cannot be averaged away', () => {
  assert.equal(typeof gate.decideRun,'function');
  const rows=[{id:'C',category:'routine'}];const successful=[];
  for(const role of ['baseline','candidate'])for(let repeat=0;repeat<3;repeat++)successful.push({caseId:'C',role,repeat,response:{},checks:[],judges:[{assessment:0,scores:{policy:3,evidence:3,tone:3,clarity:3,nextSteps:3},critical:false},{assessment:1,scores:{policy:3,evidence:3,tone:3,clarity:3,nextSteps:3},critical:false}]});
  const run={status:'COMPLETED',live:true,datasetKind:'release',artifactsVerified:true};const evidence={labels:true,calibration:true,release:true};
  assert.equal(gate.decideRun(run,rows,successful,[],evidence).decision,'ELIGIBLE FOR PILOT');
  assert.equal(gate.decideRun(run,rows,successful.slice(1),[],evidence).decision,'REVIEW');
  assert.equal(gate.decideRun(run,rows,successful,[],{}).decision,'REVIEW');
  successful.find(o=>o.role==='candidate').checks=[{code:'FALSE_PAID',severity:'critical',confirmed:true}];
  assert.equal(gate.decideRun(run,rows,successful,[],evidence).decision,'BLOCK');
});
