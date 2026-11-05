import {assertDevelopment} from './prompt.mjs';
export function optimizationLimits({maxCaseEvaluations=48,maxProposals=3}={}){
  if(!Number.isInteger(maxCaseEvaluations)||maxCaseEvaluations<24||maxCaseEvaluations>120||!Number.isInteger(maxProposals)||maxProposals<1||maxProposals>6)throw new Error('Optimization limits require 24–120 case evaluations and 1–6 proposals');
  return{maxCaseEvaluations,maxProposals,maxCalls:maxCaseEvaluations*9+maxProposals};
}
export function optimizationPlan(dataset){
  assertDevelopment(dataset);const trainIds=[],validationIds=[];
  for(const category of [...new Set(dataset.cases.map(c=>c.category))].sort()){
    const rows=dataset.cases.filter(c=>c.category===category).sort((a,b)=>a.id.localeCompare(b.id));
    if(rows.length<2)throw new Error('Development optimization requires at least two cases per category');
    const count=Math.max(1,Math.floor(rows.length/3));validationIds.push(...rows.slice(-count).map(c=>c.id));trainIds.push(...rows.slice(0,-count).map(c=>c.id));
  }
  return{trainIds,validationIds};
}
export function selectOptimizationCandidate(seed,cases,evaluations){
  const variants=[...new Set([seed,...evaluations.map(e=>e.text)])];
  const stats=text=>{
    const rows=cases.map(c=>evaluations.find(e=>e.text===text&&e.caseId===c.id));
    return{text,evaluated:rows.every(r=>r&&(r.attempted??r.complete)),complete:rows.every(r=>r?.complete),safe:!evaluations.some(e=>e.text===text&&(e.critical||e.pending||!e.complete||e.executionErrors>0)),passed:rows.filter(r=>r?.pass).length,categories:Object.fromEntries([...new Set(cases.map(c=>c.category))].map(cat=>[cat,cases.filter((c,i)=>c.category===cat&&rows[i]?.pass).length]))};
  };
  const base=stats(seed),ranked=variants.map(stats).filter(v=>v.text!==seed&&base.evaluated&&v.complete&&v.safe&&v.passed>base.passed&&Object.keys(base.categories).every(cat=>v.categories[cat]>=base.categories[cat])).sort((a,b)=>b.passed-a.passed);
  const best=ranked[0]||base;
  return{text:best.text,changed:best.text!==seed,baselinePassed:base.passed,selectedPassed:best.passed,validationCases:cases.length,candidates:variants.map(stats),rationale:ranked.length?'Improved development validation with no category regression, critical findings or pending judge disagreements. Business approval and independent release evaluation remain required.':'No acceptable improvement established; the original prompt is retained.'};
}
