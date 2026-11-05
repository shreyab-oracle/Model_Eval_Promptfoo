import test from 'node:test';
import assert from 'node:assert/strict';
import {assertFrozenEngine,ENGINE_DIGEST} from '../src/domain/version.mjs';
import {judgeTemplates} from '../src/domain/judge.mjs';
import {digest,POLICY} from '../src/domain/policy.mjs';

const templates=judgeTemplates(POLICY);
const snapshot={engineDigest:ENGINE_DIGEST,judgeTemplates:templates,judgeTemplateDigest:digest(templates)};

test('frozen evaluations require the exact current engine',()=>{
  assert.doesNotThrow(()=>assertFrozenEngine(snapshot));
  for(const engineDigest of ['outdated-engine',undefined]){
    assert.throws(()=>assertFrozenEngine({...snapshot,engineDigest}),{code:'ENGINE_VERSION_MISMATCH'});
  }
});

test('a current engine still rejects missing or changed frozen judge instructions',()=>{
  assert.throws(()=>assertFrozenEngine({...snapshot,judgeTemplates:undefined}),/judge instructions/i);
  assert.throws(()=>assertFrozenEngine({...snapshot,judgeTemplates:templates.slice(0,1)}),/judge instructions/i);
  assert.throws(()=>assertFrozenEngine({...snapshot,judgeTemplateDigest:'changed'}),/judge instructions/i);
});
