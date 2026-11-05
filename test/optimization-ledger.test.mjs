import test from 'node:test';
import assert from 'node:assert/strict';
const ledger=await import('../src/optimization/ledger.mjs').catch(()=>({}));
function fixture(){
  const docs=new Map(),traces=new Map();let calls=0,allowed=true;
  const store={doc:async id=>docs.get(id),docs:async(kind,parentId)=>[...docs.values()].filter(d=>d.kind===kind&&d.parentId===parentId),saveDoc:async d=>{docs.set(d.id,{...d,...d.value});return d.id;}};
  const io={jobId:'unit-only',cycle:0,maxCalls:1,store,guard:async()=>{if(!allowed)throw new Error('cancelled');},writeTrace:async(id,value)=>{traces.set(id,value);return{id};},loadTrace:async ref=>traces.get(ref.id),call:async()=>{calls++;return{text:'saved',raw:{chatResponse:{}}};}};
  return{docs,io,calls:()=>calls,cancel:()=>{allowed=false;}};
}
test('Prompt optimization ledger replays saved calls without new requests and enforces the total limit',async()=>{
  assert.equal(typeof ledger.createCallLedger,'function');const f=fixture(),call=ledger.createCallLedger(f.io);
  assert.equal((await call('same',{modelId:'unit'})).text,'saved');assert.equal((await call('same',{modelId:'unit'})).text,'saved');assert.equal(f.calls(),1);
  await assert.rejects(()=>call('different',{modelId:'unit'}),/limit/i);assert.equal(f.calls(),1);
});

test('overlapping optimization calls cannot exceed the ledger budget',async()=>{
  const f=fixture(),invoke=ledger.createCallLedger(f.io);
  const results=await Promise.allSettled([invoke('one',{}),invoke('two',{})]);
  assert.equal(f.calls(),1);assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.match(results.find(result=>result.status==='rejected').reason.message,/limit/i);
});

test('overlapping identical optimization calls reuse the first durable receipt',async()=>{
  const f=fixture(),invoke=ledger.createCallLedger(f.io);
  const results=await Promise.all([invoke('same',{}),invoke('same',{})]);
  assert.equal(f.calls(),1);assert.equal(results[0].responseSource,'FRESH_MODEL_RESPONSE');assert.equal(results[1].responseSource,'SAVED_RESPONSE');
});
test('Prompt optimization uncertain intents require explicit resume and still consume limit',async()=>{
  assert.equal(typeof ledger.createCallLedger,'function');const f=fixture();f.io.writeTrace=async()=>{throw new Error('storage failed');};
  await assert.rejects(()=>ledger.createCallLedger(f.io)('same',{}),/storage/);
  await assert.rejects(()=>ledger.createCallLedger(f.io)('same',{}),/uncertain/i);
  await assert.rejects(()=>ledger.createCallLedger({...f.io,cycle:1})('same',{}),/limit/i);assert.equal(f.calls(),1);
});
test('cancelled optimization jobs cannot send further model requests',async()=>{
  assert.equal(typeof ledger.createCallLedger,'function');const f=fixture();f.cancel();await assert.rejects(()=>ledger.createCallLedger(f.io)('same',{}),/cancelled/);assert.equal(f.calls(),0);
});
test('invalid response contracts retain evidence and allow a fresh bounded attempt on explicit resume',async()=>{
  const f=fixture();f.io.maxCalls=2;
  const validate=result=>{if(result.text==='saved')throw Object.assign(new Error('Invalid JSON contract'),{code:'INVALID_OUTPUT_SCHEMA'});};
  await assert.rejects(()=>ledger.createCallLedger(f.io)('same',{},validate),/Invalid JSON/);
  assert.equal(f.calls(),1);assert.ok([...f.docs.values()].some(d=>d.kind==='GEPA_CALL_RESULT'&&d.success===false));
  await assert.rejects(()=>ledger.createCallLedger(f.io)('same',{},validate),/uncertain/);
  const resumed=ledger.createCallLedger({...f.io,cycle:1,call:async()=>({text:'valid'})});
  assert.equal((await resumed('same',{},validate)).text,'valid');
  assert.equal((await resumed('same',{},validate)).text,'valid');
});
test('uncertain attempts remain visible after a later successful retry of the same request',()=>{
  assert.equal(typeof ledger.callLedgerStatus,'function');
  const stats=ledger.callLedgerStatus([{id:'first',key:'same'},{id:'second',key:'same'}],[{startId:'second',key:'same',success:true}]);
  assert.equal(stats.uncertainCalls,1);assert.equal(stats.callAttempts,2);
});

test('a leased current-cycle request is running while earlier missing outcomes stay uncertain',()=>{
  const starts=[{id:'old',cycle:0},{id:'current',cycle:1}];
  const stats=ledger.callLedgerStatus(starts,[],{activeCycle:1,leaseUntil:2000,now:1000});
  assert.equal(stats.activeCalls,1);assert.equal(stats.uncertainCalls,1);
  const expired=ledger.callLedgerStatus(starts,[],{activeCycle:1,leaseUntil:500,now:1000});
  assert.equal(expired.activeCalls,0);assert.equal(expired.uncertainCalls,2);
});
