import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import childProcess from 'node:child_process';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import OptimizationCaseProvider,{assertAssessment} from '../src/optimization/promptfoo-provider.mjs';
const runner=await import('../src/optimization/runner.mjs').catch(()=>({}));
const input={prompt:'Follow the frozen invoice policy and preserve all required holds.',trainIds:['a','b'],validationIds:['c','d'],limits:{maxCaseEvaluations:24,maxProposals:1}};

test('installed Promptfoo optimizer proposes and tests revisions through backend callbacks without duplicate case execution',async()=>{
  assert.equal(typeof runner.runPromptfooOptimizer,'function');const evaluated=[],proposed=[];
  const result=await runner.runPromptfooOptimizer(input,async request=>{
    if(request.operation==='propose'){proposed.push(request);return{text:input.prompt+' Explicitly identify missing records.'};}
    evaluated.push(request);return{rows:request.caseIds.map(caseId=>({caseId,pass:request.text!==input.prompt,complete:true,feedback:{explanation:'Saved business assessment'}}))};
  },{timeoutMs:30000});
  assert.equal(result.version,'0.125.1');assert.equal(result.optimizer,'Promptfoo');assert.equal(proposed.length,1);
  assert.equal(evaluated.length,8);assert.equal(new Set(evaluated.map(r=>r.text+'/'+r.caseIds[0])).size,8);
  assert.ok(evaluated.some(r=>r.text!==input.prompt));assert.equal(result.evaluated,8);assert.match(result.log,/Prompt optimization result/);
  assert.match(result.log,/Optimization improved validation score from 0\.0000 to 2\.0000/);
  assert.doesNotMatch(result.log,/Provider call failed during eval/);
});

test('case budget stops native optimization before a further proposal or model evaluation',async()=>{
  assert.equal(typeof runner.runPromptfooOptimizer,'function');let cases=0,proposals=0;
  const result=await runner.runPromptfooOptimizer({...input,limits:{maxCaseEvaluations:4,maxProposals:1}},async request=>{
    if(request.operation==='propose'){proposals++;return{text:'unreachable'};}
    cases++;return{rows:request.caseIds.map(caseId=>({caseId,pass:false,complete:true}))};
  },{timeoutMs:30000});
  assert.equal(cases,4);assert.equal(proposals,0);assert.match(result.stopped,/case evaluation limit/);
});

test('cancelled native optimization cannot request backend model work',async()=>{
  assert.equal(typeof runner.runPromptfooOptimizer,'function');const controller=new AbortController();controller.abort();let calls=0;
  await assert.rejects(()=>runner.runPromptfooOptimizer(input,async()=>{calls++;},{signal:controller.signal}),{code:'OPTIMIZER_CANCELLED'});assert.equal(calls,0);
});

test('native optimizer cannot turn backend transport failures into model-quality results',async()=>{
  assert.equal(typeof runner.runPromptfooOptimizer,'function');let calls=0;
  await assert.rejects(()=>runner.runPromptfooOptimizer(input,async()=>{calls++;throw Object.assign(new Error('Saved trace storage unavailable'),{code:'ECONNRESET'});},{timeoutMs:30000}),/Saved trace storage unavailable/);
  assert.equal(calls,1);
});

test('native feedback preserves actionable answer failures before large case facts and response text',async t=>{
  const row={caseId:'a',pass:false,complete:false,executionErrors:3,feedback:{facts:{supplierMessage:'large fact '.repeat(300)},outputs:[{repeat:0,response:{action:'PRICE_TOLERANCE',reply:'large reply '.repeat(300)},error:{code:'INVALID_OUTPUT_SCHEMA',message:'action returned PRICE_TOLERANCE; expected RETAIN_HOLD or REQUEST_EVIDENCE'}}]}};
  t.mock.method(globalThis,'fetch',async()=>({ok:true,json:async()=>row}));
  const result=await new OptimizationCaseProvider().callApi('seed',{prompt:{raw:'seed'},vars:{caseId:'a'}});
  const grading=assertAssessment(result.output,{providerResponse:result});
  for(const text of [result.output,grading.reason]){
    assert.ok(text.length<=1200,'native optimizer clips feedback at 1200 characters');
    assert.match(text,/PRICE_TOLERANCE/);assert.match(text,/RETAIN_HOLD/);assert.match(text,/INVALID_OUTPUT_SCHEMA/);
  }
  assert.equal(result.metadata.assessment,row,'full recorded evidence stays available in metadata');
});

test('cancellation drains an in-flight backend receipt and prevents further callback work',async()=>{
  const controller=new AbortController();let release,started,calls=0,receiptSaved=false,settled=false;
  const pending=new Promise(resolve=>{release=resolve;}),begun=new Promise(resolve=>{started=resolve;});
  const completion=runner.runPromptfooOptimizer(input,async request=>{
    calls++;started();await pending;receiptSaved=true;
    return{rows:request.caseIds.map(caseId=>({caseId,pass:false,complete:true}))};
  },{signal:controller.signal,timeoutMs:30000});
  completion.then(()=>{settled=true;},()=>{settled=true;});
  try{
    await begun;controller.abort();await delay(100);
    assert.equal(settled,false,'runner must wait for already-started receipt persistence');
  }finally{release();}
  await assert.rejects(()=>completion,{code:'OPTIMIZER_CANCELLED'});
  assert.equal(receiptSaved,true);assert.equal(calls,1);
});

test('native optimization keeps the original budget and partition when its caller mutates input',async()=>{
  const frozen=structuredClone(input);let proposals=0,cases=0;
  const result=await runner.runPromptfooOptimizer(frozen,async request=>{
    frozen.limits.maxProposals=6;frozen.limits.maxCaseEvaluations=120;
    frozen.trainIds.splice(0,2,'unfrozen');frozen.validationIds.splice(0,2,'unfrozen-validation');
    if(request.operation==='propose')return{text:input.prompt+' Revision '+ ++proposals};
    cases++;assert.ok(['a','b','c','d'].includes(request.caseIds[0]));
    return{rows:request.caseIds.map(caseId=>({caseId,pass:request.text!==input.prompt,complete:true}))};
  },{timeoutMs:30000});
  assert.equal(result.proposed,1);assert.equal(proposals,1);assert.equal(cases,8);
});

test('invalid frozen partitions and budgets fail before backend work',async()=>{
  let calls=0;
  for(const invalid of [
    {...input,trainIds:[],validationIds:['a']},
    {...input,trainIds:['a','b'],validationIds:['a']},
    {...input,trainIds:[null,'b']},
    {...input,limits:{maxCaseEvaluations:3,maxProposals:1}},
    {...input,limits:{maxCaseEvaluations:24,maxProposals:NaN}},
  ])await assert.rejects(()=>runner.runPromptfooOptimizer(invalid,async()=>{calls++;}),/Invalid.*optimization/);
  assert.equal(calls,0);
});

function simulateNativeCallbacks(t,work){
  t.mock.method(childProcess,'spawn',(_binary,_args,{env})=>{
    const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>true});
    const request=async(url,body)=>{
      const response=await fetch(env.AIE_OPTIMIZER_ENDPOINT+url,{method:'POST',headers:{authorization:'Bearer '+env.AIE_OPTIMIZER_TOKEN,'content-type':'application/json'},body:JSON.stringify(body)});
      return response.json();
    };
    setImmediate(()=>work(request,child).catch(error=>child.emit('error',error)));
    return child;
  });
}

test('duplicate concurrent case and suggestion callbacks share one backend attempt',async t=>{
  simulateNativeCallbacks(t,async(request,child)=>{
    await Promise.all([request('/case',{text:input.prompt,caseId:'a'}),request('/case',{text:input.prompt,caseId:'a'})]);
    for(const caseId of ['b','c','d'])await request('/case',{text:input.prompt,caseId});
    const feedback={messages:[{role:'user',content:JSON.stringify({currentPrompt:input.prompt})}]};
    const results=await Promise.all([request('/v1/chat/completions',feedback),request('/v1/chat/completions',feedback)]);
    assert.deepEqual(results[0],results[1]);child.emit('close',0);
  });
  let evaluations=0,proposals=0;
  const result=await runner.runPromptfooOptimizer(input,async request=>{
    await delay(10);
    if(request.operation==='propose'){proposals++;return{text:input.prompt+' Revision'};}
    evaluations++;return{rows:request.caseIds.map(caseId=>({caseId,pass:false,complete:true}))};
  });
  assert.equal(result.evaluated,4);assert.equal(evaluations,4);assert.equal(proposals,1);
});

test('an exhausted case budget cannot mask an unexpected native CLI exit',async t=>{
  simulateNativeCallbacks(t,async(request,child)=>{
    for(const caseId of ['a','b','c','d'])await request('/case',{text:input.prompt,caseId});
    await request('/v1/chat/completions',{messages:[{role:'user',content:JSON.stringify({currentPrompt:input.prompt})}]});
    child.stderr.write('Unexpected native assertion loader failure\n');child.emit('close',1);
  });
  await assert.rejects(()=>runner.runPromptfooOptimizer({...input,limits:{maxCaseEvaluations:4,maxProposals:1}},async request=>({rows:request.caseIds.map(caseId=>({caseId,pass:false,complete:true}))})),/Unexpected native assertion loader failure/);
});

test('distinct overlapping suggestion requests cannot exceed the frozen proposal budget',async t=>{
  simulateNativeCallbacks(t,async(request,child)=>{
    for(const caseId of ['a','b','c','d'])await request('/case',{text:input.prompt,caseId});
    await Promise.all([[],[{score:0}]].map(searchHistory=>request('/v1/chat/completions',{messages:[{role:'user',content:JSON.stringify({currentPrompt:input.prompt,searchHistory})}]})));
    child.emit('close',0);
  });
  let proposals=0;
  const result=await runner.runPromptfooOptimizer({...input,limits:{maxCaseEvaluations:24,maxProposals:3}},async request=>{
    if(request.operation==='evaluate')return{rows:request.caseIds.map(caseId=>({caseId,pass:false,complete:true}))};
    const index=++proposals;await delay(10);return{text:input.prompt+' Revision '+index};
  });
  assert.equal(result.proposed,3);assert.equal(proposals,3);
});
