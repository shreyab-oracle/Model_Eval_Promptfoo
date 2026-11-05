import test from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../src/optimization/engine.mjs';
import * as runner from '../src/optimization/runner.mjs';
import * as runs from '../src/services/runs.mjs';
import * as history from '../src/services/history.mjs';
import {digest} from '../src/domain/policy.mjs';
import * as version from '../src/optimization/version.mjs';
import {config} from '../src/config.mjs';

function fixture(){
  const docs=[];let calls=0;
  const store={docs:async(kind,parentId)=>docs.filter(d=>d.kind===kind&&d.parentId===parentId),doc:async id=>docs.find(d=>d.id===id),saveDoc:async d=>{docs.push({...d,...d.value});return d.id;}};
  const snapshot={sourceRunId:'source',source:{prompt:'Original reusable invoice instructions.',policy:{text:'Keep required holds.'},dataset:{cases:[]},models:{judge:'judge'},modes:{judge:'ON_DEMAND'},judgeSettings:{}},optimizer:{limits:{maxProposals:1}}};
  const invoke=async()=>{calls++;return{text:JSON.stringify({text:'Revised reusable invoice instructions. Keep every required hold.',rationale:'Clarify holds using the recorded development feedback.'})};};
  return{store,docs,snapshot,invoke,calls:()=>calls};
}
test('resuming suggestion generation replays the saved proposal despite changed feedback serialization',async()=>{
  assert.equal(typeof engine.createOptimizationProposer,'function');
  const f=fixture(),options={snapshot:f.snapshot,jobId:'job',store:f.store,invoke:f.invoke,guard:async()=>{}};
  const first=await engine.createOptimizationProposer(options)({text:f.snapshot.source.prompt,feedback:{failed:'one'}});
  const replay=await engine.createOptimizationProposer(options)({text:f.snapshot.source.prompt,feedback:{failed:'different serialization'}});
  assert.equal(replay.text,first.text);assert.equal(f.calls(),1);assert.equal(f.docs.length,1);
  await assert.rejects(()=>engine.createOptimizationProposer(options)({text:'A different original prompt, outside the recorded proposal chain.',feedback:{}}),/parent|frozen/i);
  assert.equal(f.calls(),1);
});
test('ambiguous saved proposal iterations stop without making another paid request',async()=>{
  assert.equal(typeof engine.createOptimizationProposer,'function');
  const f=fixture();for(const text of ['First revised reusable invoice instructions.','Second revised reusable invoice instructions.'])f.docs.push({kind:'GEPA_CANDIDATE',parentId:'job',iteration:1,text,parentPromptDigest:digest(f.snapshot.source.prompt)});
  await assert.rejects(()=>engine.createOptimizationProposer({snapshot:f.snapshot,jobId:'job',store:f.store,invoke:f.invoke,guard:async()=>{}})({text:f.snapshot.source.prompt,feedback:{}}),/ambiguous|multiple/i);
  assert.equal(f.calls(),0);
});
test('a received proposal survives interruption before its candidate document is saved',async()=>{
  const f=fixture();f.docs.push({id:'received-start',kind:'GEPA_CALL_START',parentId:'job',operation:'propose/1'},{id:'received-result',kind:'GEPA_CALL_RESULT',parentId:'job',startId:'received-start',success:true,artifact:{key:'saved-receipt'}});
  const loadTrace=async()=>({text:JSON.stringify({text:'The already received reusable revised invoice instructions.',rationale:'Previously received valid development suggestion.'}),options:{messages:[{content:JSON.stringify({currentPrompt:f.snapshot.source.prompt})}]}});
  const proposal=await engine.createOptimizationProposer({snapshot:f.snapshot,jobId:'job',store:f.store,invoke:f.invoke,loadTrace})({text:f.snapshot.source.prompt,feedback:{changed:'yes'}});
  assert.equal(proposal.text,'The already received reusable revised invoice instructions.');assert.equal(f.calls(),0);
  assert.equal(f.docs.filter(d=>d.kind==='GEPA_CANDIDATE').length,1);assert.equal(proposal.responseSource,'SAVED_RESPONSE');
});
test('optimizer deadline permits the declared number of individually bounded model calls',()=>{
  assert.equal(typeof runner.optimizerTimeoutMs,'function');
  assert.ok(runner.optimizerTimeoutMs({maxCalls:433},180000)>=77940000);
  assert.throws(()=>runner.optimizerTimeoutMs({maxCalls:NaN},180000));
});
test('a changed backend request timeout cannot resume a frozen optimizer budget',()=>{
  const snapshot={optimizer:{name:version.OPTIMIZER_NAME,version:version.OPTIMIZER_VERSION,digest:version.OPTIMIZER_DIGEST,requestTimeoutMs:config.timeoutMs+1000}};
  assert.throws(()=>version.assertOptimizer(snapshot),/timeout/i);
});
test('exhausted optimization resumes are rejected before recovery or run mutations',async()=>{
  const mutations=[];
  const store={tasks:async()=>[{stage:'PROPOSE',status:'FAILED'}],docs:async()=>[{id:'one'}],resume:async()=>{mutations.push('resume');},run:async()=>({})};
  await assert.rejects(()=>runs.resumeRun('job',{store,loadSnapshot:async()=>({snapshot:{optimizer:{limits:{maxCalls:1}}}}),recover:async()=>{mutations.push('recover');}}),{code:'OPTIMIZATION_BUDGET_EXHAUSTED'});
  assert.deepEqual(mutations,[]);
});
test('a completed suggestion task may resume its authorized retest after the optimization budget is used',async()=>{
  const mutations=[];
  const store={tasks:async()=>[{stage:'PROPOSE',status:'DONE'},{stage:'RETEST',status:'PENDING'}],docs:async()=>[{id:'one'}],resume:async()=>{mutations.push('resume');},run:async()=>({id:'job'})};
  assert.equal((await runs.resumeRun('job',{store,loadSnapshot:async()=>({snapshot:{optimizer:{limits:{maxCalls:1}}}}),recover:async()=>{mutations.push('recover');}})).id,'job');
  assert.deepEqual(mutations,['recover','resume']);
});
test('archiving an inactive optimizer writes one audit record without deleting its evidence',async()=>{
  assert.equal(typeof history.archiveOptimization,'function');
  const f=fixture();f.store.run=async()=>({id:'job',kind:'improvement',status:'INCOMPLETE'});f.store.tasks=async()=>[];
  const first=await history.archiveOptimization('job',{actor:'reviewer',reason:'Hide the exhausted job.'},{store:f.store});
  assert.equal(await history.archiveOptimization('job',{actor:'reviewer',reason:'Hide the exhausted job.'},{store:f.store}),first);
  assert.equal(f.docs.length,1);assert.equal(f.docs[0].kind,'OPTIMIZATION_ARCHIVE');assert.equal(f.docs[0].parentId,'job');
  f.store.run=async()=>({kind:'improvement',status:'RUNNING'});
  await assert.rejects(()=>history.archiveOptimization('active',{actor:'reviewer',reason:'Not allowed.'},{store:f.store}),/active|running/i);
});

test('removing an archived optimization from view preserves its archive and evidence',async()=>{
  const f=fixture();f.store.run=async()=>({id:'job',kind:'improvement',status:'INCOMPLETE'});f.store.tasks=async()=>[];
  f.docs.push({id:'draft',kind:'GEPA_CANDIDATE',parentId:'job',text:'Keep this saved draft.'});
  const archiveId=await history.archiveOptimization('job',{actor:'reviewer',reason:'Archive.'},{store:f.store});
  const hiddenId=await history.archiveOptimization('job',{actor:'reviewer',reason:'Remove both unfinished drafts from view.',hide:true},{store:f.store});
  assert.notEqual(hiddenId,archiveId);
  assert.equal(f.docs.find(d=>d.id===hiddenId).hidden,true);
  assert.equal(f.docs.find(d=>d.id==='draft').text,'Keep this saved draft.');
  assert.ok(f.docs.find(d=>d.id===archiveId));
  assert.equal(await history.archiveOptimization('job',{actor:'reviewer',reason:'Remove again.',hide:true},{store:f.store}),hiddenId);
  assert.equal(f.docs.length,3);
});
