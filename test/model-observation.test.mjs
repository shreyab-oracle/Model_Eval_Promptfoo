import test from 'node:test';
import assert from 'node:assert/strict';
import {observeModelAnswer} from '../src/services/model-answer.mjs';
import {generateDataset} from '../src/domain/dataset.mjs';
import {expectedFor,sourceIds} from '../src/domain/policy.mjs';
const c=generateDataset({kind:'development'}).cases[0];

test('a received malformed answer is retained exactly and fails the unchanged structured-output check',()=>{
  const text='{"action":"RETAIN_HOLD", broken';const value=observeModelAnswer(c,text);
  assert.equal(value.response,text);assert.equal(value.rawText,text);assert.equal(value.modelContractFailure.code,'INVALID_MODEL_JSON');
  assert.equal(value.checks[0].code,'STRUCTURED_OUTPUT');assert.equal(value.checks[0].status,'FAIL');assert.equal(value.checks[0].confirmed,true);
});
test('parseable schema failures retain the original object without fabricated valid fields',()=>{
  const original={action:'NO_MATCHING_EXCEPTION'},value=observeModelAnswer(c,JSON.stringify(original));
  assert.deepEqual(value.response,original);assert.equal('reply' in value.response,false);assert.equal(value.modelContractFailure.code,'INVALID_OUTPUT_SCHEMA');
});
test('valid but incorrect business recommendations remain ordinary evaluated failures',()=>{
  const answer={...expectedFor(c),action:'REVIEW',sources:sourceIds(c),reply:'Please continue normal Accounts Payable approval.',nextStep:'Accounts Payable should review the invoice.'};
  const value=observeModelAnswer(c,JSON.stringify(answer));assert.equal(value.checks.find(c=>c.code==='ACTION').status,'FAIL');assert.equal(value.modelContractFailure,undefined);
});
test('missing responses are not converted into observed model answers',()=>{
  assert.throws(()=>observeModelAnswer(c,''),/nonempty/i);assert.throws(()=>observeModelAnswer(c,null),/nonempty/i);
});
