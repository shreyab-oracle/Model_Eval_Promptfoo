import test from 'node:test';
import assert from 'node:assert/strict';
import {repository} from '../src/db/repository.mjs';
import {getDriver,closePool} from '../src/db/pool.mjs';
import {canonical,digest} from '../src/domain/policy.mjs';

// The driver is replaced before any connection can be acquired.
Object.assign(process.env,{DB_USER:'unit-user',DB_PASSWORD:'unit-password',DB_CONNECT_STRING:'unit-only',DB_WALLET_DIR:'.',DB_WALLET_PASSWORD:'unit-wallet'});
const handlingVersion='received-answer-v1',recoveryKind='LOCAL_JOURNAL',journalDigest=digest({localReceipt:true}),trace={key:'traces/original.json',digest:digest({original:true})};
function fixture({runStatus='RUNNING',stage='GENERATE',sourceStatus='FAILED',sourceTrace=true}={}){
  const error={code:'STORAGE_WRITE_FAILED',message:'The received response could not be persisted'};
  let state={run:{ID:'run-1',STATUS:runStatus},task:{ID:'task-1',RUN_ID:'run-1',STAGE:stage,CASE_ID:'case-1',MODEL_ROLE:'baseline',REPETITION:2,ASSESSMENT:stage==='JUDGE'?1:null,DEPENDS_ON:stage==='JUDGE'?'output-1':null,STATUS:'FAILED',ATTEMPTS:1,RETRY_CYCLE:0,ERROR:JSON.stringify(error),OWNER:null,LEASE_UNTIL:null},attempts:[{ID:'source-1',TASK_ID:'task-1',OWNER:'original-worker',STATUS:sourceStatus,RETRY_CYCLE:0,ATTEMPT_NUMBER:1,RESULT:JSON.stringify({error,preservedDetail:'original metadata',...(sourceTrace?{trace}:{})}),STARTED_AT:new Date('2026-11-02T10:00:00Z'),FINISHED_AT:new Date('2026-11-02T10:00:01Z')}],docs:[]};
  let committed=structuredClone(state),commits=0,rollbacks=0;
  const calls=[],flags={};
  const value={caseId:'case-1',role:'baseline',repeat:2,trace,...(stage==='JUDGE'?{outputId:'output-1',assessment:1,assessmentResult:{critical:true,rationale:'The original serious finding is retained'}}:{response:{action:'RETAIN_HOLD'},checks:[{code:'ACTION',status:'FAIL',severity:'major',confirmed:true}]})};
  const input={taskId:'task-1',sourceAttemptId:'source-1',handlingVersion,journalDigest,document:{id:'task-1',kind:stage==='JUDGE'?'JUDGE':'OUTPUT',parentId:'run-1',value}};
  const connection={
    async execute(sql,binds){
      calls.push({sql,binds:structuredClone(binds)});
      if(sql.startsWith('SELECT t.*,r.status'))return{rows:state.task?[{...structuredClone(state.task),RUN_STATUS:state.run.STATUS}]:[]};
      if(sql.startsWith('SELECT * FROM AIEP_ATTEMPTS'))return{rows:structuredClone(state.attempts.filter(a=>a.TASK_ID===binds.id))};
      if(sql.startsWith('SELECT * FROM AIEP_DOCUMENTS'))return{rows:structuredClone(state.docs.filter(d=>d.ID===binds.id))};
      if(sql.startsWith('SELECT digest FROM AIEP_DOCUMENTS'))return{rows:state.docs.filter(d=>d.ID===binds.id).map(d=>({DIGEST:d.DIGEST}))};
      if(sql.startsWith('UPDATE AIEP_ATTEMPTS')){
        if(flags.sourceConflict)return{rowsAffected:0};
        const source=state.attempts.find(a=>a.ID===binds.id&&a.TASK_ID===binds.task&&a.STATUS===binds.status);
        if(source)source.RESULT=binds.result;return{rowsAffected:source?1:0};
      }
      if(sql.startsWith('INSERT INTO AIEP_ATTEMPTS')){state.attempts.push({ID:binds.id,TASK_ID:binds.task,OWNER:'receipt-reconciler',RETRY_CYCLE:binds.cycle,ATTEMPT_NUMBER:binds.attempt,STATUS:'DONE',RESULT:binds.result});return{rowsAffected:1};}
      if(sql.startsWith('INSERT INTO AIEP_DOCUMENTS')){
        if(flags.documentFailure)throw new Error('simulated document insert failure');
        state.docs.push({ID:binds.id,KIND:binds.kind,PARENT_ID:binds.parentId,VERSION_NAME:binds.version,DIGEST:binds.hash,PAYLOAD:binds.payload,CREATED_AT:new Date('2026-11-02T10:01:00Z')});return{rowsAffected:1};
      }
      if(sql.startsWith('UPDATE AIEP_TASKS')){
        if(flags.taskConflict)return{rowsAffected:0};
        state.task={...state.task,STATUS:'DONE',ERROR:null,ATTEMPTS:state.task.ATTEMPTS+1,OWNER:null,LEASE_UNTIL:null};return{rowsAffected:1};
      }
      if(sql.startsWith('UPDATE AIEP_RUNS')){state.run.STATUS='RUNNING';return{rowsAffected:1};}
      throw new Error(`Unexpected unit SQL: ${sql}`);
    },
    async commit(){commits++;committed=structuredClone(state);},
    async rollback(){rollbacks++;state=structuredClone(committed);},
    async close(){}
  };
  return{input,flags,calls,connection,get state(){return state;},get commits(){return commits;},get rollbacks(){return rollbacks;},edit(fn){fn(state);committed=structuredClone(state);}};
}
async function withDatabase(f,work){
  const driver=getDriver(),original=driver.createPool;
  driver.createPool=async()=>({getConnection:async()=>f.connection,close:async()=>{}});
  try{return await work();}finally{await closePool();driver.createPool=original;}
}

for(const stage of ['GENERATE','JUDGE'])for(const sourceStatus of ['FAILED','UNCERTAIN'])test(`${stage} receipt recovery retains the ${sourceStatus} source and records a no-call processing attempt`,async()=>{
  const f=fixture({stage,sourceStatus}),original=structuredClone(f.state.attempts[0]);
  await withDatabase(f,async()=>assert.equal(await repository.recoverReceivedAnswer(f.input),'task-1'));
  assert.equal(f.commits,1);assert.equal(f.rollbacks,0);assert.equal(f.state.task.STATUS,'DONE');assert.equal(f.state.task.ATTEMPTS,2);assert.equal(f.state.task.ERROR,null);
  assert.deepEqual({...f.state.attempts[0],RESULT:original.RESULT},original,'source status, owner and timestamps remain unchanged');
  assert.deepEqual(JSON.parse(f.state.attempts[0].RESULT),{...JSON.parse(original.RESULT),trace,receiptRecovered:true,journalDigest});
  const processing=f.state.attempts[1],value=JSON.parse(f.state.docs[0].PAYLOAD);
  assert.equal(processing.STATUS,'DONE');assert.equal(processing.OWNER,'receipt-reconciler');assert.equal(processing.ATTEMPT_NUMBER,2);
  assert.deepEqual(JSON.parse(processing.RESULT),{modelCall:false,sourceAttemptId:'source-1',sourceTrace:trace,handlingVersion,recoveryKind,journalDigest});
  assert.deepEqual(value,{...f.input.document.value,processingAttemptId:processing.ID,sourceAttemptId:'source-1',handlingVersion,recoveryKind,journalDigest});
  assert.ok(f.calls[0].sql.includes('FOR UPDATE OF t.status,r.status'));assert.ok(f.calls[1].sql.includes('FOR UPDATE'));
  assert.equal(f.calls.some(c=>c.sql.includes("status='PENDING'")),false,'recovery never queues another model request');
});

test('a local receipt supplies missing remote trace metadata without losing the original failure',async()=>{
  const f=fixture({sourceStatus:'UNCERTAIN',sourceTrace:false}),originalError=JSON.parse(f.state.attempts[0].RESULT).error;
  await withDatabase(f,()=>repository.recoverReceivedAnswer(f.input));
  const result=JSON.parse(f.state.attempts[0].RESULT);assert.deepEqual(result.error,originalError);assert.deepEqual(result.trace,trace);assert.equal(result.journalDigest,journalDigest);assert.equal(result.receiptRecovered,true);
});

test('recovery does not resume an incomplete parent without an explicit request',async()=>{
  const f=fixture({runStatus:'INCOMPLETE'});await withDatabase(f,()=>repository.recoverReceivedAnswer(f.input));
  assert.equal(f.state.run.STATUS,'INCOMPLETE');assert.equal(f.calls.some(c=>c.sql.startsWith('UPDATE AIEP_RUNS')),false);
});

test('an explicitly requested parent resume happens atomically with recovery',async()=>{
  const f=fixture({runStatus:'INCOMPLETE'});f.input.resumeRun=true;await withDatabase(f,()=>repository.recoverReceivedAnswer(f.input));
  assert.equal(f.state.run.STATUS,'RUNNING');assert.equal(f.commits,1);
});

for(const resumeRun of [false,true])test(`recovery records an already received answer while preserving cancellation with resumeRun=${resumeRun}`,async()=>{
  const f=fixture({runStatus:'CANCELLED',sourceStatus:'UNCERTAIN'});f.input.resumeRun=resumeRun;
  await withDatabase(f,()=>repository.recoverReceivedAnswer(f.input));
  assert.equal(f.state.task.STATUS,'DONE');assert.equal(f.state.run.STATUS,'CANCELLED');assert.equal(f.calls.some(c=>c.sql.startsWith('UPDATE AIEP_RUNS')),false);
  assert.equal(JSON.parse(f.state.attempts[1].RESULT).modelCall,false);
});

for(const runStatus of ['RUNNING','COMPLETED'])test(`a committed receipt is idempotent when its parent is ${runStatus}`,async()=>{
  const f=fixture();await withDatabase(f,async()=>{
    await repository.recoverReceivedAnswer(f.input);f.edit(s=>{s.run.STATUS=runStatus;});
    const writes=f.calls.filter(c=>/^(INSERT|UPDATE)/.test(c.sql)).length;
    assert.equal(await repository.recoverReceivedAnswer(f.input),'task-1');assert.equal(f.calls.filter(c=>/^(INSERT|UPDATE)/.test(c.sql)).length,writes);
  });
  assert.equal(f.commits,1);assert.equal(f.rollbacks,1);assert.equal(f.state.attempts.length,2);assert.equal(f.state.docs.length,1);
});

const refusals=[
  ['a pending evaluation',f=>f.edit(s=>{s.task.STATUS='PENDING';})],
  ['a live evaluation',f=>f.edit(s=>{s.task.STATUS='RUNNING';})],
  ['a proposal task',f=>f.edit(s=>{s.task.STAGE='PROPOSE';})],
  ['a completed parent without a recovered task',f=>f.edit(s=>{s.run.STATUS='COMPLETED';})],
  ['a missing source',f=>{f.input.sourceAttemptId='missing';}],
  ['a completed source',f=>f.edit(s=>{s.attempts[0].STATUS='DONE';})],
  ['a live source',f=>f.edit(s=>{s.attempts[0].STATUS='RUNNING';})],
  ['a previous retry cycle',f=>f.edit(s=>{s.attempts[0].RETRY_CYCLE=-1;})],
  ['a different latest attempt',f=>f.edit(s=>{s.task.ATTEMPTS=2;})],
  ['a mismatched trace key',f=>{f.input.document.value.trace={...trace,key:'traces/other.json'};}],
  ['a mismatched trace digest',f=>{f.input.document.value.trace={...trace,digest:digest('wrong')};}],
  ['a mismatched case identity',f=>{f.input.document.value.caseId='other-case';}],
  ['a mismatched run identity',f=>{f.input.document.parentId='other-run';}],
  ['a wrong document kind',f=>{f.input.document.kind='JUDGE';}],
  ['an unsupported handling version',f=>{f.input.handlingVersion='other-version';}],
  ['a missing journal proof',f=>{delete f.input.journalDigest;}],
  ['an invalid journal proof',f=>{f.input.journalDigest='unverified';}],
  ['a different previously recovered receipt',f=>f.edit(s=>{const result=JSON.parse(s.attempts[0].RESULT);s.attempts[0].RESULT=JSON.stringify({...result,journalDigest:digest('different')});})],
  ['a missing remote trace reference',f=>{delete f.input.document.value.trace;}],
  ['another live attempt',f=>f.edit(s=>{s.attempts.push({...s.attempts[0],ID:'other-live',STATUS:'RUNNING'});})],
  ['another completed attempt',f=>f.edit(s=>{s.attempts.push({...s.attempts[0],ID:'other-done',STATUS:'DONE'});})],
  ['a later failed attempt',f=>f.edit(s=>{s.attempts.push({...s.attempts[0],ID:'other-later',ATTEMPT_NUMBER:2});})],
  ['an existing result',f=>f.edit(s=>{const value={unrelated:true};s.docs.push({ID:'task-1',KIND:'OUTPUT',PARENT_ID:'run-1',PAYLOAD:canonical(value),DIGEST:digest(value),CREATED_AT:new Date()});})]
];
for(const [name,change] of refusals)test(`receipt recovery rejects ${name} without writes`,async()=>{
  const f=fixture();change(f);await withDatabase(f,()=>assert.rejects(()=>repository.recoverReceivedAnswer(f.input),{code:'RECEIVED_ANSWER_RECOVERY_REJECTED'}));
  assert.equal(f.commits,0);assert.equal(f.rollbacks,1);assert.equal(f.calls.some(c=>/^(INSERT|UPDATE)/.test(c.sql)),false);
});

for(const field of ['assessment','outputId'])test(`judge receipt recovery validates its ${field}`,async()=>{
  const f=fixture({stage:'JUDGE'});f.input.document.value[field]=field==='assessment'?0:'wrong-output';
  await withDatabase(f,()=>assert.rejects(()=>repository.recoverReceivedAnswer(f.input),{code:'RECEIVED_ANSWER_RECOVERY_REJECTED'}));assert.equal(f.commits,0);
});

for(const flag of ['sourceConflict','documentFailure','taskConflict'])test(`receipt recovery rolls back source metadata and the whole observation after ${flag}`,async()=>{
  const f=fixture({sourceTrace:false}),before=structuredClone(f.state);f.flags[flag]=true;
  await withDatabase(f,()=>assert.rejects(()=>repository.recoverReceivedAnswer(f.input)));assert.equal(f.commits,0);assert.equal(f.rollbacks,1);assert.deepEqual(f.state,before);
});

for(const change of ['modelCall','journalDigest','liveAttempt'])test(`idempotency rejects changed ${change} provenance`,async()=>{
  const f=fixture();await withDatabase(f,async()=>{
    await repository.recoverReceivedAnswer(f.input);f.edit(s=>{
      if(change==='liveAttempt')s.attempts.push({...s.attempts[0],ID:'unexpected-live',STATUS:'RUNNING',ATTEMPT_NUMBER:3});
      else{const result=JSON.parse(s.attempts[1].RESULT);s.attempts[1].RESULT=JSON.stringify({...result,[change]:change==='modelCall'?true:digest('different')});}
    });
    await assert.rejects(()=>repository.recoverReceivedAnswer(f.input),{code:'RECEIVED_ANSWER_RECOVERY_REJECTED'});
  });assert.equal(f.commits,1);assert.equal(f.state.docs.length,1);
});
