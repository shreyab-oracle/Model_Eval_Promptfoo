import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createResponseJournal,receiptDigest} from '../src/services/response-journal.mjs';
import {digest} from '../src/domain/policy.mjs';

const task={id:'task-1',runId:'run-1',attemptId:'attempt-1',stage:'GENERATE'};
function traceFor(value=task){const requestBody={messages:[{role:'USER',text:'Frozen invoice facts'}],maxTokens:6000};return{taskId:value.id,attemptId:value.attemptId,stage:value.stage,requestBody,requestDigest:digest(requestBody),endpoint:'https://example.oraclecloud.com',modelId:'model-1',raw:{chatResponse:{choices:[{finishReason:'stop',message:{content:[{type:'TEXT',text:'{"malformed":'}]}}]}},requestId:'request-1'};}
async function fixture(work){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'response-journal-test-'));try{return await work(createResponseJournal({directory}),directory);}finally{const resolved=await fs.realpath(directory);assert.equal(path.dirname(resolved),await fs.realpath(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('response-journal-test-'));await fs.rm(resolved,{recursive:true,force:true});}}

test('received raw response and frozen request survive a durable journal roundtrip',async()=>fixture(async(journal,directory)=>{
  const trace=traceFor(),saved=await journal.persistResponse(task,trace),read=await journal.read(task.attemptId);
  assert.deepEqual(read.trace,trace);assert.deepEqual(read.binding,{taskId:task.id,runId:task.runId,attemptId:task.attemptId,stage:task.stage});
  assert.equal(saved.digest,read.digest);assert.equal(saved.digest,receiptDigest(read.binding,trace));assert.equal(saved.path,path.join(await fs.realpath(directory),'attempt-1.json'));assert.deepEqual(await journal.list(task.runId),[read]);assert.deepEqual(await journal.list('other-run'),[]);
  assert.deepEqual((await fs.readdir(directory)),['attempt-1.json']);
}));

test('journal syncs and closes the exclusive temporary file before the atomic rename',async()=>fixture(async(journal)=>{
  const open=fs.open,rename=fs.rename,events=[];
  fs.open=async function(file,flags,...args){const handle=await open(file,flags,...args);if(String(file).endsWith('.tmp')){events.push(['open',flags]);const sync=handle.sync.bind(handle),close=handle.close.bind(handle);handle.sync=async()=>{events.push(['sync']);await sync();};handle.close=async()=>{events.push(['close']);await close();};}return handle;};
  fs.rename=async function(...args){events.push(['rename']);return rename(...args);};
  try{await journal.persistResponse(task,traceFor());}finally{fs.open=open;fs.rename=rename;}
  assert.deepEqual(events,[['open','wx'],['sync'],['close'],['rename']]);
}));

test('same attempt and content are idempotent, while conflicting content cannot overwrite',async()=>fixture(async(journal)=>{
  const first=await journal.persistResponse(task,traceFor());assert.deepEqual(await journal.persistResponse(task,traceFor()),first);
  const changed=traceFor();changed.raw={answer:'different answer'};
  await assert.rejects(()=>journal.persistResponse(task,changed),{code:'JOURNAL_CONFLICT'});assert.deepEqual((await journal.read(task.attemptId)).trace,traceFor());
}));

test('concurrent writers retain one immutable answer and reject different content',async()=>fixture(async(journal)=>{
  const first=traceFor(),other=traceFor();other.raw={answer:'another answer'};
  const results=await Promise.allSettled([journal.persistResponse(task,first),journal.persistResponse(task,other)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.code,'JOURNAL_CONFLICT');
  assert.equal((await journal.list()).length,1);
}));

test('concurrent identical writes are idempotent',async()=>fixture(async(journal)=>{
  const results=await Promise.all([journal.persistResponse(task,traceFor()),journal.persistResponse(task,traceFor())]);assert.deepEqual(results[0],results[1]);
}));

for(const [name,change,code] of [
  ['attempt traversal',t=>{t.attemptId='../escape';},'JOURNAL_INVALID_ID'],
  ['task traversal',t=>{t.id='folder/task';},'JOURNAL_INVALID_ID'],
  ['run traversal',t=>{t.runId='..';},'JOURNAL_INVALID_ID'],
  ['mismatched task',(_t,r)=>{r.taskId='other-task';},'JOURNAL_BINDING_MISMATCH'],
  ['mismatched attempt',(_t,r)=>{r.attemptId='other-attempt';},'JOURNAL_BINDING_MISMATCH'],
  ['mismatched run',(_t,r)=>{r.runId='other-run';},'JOURNAL_BINDING_MISMATCH'],
  ['mismatched frozen request',(_t,r)=>{r.requestBody.maxTokens=1;},'JOURNAL_REQUEST_MISMATCH'],
  ['missing raw response',(_t,r)=>{delete r.raw;},'JOURNAL_RESPONSE_MISSING']
])test(`journal rejects ${name} before writing`,async()=>fixture(async(journal,directory)=>{
  const input={...task},trace=traceFor();change(input,trace);
  await assert.rejects(()=>journal.persistResponse(input,trace),{code});assert.deepEqual(await fs.readdir(directory),[]);
}));

test('journal reads and listing reject tampered payloads',async()=>fixture(async(journal)=>{
  const saved=await journal.persistResponse(task,traceFor()),payload=JSON.parse(await fs.readFile(saved.path,'utf8'));payload.trace.raw={changed:true};await fs.writeFile(saved.path,JSON.stringify(payload));
  await assert.rejects(()=>journal.read(task.attemptId),{code:'JOURNAL_CORRUPT'});await assert.rejects(()=>journal.list(),{code:'JOURNAL_CORRUPT'});
  await assert.rejects(()=>journal.clear(task.attemptId,{remoteCommitted:true,expectedDigest:saved.digest}),{code:'JOURNAL_CORRUPT'});assert.ok(await fs.stat(saved.path));
}));

test('journal filename cannot be rebound to another attempt',async()=>fixture(async(journal,directory)=>{
  const saved=await journal.persistResponse(task,traceFor());await fs.rename(saved.path,path.join(directory,'other-attempt.json'));
  await assert.rejects(()=>journal.read('other-attempt'),{code:'JOURNAL_CORRUPT'});
}));

test('journal clears only after explicit remote commit with matching expected digest',async()=>fixture(async(journal)=>{
  const saved=await journal.persistResponse(task,traceFor());
  await assert.rejects(()=>journal.clear(task.attemptId),{code:'JOURNAL_COMMIT_REQUIRED'});
  await assert.rejects(()=>journal.clear(task.attemptId,{remoteCommitted:true,expectedDigest:'0'.repeat(64)}),{code:'JOURNAL_CONFLICT'});
  assert.equal(await journal.remove(await journal.read(task.attemptId),{remoteCommitted:true,expectedDigest:saved.digest}),true);
  assert.equal(await journal.read(task.attemptId),null);assert.deepEqual(await journal.list(),[]);
  assert.equal(await journal.clear(task.attemptId,{remoteCommitted:true,expectedDigest:saved.digest}),false);
}));

test('failed file sync never publishes a journal or discards its recovery evidence',async()=>fixture(async(journal,directory)=>{
  const open=fs.open;let recoveryPath;
  fs.open=async function(file,...args){const handle=await open(file,...args);if(String(file).endsWith('.tmp'))handle.sync=async()=>{throw Object.assign(new Error('simulated disk sync failure'),{code:'EIO'});};return handle;};
  try{await assert.rejects(()=>journal.persistResponse(task,traceFor()),error=>{recoveryPath=error.journalTempPath;return error.code==='EIO';});}finally{fs.open=open;}
  assert.equal(await journal.read(task.attemptId),null);await assert.rejects(()=>journal.list(),{code:'JOURNAL_INTERRUPTED'});await assert.rejects(()=>journal.list('other-run'),{code:'JOURNAL_INTERRUPTED'});assert.equal(path.dirname(recoveryPath),await fs.realpath(directory));assert.deepEqual(JSON.parse(await fs.readFile(recoveryPath,'utf8')).trace,traceFor());assert.equal((await fs.readdir(directory)).some(name=>name.endsWith('.lock')),false);
}));

test('journal refuses a directory outside workspace and temporary roots',()=>{
  const root=path.parse(process.cwd()).root;assert.throws(()=>createResponseJournal({directory:path.join(root,'outside-response-journal-test')}),{code:'JOURNAL_PATH_OUTSIDE_ROOT'});
});

test('read-only journal methods do not create a missing directory',async()=>fixture(async(_journal,directory)=>{
  const missing=path.join(directory,'missing'),journal=createResponseJournal({directory:missing});assert.equal(await journal.read(task.attemptId),null);assert.deepEqual(await journal.list(),[]);await assert.rejects(()=>fs.stat(missing),{code:'ENOENT'});
}));

test('journal rejects a parent junction resolving outside its allowed root',async()=>fixture(async(_journal,directory)=>{
  const link=path.join(directory,'outside');await fs.symlink(process.cwd(),link,process.platform==='win32'?'junction':'dir');
  const journal=createResponseJournal({directory:path.join(link,'response-journal-outside-test')});
  await assert.rejects(()=>journal.persistResponse(task,traceFor()),{code:'JOURNAL_PATH_OUTSIDE_ROOT'});
}));

test('journal listing fails closed on an orphaned lock before any received evidence is ignored',async()=>fixture(async(journal,directory)=>{
  await journal.persistResponse(task,traceFor());await fs.writeFile(path.join(directory,'.attempt-2.lock'),'');
  await assert.rejects(()=>journal.list(task.runId),{code:'JOURNAL_INTERRUPTED'});
  assert.deepEqual((await journal.read(task.attemptId)).trace,traceFor(),'verified published evidence remains inspectable');
}));
