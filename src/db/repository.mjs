import {randomUUID} from 'node:crypto';
import {withConnection,getDriver} from './pool.mjs';
import {canonical,digest} from '../domain/policy.mjs';
import {safeError} from '../config.mjs';
import {canAutoReclaim} from '../services/task-policy.mjs';
export function verifiedPayload(payload,expectedDigest){const value=JSON.parse(payload);if(digest(value)!==expectedDigest)throw Object.assign(new Error('Immutable database document digest mismatch'),{code:'DOCUMENT_DIGEST_MISMATCH'});return value;}
const readDoc=r=>r?{...verifiedPayload(r.PAYLOAD,r.DIGEST),id:r.ID,kind:r.KIND,parentId:r.PARENT_ID,version:r.VERSION_NAME,digest:r.DIGEST,createdAt:new Date(r.CREATED_AT).toISOString()}:null;
const readRun=r=>r?{id:r.ID,manifestId:r.MANIFEST_ID,status:r.STATUS,kind:r.RUN_KIND,live:r.LIVE===1,reportId:r.REPORT_ID,error:r.ERROR?JSON.parse(r.ERROR):null,createdAt:new Date(r.CREATED_AT).toISOString(),updatedAt:new Date(r.UPDATED_AT).toISOString()}:null;
const readTask=r=>r?{id:r.ID,runId:r.RUN_ID,stage:r.STAGE,caseId:r.CASE_ID,role:r.MODEL_ROLE,repeat:r.REPETITION,assessment:r.ASSESSMENT,dependsOn:r.DEPENDS_ON,payload:JSON.parse(r.PAYLOAD),status:r.STATUS,owner:r.OWNER,leaseUntil:r.LEASE_UNTIL?new Date(r.LEASE_UNTIL).getTime():null,attempts:r.ATTEMPTS,cycle:r.RETRY_CYCLE,error:r.ERROR?JSON.parse(r.ERROR):null}:null;
// Canonical report artifacts need strings: Oracle Date objects have no enumerable fields.
export const readAttempt=r=>({id:r.ID,taskId:r.TASK_ID,status:r.STATUS,cycle:r.RETRY_CYCLE,attempt:r.ATTEMPT_NUMBER,...(r.RESULT?JSON.parse(r.RESULT):{}),startedAt:r.STARTED_AT==null?null:new Date(r.STARTED_AT).toISOString(),finishedAt:r.FINISHED_AT==null?null:new Date(r.FINISHED_AT).toISOString()});
async function insertDoc(c,{id=randomUUID(),kind,parentId=null,version=null,value}){
  const hash=digest(value),old=(await c.execute('SELECT digest FROM AIEP_DOCUMENTS WHERE id=:id',{id})).rows[0];
  if(old){if(old.DIGEST!==hash)throw new Error(`Immutable document conflict: ${id}`);return id;}
  await c.execute('INSERT INTO AIEP_DOCUMENTS(id,kind,parent_id,version_name,digest,payload) VALUES(:id,:kind,:parentId,:version,:hash,:payload)',{id,kind,parentId,version,hash,payload:canonical(value)});return id;
}
const sameTrace=(a,b)=>typeof a?.key==='string'&&a.key.length>0&&typeof a.digest==='string'&&a.digest.length>0&&a.key===b?.key&&a.digest===b?.digest;
function runScope(runIds){
  if(runIds===undefined)return{empty:false,binds:{},where:()=> '1=1'};
  if(!Array.isArray(runIds)||runIds.some(id=>typeof id!=='string'||!id||id.length>64))throw new Error('A valid worker run scope is required');
  // JSON_TABLE cannot appear beneath SELECT FOR UPDATE in Oracle. Bind the
  // compatible run IDs directly, splitting lists below Oracle's 1,000 limit.
  const ids=[...new Set(runIds)],binds=Object.fromEntries(ids.map((id,i)=>[`eligibleRun${i}`,id])),groups=[];
  for(let i=0;i<ids.length;i+=900)groups.push(ids.slice(i,i+900).map((_,j)=>`:eligibleRun${i+j}`).join(','));
  return{empty:ids.length===0,binds,where:column=>`(${groups.map(group=>`${column} IN (${group})`).join(' OR ')})`};
}
async function recoverReceivedAnswer(c,{taskId,sourceAttemptId,document,handlingVersion,journalDigest,resumeRun=false}){
  const reject=message=>{throw Object.assign(new Error(message),{code:'RECEIVED_ANSWER_RECOVERY_REJECTED'});};
  const recoveryKind='LOCAL_JOURNAL';
  if(typeof taskId!=='string'||!taskId||typeof sourceAttemptId!=='string'||!sourceAttemptId||handlingVersion!=='received-answer-v1'||typeof journalDigest!=='string'||!/^[a-f0-9]{64}$/.test(journalDigest)||typeof resumeRun!=='boolean')reject('Task, source attempt, supported answer-handling version and local receipt digest are required');
  const value=document?.value;
  if(document?.id!==taskId||!['OUTPUT','JUDGE'].includes(document.kind)||!value||!sameTrace(value.trace,value.trace)||!/^[a-f0-9]{64}$/.test(value.trace.digest))reject('Recovery requires the original received answer trace');
  const row=(await c.execute('SELECT t.*,r.status AS RUN_STATUS FROM AIEP_TASKS t JOIN AIEP_RUNS r ON r.id=t.run_id WHERE t.id=:id FOR UPDATE OF t.status,r.status',{id:taskId})).rows[0];
  if(!row||!['GENERATE','JUDGE'].includes(row.STAGE)||(row.STATUS!=='DONE'&&!['RUNNING','INCOMPLETE','CANCELLED'].includes(row.RUN_STATUS)))reject('Only evaluation tasks in a running, incomplete or cancelled run can be recovered');
  const kind=row.STAGE==='GENERATE'?'OUTPUT':'JUDGE';
  if(document.kind!==kind||document.parentId!==row.RUN_ID||value.caseId!==row.CASE_ID||value.role!==row.MODEL_ROLE||value.repeat!==row.REPETITION||(kind==='JUDGE'&&(value.assessment!==row.ASSESSMENT||value.outputId!==row.DEPENDS_ON)))reject('Document identity differs from the original evaluation task');
  const attempts=(await c.execute('SELECT * FROM AIEP_ATTEMPTS WHERE task_id=:id FOR UPDATE',{id:taskId})).rows;
  const source=attempts.find(a=>a.ID===sourceAttemptId);
  if(!source||source.TASK_ID!==taskId||!['FAILED','UNCERTAIN'].includes(source.STATUS)||source.RETRY_CYCLE!==row.RETRY_CYCLE)reject('Source must be the failed or uncertain attempt from the current task retry cycle');
  const sourceResult=source.RESULT?JSON.parse(source.RESULT):{};
  if(!sourceResult||typeof sourceResult!=='object'||Array.isArray(sourceResult)||(sourceResult.trace&&!sameTrace(sourceResult.trace,value.trace))||(sourceResult.journalDigest&&sourceResult.journalDigest!==journalDigest))reject('Receipt differs from the original source attempt evidence');
  const hasConflictingAttempt=processingId=>attempts.some(a=>a.ID!==sourceAttemptId&&a.ID!==processingId&&(['RUNNING','DONE'].includes(a.STATUS)||a.RETRY_CYCLE>source.RETRY_CYCLE||(a.RETRY_CYCLE===source.RETRY_CYCLE&&a.ATTEMPT_NUMBER>source.ATTEMPT_NUMBER)));
  const existing=readDoc((await c.execute('SELECT * FROM AIEP_DOCUMENTS WHERE id=:id',{id:taskId})).rows[0]);
  if(row.STATUS==='DONE'){
    const processing=existing&&attempts.find(a=>a.ID===existing.processingAttemptId),result=processing?.RESULT?JSON.parse(processing.RESULT):null;
    const expectedValue={...value,processingAttemptId:processing?.ID,sourceAttemptId,handlingVersion,recoveryKind,journalDigest};
    if(!existing||existing.kind!==kind||existing.parentId!==row.RUN_ID||source.ATTEMPT_NUMBER!==row.ATTEMPTS-1||!processing||processing.TASK_ID!==taskId||processing.STATUS!=='DONE'||processing.OWNER!=='receipt-reconciler'||processing.RETRY_CYCLE!==row.RETRY_CYCLE||processing.ATTEMPT_NUMBER!==row.ATTEMPTS||result?.modelCall!==false||result.sourceAttemptId!==sourceAttemptId||result.handlingVersion!==handlingVersion||result.recoveryKind!==recoveryKind||result.journalDigest!==journalDigest||!sameTrace(result.sourceTrace,value.trace)||sourceResult.receiptRecovered!==true||sourceResult.journalDigest!==journalDigest||!sameTrace(sourceResult.trace,value.trace)||digest(expectedValue)!==existing.digest)reject('Completed task is not the same recorded receipt recovery');
    if(hasConflictingAttempt(processing.ID))reject('Another live, completed or later attempt prevents recovery');
    await c.rollback();return existing.id;
  }
  if(row.STATUS!=='FAILED'||source.ATTEMPT_NUMBER!==row.ATTEMPTS||existing)reject('Only the current failed evaluation without an existing result can be recovered');
  if(hasConflictingAttempt())reject('Another live, completed or later attempt prevents recovery');
  const processingAttemptId=randomUUID(),attemptNumber=row.ATTEMPTS+1;
  const result={modelCall:false,sourceAttemptId,sourceTrace:value.trace,handlingVersion,recoveryKind,journalDigest};
  const recovered=await c.execute("UPDATE AIEP_ATTEMPTS SET result=:result WHERE id=:id AND task_id=:task AND status=:status",{id:sourceAttemptId,task:taskId,status:source.STATUS,result:JSON.stringify({...sourceResult,trace:value.trace,receiptRecovered:true,journalDigest})});
  if(recovered.rowsAffected!==1)reject('Source attempt changed before its receipt could be recovered');
  await c.execute("INSERT INTO AIEP_ATTEMPTS(id,task_id,owner,retry_cycle,attempt_number,status,result,finished_at) VALUES(:id,:task,'receipt-reconciler',:cycle,:attempt,'DONE',:result,SYSTIMESTAMP)",{id:processingAttemptId,task:taskId,cycle:row.RETRY_CYCLE,attempt:attemptNumber,result:JSON.stringify(result)});
  await insertDoc(c,{...document,value:{...value,processingAttemptId,sourceAttemptId,handlingVersion,recoveryKind,journalDigest}});
  const changed=await c.execute("UPDATE AIEP_TASKS SET status='DONE',error=NULL,attempts=attempts+1,owner=NULL,lease_until=NULL WHERE id=:id AND stage=:stage AND status='FAILED' AND retry_cycle=:cycle AND attempts=:attempt",{id:taskId,stage:row.STAGE,cycle:row.RETRY_CYCLE,attempt:row.ATTEMPTS});
  if(changed.rowsAffected!==1)reject('Source evaluation changed before recovery could commit');
  if(resumeRun&&row.RUN_STATUS==='INCOMPLETE'){
    const resumed=await c.execute("UPDATE AIEP_RUNS SET status='RUNNING',updated_at=SYSTIMESTAMP WHERE id=:id AND status='INCOMPLETE'",{id:row.RUN_ID});
    if(resumed.rowsAffected!==1)reject('Parent run changed before recovery could commit');
  }
  await c.commit();return taskId;
}
export const repository={
  async recoverReceivedAnswer(input){return withConnection(c=>recoverReceivedAnswer(c,input));},
  async saveDoc(doc){return withConnection(async c=>{const id=await insertDoc(c,doc);await c.commit();return id;});},
  async doc(id){return withConnection(async c=>readDoc((await c.execute('SELECT * FROM AIEP_DOCUMENTS WHERE id=:id',{id})).rows[0]),{readOnly:true});},
  async docs(kind,parentId){return withConnection(async c=>(await c.execute('SELECT * FROM AIEP_DOCUMENTS WHERE kind=:kind AND (:parent IS NULL OR parent_id=:parent) ORDER BY created_at DESC',{kind,parent:parentId||null})).rows.map(readDoc),{readOnly:true});},
  async run(id){return withConnection(async c=>readRun((await c.execute('SELECT * FROM AIEP_RUNS WHERE id=:id',{id})).rows[0]),{readOnly:true});},
  async runs({worker=false}={}){return withConnection(async c=>(await c.execute(worker?
    "SELECT r.* FROM AIEP_RUNS r WHERE r.run_kind<>'diagnostic' AND (r.status='RUNNING' OR EXISTS (SELECT 1 FROM AIEP_TASKS t WHERE t.run_id=r.id AND t.status='RUNNING') OR (r.status='COMPLETED' AND r.report_id IS NULL AND r.run_kind<>'improvement')) ORDER BY r.created_at":
    "SELECT * FROM AIEP_RUNS WHERE run_kind<>'diagnostic' ORDER BY created_at DESC FETCH FIRST 100 ROWS ONLY")).rows.map(readRun),{readOnly:true});},
  async createRun({id,manifestId,kind,tasks,live=true}){return withConnection(async c=>{
    await c.execute("INSERT INTO AIEP_RUNS(id,manifest_id,status,run_kind,live) VALUES(:id,:manifestId,'DRAFT',:kind,:live)",{id,manifestId,kind,live:live?1:0});
    const d=getDriver();
    if(tasks.length)await c.executeMany('INSERT INTO AIEP_TASKS(id,run_id,stage,case_id,model_role,repetition,assessment,depends_on,payload) VALUES(:id,:run,:stage,:caseId,:role,:repeat,:assessment,:depends,:payload)',tasks.map(t=>({id:t.id,run:id,stage:t.stage,caseId:t.caseId||null,role:t.role||null,repeat:t.repeat??null,assessment:t.assessment??null,depends:t.dependsOn||null,payload:canonical(t.payload||{})})),{bindDefs:{id:{type:d.STRING,maxSize:64},run:{type:d.STRING,maxSize:64},stage:{type:d.STRING,maxSize:20},caseId:{type:d.STRING,maxSize:120},role:{type:d.STRING,maxSize:20},repeat:{type:d.NUMBER},assessment:{type:d.NUMBER},depends:{type:d.STRING,maxSize:64},payload:{type:d.STRING,maxSize:4000}}});
    await c.commit();return id;
  });},
  async startRun(id){return withConnection(async c=>{const r=await c.execute("UPDATE AIEP_RUNS SET status='RUNNING',updated_at=SYSTIMESTAMP WHERE id=:id AND status='DRAFT'",{id});if(r.rowsAffected!==1)throw new Error('Only a frozen draft run can be started');await c.commit();});},
  async cancel(id){return withConnection(async c=>{
    await c.execute("UPDATE AIEP_RUNS SET status='CANCELLED',updated_at=SYSTIMESTAMP WHERE id=:id AND status IN ('DRAFT','RUNNING','INCOMPLETE')",{id});
    await c.execute("UPDATE AIEP_RUNS SET status='CANCELLED',updated_at=SYSTIMESTAMP WHERE status IN ('DRAFT','RUNNING','INCOMPLETE') AND id IN (SELECT JSON_VALUE(l.payload,'$.runId' RETURNING VARCHAR2(64)) FROM AIEP_DOCUMENTS l JOIN AIEP_DOCUMENTS p ON l.parent_id=p.id WHERE l.kind='RETEST_LINK' AND p.parent_id=:id)",{id});await c.commit();
  });},
  async resume(id){return withConnection(async c=>{
    const r=await c.execute("UPDATE AIEP_RUNS SET status='RUNNING',error=NULL,report_id=NULL,updated_at=SYSTIMESTAMP WHERE id=:id AND status IN ('INCOMPLETE','CANCELLED')",{id});if(r.rowsAffected!==1)throw new Error('Only an incomplete or cancelled run can resume');
    await c.execute("UPDATE AIEP_TASKS SET status='PENDING',attempts=0,retry_cycle=retry_cycle+1,owner=NULL,lease_until=NULL,due_at=SYSTIMESTAMP,error=NULL WHERE run_id=:id AND status='FAILED'",{id});await c.commit();
  });},
  async tasks(runId){return withConnection(async c=>(await c.execute('SELECT * FROM AIEP_TASKS WHERE run_id=:id ORDER BY created_at,id',{id:runId})).rows.map(readTask),{readOnly:true});},
  async claim(owner,leaseSeconds=240,{runIds}={}){const scope=runScope(runIds);if(scope.empty)return null;return withConnection(async c=>{
    const r=await c.execute(`SELECT t.* FROM AIEP_TASKS t WHERE ${scope.where('t.run_id')} AND EXISTS (SELECT 1 FROM AIEP_RUNS r WHERE r.id=t.run_id AND r.status='RUNNING') AND ((t.status='PENDING' AND t.due_at<=SYSTIMESTAMP) OR (t.status='RUNNING' AND t.lease_until<SYSTIMESTAMP AND t.stage='RETEST')) AND (t.depends_on IS NULL OR EXISTS (SELECT 1 FROM AIEP_TASKS d WHERE d.id=t.depends_on AND d.status='DONE')) AND t.attempts<3 ORDER BY t.created_at,t.id FOR UPDATE SKIP LOCKED`,scope.binds,{resultSet:true,prefetchRows:0,fetchArraySize:1});
    const row=await r.resultSet.getRow();await r.resultSet.close();if(!row){await c.rollback();return null;}
    const task=readTask(row);
    if(task.status==='RUNNING'&&!canAutoReclaim(task)){await c.rollback();return null;}
    if(task.status==='RUNNING')await c.execute("UPDATE AIEP_ATTEMPTS SET status='UNCERTAIN',finished_at=SYSTIMESTAMP WHERE task_id=:id AND status='RUNNING'",{id:task.id});
    await c.execute("UPDATE AIEP_TASKS SET status='RUNNING',owner=:owner,lease_until=SYSTIMESTAMP+NUMTODSINTERVAL(:seconds,'SECOND'),attempts=attempts+1 WHERE id=:id",{id:task.id,owner,seconds:leaseSeconds});
    task.owner=owner;task.status='RUNNING';task.attempts++;task.leaseUntil=Date.now()+leaseSeconds*1000;task.attemptId=randomUUID();
    await c.execute("INSERT INTO AIEP_ATTEMPTS(id,task_id,owner,retry_cycle,attempt_number,status) VALUES(:id,:task,:owner,:cycle,:attempt,'RUNNING')",{id:task.attemptId,task:task.id,owner,cycle:task.cycle,attempt:task.attempts});await c.commit();return task;
  });},
  async heartbeat(task){return withConnection(async c=>{const r=await c.execute("UPDATE AIEP_TASKS SET lease_until=SYSTIMESTAMP+NUMTODSINTERVAL(:seconds,'SECOND') WHERE id=:id AND owner=:owner AND status='RUNNING' AND lease_until>SYSTIMESTAMP AND EXISTS (SELECT 1 FROM AIEP_RUNS r WHERE r.id=AIEP_TASKS.run_id AND r.status='RUNNING')",{id:task.id,owner:task.owner,seconds:240});await c.commit();return r.rowsAffected===1;});},
  async finish(task,document,attemptResult,{startChildRun}={}){return withConnection(async c=>{
    if(startChildRun){const parent=(await c.execute('SELECT status FROM AIEP_RUNS WHERE id=:id FOR UPDATE',{id:task.runId})).rows[0];if(parent?.STATUS!=='RUNNING')throw Object.assign(new Error('Parent job cancelled or stopped; child evaluation remains a draft'),{code:'LEASE_LOST'});}
    const r=await c.execute("UPDATE AIEP_TASKS SET status='DONE',owner=NULL,lease_until=NULL,error=NULL WHERE id=:id AND owner=:owner AND status='RUNNING' AND lease_until>SYSTIMESTAMP AND EXISTS (SELECT 1 FROM AIEP_RUNS r WHERE r.id=AIEP_TASKS.run_id AND r.status='RUNNING')",{id:task.id,owner:task.owner});
    if(r.rowsAffected!==1)throw Object.assign(new Error('Task lease lost; stale worker result was not committed'),{code:'LEASE_LOST'});
    await insertDoc(c,document);
    if(startChildRun){const child=await c.execute("UPDATE AIEP_RUNS SET status='RUNNING',updated_at=SYSTIMESTAMP WHERE id=:id AND status='DRAFT'",{id:startChildRun});if(child.rowsAffected!==1)throw new Error('Development retest is not an unstarted draft');}
    await c.execute("UPDATE AIEP_ATTEMPTS SET status='DONE',result=:result,finished_at=SYSTIMESTAMP WHERE id=:id AND owner=:owner",{id:task.attemptId,owner:task.owner,result:JSON.stringify(attemptResult)});await c.commit();return document.id;
  });},
  async fail(task,error,{retry,delayMs},trace=null){return withConnection(async c=>{
    const safe=safeError(error),result=JSON.stringify({error:safe,trace});
    await c.execute("UPDATE AIEP_ATTEMPTS SET status='FAILED',result=:result,finished_at=SYSTIMESTAMP WHERE id=:id AND owner=:owner AND status='RUNNING'",{id:task.attemptId,owner:task.owner,result});
    await c.execute("UPDATE AIEP_TASKS SET status=:status,error=:error,owner=NULL,lease_until=NULL,due_at=SYSTIMESTAMP+NUMTODSINTERVAL(:delay,'SECOND') WHERE id=:id AND owner=:owner AND status='RUNNING' AND lease_until>SYSTIMESTAMP",{id:task.id,owner:task.owner,status:retry?'PENDING':'FAILED',error:JSON.stringify(safe),delay:delayMs/1000});await c.commit();
  });},
  async settle({runIds}={}){const scope=runScope(runIds);if(scope.empty)return;return withConnection(async c=>{
    const execute=(sql,binds={},column='run_id')=>c.execute(`${sql} AND ${scope.where(column)}`,{...scope.binds,...binds});
    await c.execute(`UPDATE AIEP_ATTEMPTS SET status='UNCERTAIN',finished_at=SYSTIMESTAMP WHERE status='RUNNING' AND task_id IN (SELECT id FROM AIEP_TASKS WHERE stage IN ('PROPOSE','GENERATE','JUDGE') AND status='RUNNING' AND lease_until<SYSTIMESTAMP AND ${scope.where('run_id')})`,scope.binds);
    await execute("UPDATE AIEP_TASKS SET status='FAILED',owner=NULL,lease_until=NULL,error=:e WHERE stage='PROPOSE' AND status='RUNNING' AND lease_until<SYSTIMESTAMP",{e:JSON.stringify({code:'GEPA_INTERRUPTED',message:'Prompt search interrupted; explicit resume required before additional model requests'})});
    await execute("UPDATE AIEP_TASKS SET status='FAILED',owner=NULL,lease_until=NULL,error=:e WHERE stage IN ('GENERATE','JUDGE') AND status='RUNNING' AND lease_until<SYSTIMESTAMP",{e:JSON.stringify({code:'EVALUATION_OUTCOME_UNCERTAIN',message:'Model request outcome is uncertain after interruption; reconcile the original response before resuming'})});
    await execute("UPDATE AIEP_TASKS SET status='FAILED',owner=NULL,lease_until=NULL,error=:e WHERE status='RUNNING' AND lease_until<SYSTIMESTAMP AND attempts>=3",{e:JSON.stringify({code:'ATTEMPTS_EXHAUSTED',message:'Worker interrupted repeatedly; explicit resume required'})});
    await execute("UPDATE AIEP_RUNS r SET status='COMPLETED',updated_at=SYSTIMESTAMP WHERE r.status='RUNNING' AND NOT EXISTS(SELECT 1 FROM AIEP_TASKS t WHERE t.run_id=r.id AND t.status<>'DONE')",{},'r.id');
    await execute("UPDATE AIEP_RUNS r SET status='INCOMPLETE',updated_at=SYSTIMESTAMP WHERE r.status='RUNNING' AND EXISTS(SELECT 1 FROM AIEP_TASKS f WHERE f.run_id=r.id AND f.status='FAILED') AND NOT EXISTS(SELECT 1 FROM AIEP_TASKS t WHERE t.run_id=r.id AND t.status='RUNNING') AND NOT EXISTS(SELECT 1 FROM AIEP_TASKS p WHERE p.run_id=r.id AND p.status='PENDING' AND (p.depends_on IS NULL OR EXISTS(SELECT 1 FROM AIEP_TASKS d WHERE d.id=p.depends_on AND d.status='DONE')))",{},'r.id');await c.commit();
  });},
  async attempts(runId){return withConnection(async c=>(await c.execute('SELECT a.* FROM AIEP_ATTEMPTS a JOIN AIEP_TASKS t ON t.id=a.task_id WHERE t.run_id=:id ORDER BY a.started_at',{id:runId})).rows.map(readAttempt),{readOnly:true});},
  async setReport(runId,docId){return withConnection(async c=>{await c.execute('UPDATE AIEP_RUNS SET report_id=:doc,updated_at=SYSTIMESTAMP WHERE id=:id',{id:runId,doc:docId});await c.commit();});}
};
