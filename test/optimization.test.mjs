// Isolated software tests. No application mock providers or model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateDataset} from '../src/domain/dataset.mjs';
const domain=await import('../src/domain/optimization.mjs').catch(()=>({}));

test('Prompt optimization development split is deterministic, disjoint and covers every category',()=>{
  assert.equal(typeof domain.optimizationPlan,'function');
  const d=generateDataset({kind:'development'}),plan=domain.optimizationPlan(d);
  assert.deepEqual(plan,domain.optimizationPlan(d));
  assert.equal(plan.trainIds.length+plan.validationIds.length,24);
  assert.equal(new Set([...plan.trainIds,...plan.validationIds]).size,24);
  for(const category of new Set(d.cases.map(c=>c.category)))for(const ids of [plan.trainIds,plan.validationIds])assert.ok(ids.some(id=>d.cases.find(c=>c.id===id).category===category));
  assert.throws(()=>domain.optimizationPlan(generateDataset({kind:'release'})),/development/i);
});
test('Prompt optimization limits count all nine calls per case and protect against oversized jobs',()=>{
  assert.equal(typeof domain.optimizationLimits,'function');
  assert.equal(domain.optimizationLimits().maxCalls,435);
  assert.throws(()=>domain.optimizationLimits({maxCaseEvaluations:100000}),/limit/i);
  assert.throws(()=>domain.optimizationLimits({maxProposals:0}),/limit/i);
});
test('Prompt optimization final selection rejects critical, pending, incomplete and category-regressing variants',()=>{
  assert.equal(typeof domain.selectOptimizationCandidate,'function');
  const cases=[{id:'a',category:'x'},{id:'b',category:'y'},{id:'c',category:'y'}];
  const row=(text,caseId,pass,extra={})=>({text,caseId,pass,critical:false,pending:false,complete:true,...extra});
  const rows=[...cases.map(c=>row('seed',c.id,c.id==='a')),...cases.map(c=>row('unsafe',c.id,true,{critical:c.id==='b'})),...cases.map(c=>row('regression',c.id,c.id!=='a')),...cases.slice(0,2).map(c=>row('incomplete',c.id,true)),...cases.map(c=>row('pending',c.id,true,{pending:true})),...cases.map(c=>row('safe',c.id,true))];
  const result=domain.selectOptimizationCandidate('seed',cases,rows);assert.equal(result.text,'safe');assert.equal(result.changed,true);
  const unchanged=domain.selectOptimizationCandidate('seed',cases,rows.filter(r=>r.text!=='safe'));assert.equal(unchanged.text,'seed');assert.equal(unchanged.changed,false);
});
