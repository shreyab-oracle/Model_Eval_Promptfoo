import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {evaluateRequest} from '../src/evaluation/adapter.mjs';
import {outputFindings,recordedFindings} from '../src/evaluation/findings.mjs';
const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/promptfoo-parity.json',import.meta.url)));

test('Promptfoo findings retain exact field evidence and distinguish uncertainty from confirmed failure',async()=>{
  const answer={...structuredClone(fixture.answer),holdReasons:['UNEXPECTED_HOLD'],reply:'The supplier claims payment was made. Please keep all controls while Accounts Payable checks the ledger.'};
  const result=await evaluateRequest({stage:'GENERATE',c:fixture.case,policyReference:'demo-policy-v1',receivedResponse:{text:JSON.stringify(answer)}});
  const hold=result.evaluation.findings.find(f=>f.checkId==='HOLD_PRESERVATION');
  assert.equal(hold.status,'FAIL');assert.equal(hold.confirmed,true);
  assert.deepEqual(hold.actual,['UNEXPECTED_HOLD']);assert.deepEqual(hold.expected,[]);
  assert.equal(hold.evidence.field,'holdReasons');assert.equal(hold.ruleReference,'demo-policy-v1');
  const payment=result.evaluation.findings.find(f=>f.checkId==='UNSUPPORTED_PAYMENT_CLAIM');
  assert.equal(payment.status,'NEEDS_REVIEW');assert.equal(payment.confirmed,false);assert.equal(payment.requiresHumanReview,true);
  assert.equal(payment.evidence.excerpt,answer.reply);
  assert.equal(result.value.checks.find(c=>c.code===payment.checkId).status,'FAIL','the original gate input must remain unchanged');
});

test('Promptfoo exposes judge axes at their original 0 to 3 scale separately from programmed findings',async()=>{
  const result=await evaluateRequest({stage:'JUDGE',c:fixture.case,evaluatedOutput:fixture.answer,receivedResponse:{text:JSON.stringify(fixture.judge)}});
  assert.deepEqual(result.evaluation.namedScores,fixture.judge.scores);
  assert.equal(result.evaluation.findings,undefined);
  assert.deepEqual(result.value.assessmentResult,fixture.judge);
});

test('historical finding display uses only recorded evidence without inventing expected values or versions',()=>{
  const output={response:{calculations:{quantityDiscrepancy:null}},checks:[{code:'CALC_QUANTITYDISCREPANCY',status:'PASS',severity:'major',message:'Saved check'}]};
  const original=structuredClone(output),finding=outputFindings(output)[0];
  assert.equal(finding.expected,null);assert.equal(finding.evaluatorVersion,null);assert.equal(finding.ruleReference,null);
  assert.equal(finding.actual,null);assert.equal(finding.actualRecorded,true);assert.equal(finding.expectedRecorded,false);
  assert.deepEqual(output,original);
  assert.deepEqual(recordedFindings(undefined),[]);
});

test('saved structured findings survive presentation without recalculation',()=>{
  const saved=[{checkId:'OLD_CONTROL',name:'Original control',status:'FAIL',evaluatorVersion:'archived-v1'}];
  assert.equal(outputFindings({evaluation:{findings:saved},checks:[]}),saved);
});

test('fresh and replayed responses are distinguished without resampling',async()=>{
  let calls=0;const response={text:JSON.stringify(fixture.answer)};
  const options={stage:'GENERATE',c:fixture.case,call:async()=>{calls++;return response;}};
  assert.equal((await evaluateRequest(options)).responseSource,'FRESH_MODEL_RESPONSE');
  assert.equal((await evaluateRequest({...options,receivedResponse:response})).responseSource,'SAVED_RESPONSE');
  assert.equal((await evaluateRequest({...options,call:async()=>({...response,responseSource:'SAVED_RESPONSE'})})).responseSource,'SAVED_RESPONSE');
  assert.equal(calls,1);
});
