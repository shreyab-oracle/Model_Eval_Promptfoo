import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {repository} from '../db/repository.mjs';
import {config,safeError} from '../config.mjs';
import {closePool} from '../db/pool.mjs';
import {assertFrozenEngine} from '../domain/version.mjs';
import {chat,chatBody} from '../oracle/genai.mjs';
import {digest} from '../domain/policy.mjs';
import {putJSON,getJSON} from '../oracle/storage.mjs';
import {retryDisposition} from './task-policy.mjs';
import {writeReport,isCurrentEvaluation} from './runs.mjs';
import {assertOptimizer} from '../optimization/version.mjs';
import {createRetest} from './prompts.mjs';
import {optimizePrompt} from '../optimization/engine.mjs';
import {createAwakeGuard} from './awake.mjs';
import {evaluateTask} from '../evaluation/task.mjs';
import {responseJournal} from './response-journal.mjs';
import {assertExecutionProtocol} from './execution-protocol.mjs';

const log=(event,details)=>console.error(JSON.stringify({at:new Date().toISOString(),event,...details}));
export function responseRetryDisposition(task,error,{received=false,persistedTrace=false}={}){
  if(task.stage==='PROPOSE'||(received&&(!persistedTrace||error.code!=='INVALID_JUDGE_ASSESSMENT')))return{retry:false,delayMs:0};
  return retryDisposition(error,task.attempts,task.stage);
}

export async function processTask(task,{store=repository,loadArtifact=getJSON,writeArtifact=putJSON,journal=responseJournal,call=chat}={}){
  let alive=true,response,trace,receipt,receivedTrace,requestBody,endpoint,heartbeatError,heartbeatBusy=false;
  const controller=new AbortController();
  const heartbeat=setInterval(async()=>{
    if(heartbeatBusy||!alive)return;heartbeatBusy=true;
    try{if(!await store.heartbeat(task)){alive=false;controller.abort();}}
    catch(error){heartbeatError=error;alive=false;controller.abort();log('lease-heartbeat-failed',{taskId:task.id,error:safeError(error)});}
    finally{heartbeatBusy=false;}
  },30000);heartbeat.unref();
  const started=performance.now();
  try{
    const run=await store.run(task.runId),manifest=await store.doc(run.manifestId),snapshot=await loadArtifact(manifest.artifact);
    const source=task.stage==='PROPOSE'||task.stage==='RETEST'?snapshot.source:snapshot;assertFrozenEngine(source);assertExecutionProtocol(source);
    if(task.stage==='PROPOSE'){
      const value=await optimizePrompt(snapshot,task,{isAlive:()=>alive&&!stopping,signal:controller.signal});
      await store.finish(task,{id:task.id,kind:'PROPOSAL',parentId:task.runId,value},{latencyMs:Math.round(performance.now()-started),callAttempts:value.callAttempts,trace:value.artifact});return;
    }
    if(task.stage==='RETEST'){
      const proposal=await store.doc(task.payload.proposalId);if(!proposal)throw new Error('Proposal missing');
      if(proposal.changed===false){await store.finish(task,{id:task.id,kind:'RETEST_LINK',parentId:proposal.id,value:{skipped:true,reason:'No acceptable prompt improvement; original prompt retained.'}},{modelCall:false});return;}
      const link=await createRetest(snapshot,proposal,task.runId);if(!alive)throw Object.assign(new Error('Worker lease lost'),{code:'LEASE_LOST'});
      await store.finish(task,{id:task.id,kind:'RETEST_LINK',parentId:proposal.id,value:link},{latencyMs:Math.round(performance.now()-started),modelCall:false},{startChildRun:link.runId});return;
    }
    endpoint=source.genaiEndpoint;
    const guard=async()=>{if(!alive||stopping||!await store.heartbeat(task))throw Object.assign(new Error('Task cancelled or worker lease lost'),{code:'LEASE_LOST'});};
    const evaluated=await evaluateTask({snapshot,task,loadDocument:id=>store.doc(id),guard,
      call:request=>{requestBody=chatBody(request);return call(request);},
      onReceived:async(receivedResponse,request)=>{
        response=receivedResponse;
        const received={taskId:task.id,attemptId:task.attemptId,stage:task.stage,modelId:request.modelId,endpoint,requestBody,requestDigest:digest(requestBody),requestId:response.requestId,latencyMs:response.latencyMs,usage:response.usage,raw:response.raw};
        receivedTrace=received;
        // Journal the exact received answer before any assertion or remote write.
        receipt=await journal.persistResponse(task,received);
        trace=await writeArtifact('traces',task.attemptId,received);
      }});
    const kind=task.stage==='GENERATE'?'OUTPUT':'JUDGE',value={...evaluated.value,evaluation:evaluated.evaluation,responseSource:evaluated.responseSource};
    if(!alive)throw Object.assign(new Error('Worker lease lost while request was in flight'),{code:'LEASE_LOST'});
    await store.finish(task,{id:task.id,kind,parentId:task.runId,value:{...value,trace,latencyMs:response.latencyMs,usage:response.usage,requestId:response.requestId}},{latencyMs:response.latencyMs,usage:response.usage,requestId:response.requestId,trace});
    await journal.clear(task.attemptId,{remoteCommitted:true,expectedDigest:receipt.digest}).catch(error=>log('receipt-cleanup-failed',{taskId:task.id,error:safeError(error)}));
  }catch(error){
    // Preserve the database/network cause instead of replacing it with the
    // secondary optimizer subprocess-cancelled symptom after a lost heartbeat.
    error=heartbeatError||error;
    // Recovery must see the identical received trace, even when its first cloud
    // write failed. Attempt.error already preserves the processing diagnostic.
    if(!trace&&requestBody)try{trace=receivedTrace?
      await writeArtifact('traces',task.attemptId,receivedTrace):
      await writeArtifact('error-traces',task.attemptId,{taskId:task.id,attemptId:task.attemptId,requestBody,requestDigest:digest(requestBody),endpoint,raw:error.raw||null,latencyMs:Math.round(performance.now()-started),error:safeError(error)});}catch{}
    // A received answer is replayed from evidence; it must never trigger another
    // model call because its database or storage commit was interrupted.
    const retry=responseRetryDisposition(task,error,{received:!!response,persistedTrace:!!trace});
    const recorded=await store.fail(task,error,retry,trace).then(()=>true).catch(e=>{log('attempt-persistence-failed',{taskId:task.id,error:safeError(e)});return false;});
    if(recorded&&trace&&receipt&&error.code==='INVALID_JUDGE_ASSESSMENT')await journal.clear(task.attemptId,{remoteCommitted:true,expectedDigest:receipt.digest}).catch(e=>log('receipt-cleanup-failed',{taskId:task.id,error:safeError(e)}));
    log('task-failed',{taskId:task.id,error:safeError(error)});
  }finally{clearInterval(heartbeat);}
}
let stopping=false;
function stopWorker(){stopping=true;}
export async function eligibleWorkerRuns(runs,{loadManifest=id=>repository.doc(id),cache=new Map(),runIds}={}){
  if(runIds!==undefined&&(!Array.isArray(runIds)||runIds.some(id=>typeof id!=='string'||!id)))throw new Error('A valid worker run scope is required');
  const scope=runIds&&new Set(runIds);
  const eligible=[];
  for(const run of runs){
    if(scope&&!scope.has(run.id))continue;
    if(run.kind==='diagnostic')continue;
    if(!cache.has(run.manifestId)){
      const manifest=await loadManifest(run.manifestId),snapshot=manifest?.snapshot;
      let current=isCurrentEvaluation(snapshot?.source||snapshot);
      if(current&&snapshot.optimizer)try{assertOptimizer(snapshot);}catch{current=false;}
      cache.set(run.manifestId,current);
    }
    if(cache.get(run.manifestId))eligible.push(run);
  }
  return eligible;
}
export async function workerLoop({once=false,reports=true,signal,runIds:scopeIds}={}){
  if(signal?.aborted)return;
  const owner=randomUUID(),inflight=new Set(),compatibleManifests=new Map(),awake=createAwakeGuard({onError:error=>log('sleep-prevention-unavailable',{error:safeError(error)})});
  try{
  do{
    try{
      const runs=await eligibleWorkerRuns(await repository.runs({worker:true}),{cache:compatibleManifests,runIds:scopeIds}),runIds=runs.map(r=>r.id);
      await repository.settle({runIds});
      awake.setActive(inflight.size>0||runs.some(r=>r.status==='RUNNING'));
      if(reports)for(const run of runs.filter(r=>r.status==='COMPLETED'&&r.kind!=='improvement'&&!r.reportId))await writeReport(run.id).catch(e=>log('report-failed',{runId:run.id,error:safeError(e)}));
      while(!stopping&&!signal?.aborted&&inflight.size<config.concurrency){const task=await repository.claim(owner,config.leaseSeconds,{runIds});if(!task)break;awake.setActive(true);const p=processTask(task).finally(()=>inflight.delete(p));inflight.add(p);}
      if(once){await Promise.all(inflight);await repository.settle({runIds});return;}
    }catch(e){if(!inflight.size)awake.setActive(false);log('worker-error',{error:safeError(e)});}
    await Promise.race([new Promise(r=>setTimeout(r,1500)),...inflight]);
  }while(!stopping&&!signal?.aborted);
  await Promise.all(inflight);
  }finally{awake.setActive(false);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,stopWorker);
  await workerLoop({reports:!process.argv.includes('--no-reports')});await closePool();
}
