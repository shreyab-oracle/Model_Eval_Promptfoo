// Explicit live acceptance of the existing 24/100 suites. The saved session
// reuses run IDs on restart, so rerunning this command cannot resample a suite.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {config,safeError} from '../src/config.mjs';
import {digest} from '../src/domain/policy.mjs';
import {repository} from '../src/db/repository.mjs';
import {withConnection,closePool} from '../src/db/pool.mjs';
import {ociRequest} from '../src/oracle/auth.mjs';
import {importDataset} from '../src/services/datasets.mjs';
import {createRun,startRun,resumeRun,runBundle,writeReport,comparison} from '../src/services/runs.mjs';
import {workerLoop} from '../src/services/worker.mjs';
import {makeServer} from '../src/http/server.mjs';
import {legacyDatabaseAudit} from './legacy-audit.mjs';

if(!process.argv.includes('--execute')){
  console.log('Use node scripts/live-acceptance.mjs --execute for 2,232 planned OCI requests. An existing saved session is reused.');
  process.exit(0);
}
const directory=path.resolve('.local/promptfoo-project/verification'),sessionFile=path.join(directory,'live-24-100.json');
await fs.mkdir(directory,{recursive:true});
const log=value=>console.log(JSON.stringify({at:new Date().toISOString(),...value}));
let session,worker,controller,server;
const save=()=>fs.writeFile(sessionFile,JSON.stringify(session,null,2));
async function legacyAudit(){
  const tables={};
  for(const [table,fields,order] of [['AIE_DOCUMENTS','id,digest','id'],['AIE_RUNS','id,status,manifest_id,report_id,updated_at','id'],['AIE_TASKS','id,status,attempts,retry_cycle','id'],['AIE_ATTEMPTS','id,status','id']]){
    const rows=await withConnection(async c=>(await c.execute(`SELECT ${fields} FROM ${table} ORDER BY ${order}`)).rows,{readOnly:true});
    tables[table]={count:rows.length,digest:digest(JSON.parse(JSON.stringify(rows)))};
  }
  const storage=config.storage,objects=[];let start;
  do{
    const url=new URL(`https://objectstorage.${storage.region}.oraclecloud.com/n/${encodeURIComponent(storage.namespace)}/b/${encodeURIComponent(storage.bucket)}/o`);
    url.searchParams.set('prefix','ai-model-evaluation/');url.searchParams.set('fields','name,etag');url.searchParams.set('limit','1000');if(start)url.searchParams.set('start',start);
    const response=await ociRequest('GET',url.href);objects.push(...response.data.objects.map(o=>({name:o.name,etag:o.etag})));
    const next=response.data.nextStartWith;assert.ok(!next||next!==start,'Object listing cursor must advance');start=next;
  }while(start);
  objects.sort((a,b)=>a.name.localeCompare(b.name));return{tables,oldObjectPrefix:{prefix:'ai-model-evaluation/',count:objects.length,digest:digest(objects)}};
}
async function launchWorker(){controller=new AbortController();worker=workerLoop({reports:false,signal:controller.signal,runIds:session.runs.map(run=>run.id)});}
async function drainWorker(){controller?.abort();await worker;worker=null;}
async function verifyRun(entry,base){
  let bundle=await runBundle(entry.id);assert.equal(bundle.run.status,'COMPLETED');
  assert.equal(bundle.tasks.length,entry.cases*18);assert.ok(bundle.tasks.every(task=>task.status==='DONE'));
  log({stage:'verify-evidence',kind:entry.kind,runId:entry.id});
  if(!bundle.run.reportId)await writeReport(entry.id);
  const before=(await repository.attempts(entry.id)).length;
  const response=await fetch(base+'/eval/'+entry.id);assert.equal(response.status,200);assert.match(await response.text(),/<title>promptfoo<\/title>/);
  const viewerId=new URL(response.url).pathname.split('/')[2];
  const native=await(await fetch(base+'/promptfoo/api/eval/'+viewerId+'/table?limit=1000')).json();
  assert.equal(native.table.body.length,entry.cases*3);assert.equal(native.table.head.prompts.length,2);
  const outputs=native.table.body.flatMap(row=>row.outputs);assert.equal(outputs.length,entry.cases*6);
  assert.ok(outputs.some(output=>Object.keys(output.namedScores||{}).length===10),'Both judges must have named scores');
  assert.ok(outputs.some(output=>output.metadata.findings?.length),'Named programmed findings must reach the native viewer');
  for(const field of ['newCandidateFailure','candidateImprovement','confirmedCriticalFailure','needsHumanReview','unresolved']){
    const filter=encodeURIComponent(JSON.stringify({type:'metadata',field,operator:'equals',value:'true'}));
    assert.equal((await fetch(base+'/promptfoo/api/eval/'+viewerId+'/table?limit=1&filter='+filter)).status,200);
  }
  assert.equal((await fetch(base+'/promptfoo/api/eval/replay',{method:'POST'})).status,409);
  const report=await(await fetch(base+'/api/runs/'+entry.id+'/report')).json();assert.equal(report.current,true);
  const controls=await fetch(base+'/operations?tab=run&run='+entry.id);assert.equal(controls.status,200);
  assert.match(await controls.text(),/Download original report/);
  assert.equal((await fetch(base+'/operations?tab=reviews&run='+entry.id)).status,200);
  assert.equal((await repository.attempts(entry.id)).length,before,'Viewing saved results cannot request inference');
  const gate=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['scripts/cli.mjs','gate','--run',entry.id],{cwd:process.cwd(),windowsHide:true,stdio:['ignore','pipe','pipe']});let output='',error='';
    child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>error+=chunk);child.once('error',reject);child.once('close',code=>{try{resolve({code,value:JSON.parse(output)});}catch{reject(new Error(error||output));}});
  });
  const current=await comparison(entry.id);assert.equal(gate.code,gate.value.exitCode);
  assert.equal(gate.value.decision,current.result.decision);
  bundle=await runBundle(entry.id);
  entry.result={status:bundle.run.status,plannedTasks:bundle.tasks.length,attempts:bundle.attempts.length,
    outputs:bundle.outputs.length,judgments:bundle.judges.length,decision:current.result.decision,
    candidateCriticalFailures:current.result.criticalCandidateFailures,pendingReviews:current.result.pendingReviews,
    outcomes:current.result.outcomes,gateExitCode:gate.code,report:bundle.run.reportId,
    nativeViewerId:decodeURIComponent(viewerId),savedViewingMadeNoCalls:true,evidenceVerified:true};
  await save();log({stage:'suite-verified',kind:entry.kind,...entry.result});
}
try{
  try{session=JSON.parse(await fs.readFile(sessionFile,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(!session){
    session={startedAt:new Date().toISOString(),namespace:'AIEP_',storagePrefix:config.storage.prefix,plannedRequests:2232,legacyBefore:await legacyAudit(),runs:[]};await save();
  }
  // A separate checkpoint preserves the original audit in sessions created by
  // an older harness, while covering all legacy row fields in new sessions.
  if(!session.legacyFullBefore){session.legacyFullBefore=await legacyDatabaseAudit();await save();}
  assert.equal(config.storage.prefix,session.storagePrefix);assert.ok(config.storage.prefix.startsWith('ai-model-evaluation-promptfoo/'));
  const prompt=(await repository.docs('PROMPT')).find(p=>!p.generated),policy=(await repository.docs('POLICY'))[0];assert.ok(prompt&&policy,'Run migrations and seed versions first');
  for(const kind of ['development','release']){
    if(session.runs.some(run=>run.kind===kind))continue;
    const dataset=await importDataset(JSON.parse(await fs.readFile('data/'+kind+'-v1.json','utf8'))),cases=dataset.dataset.cases.length;
    assert.equal(cases,kind==='development'?24:100);
    const run=await createRun({datasetId:dataset.id,promptId:prompt.id,policyId:policy.id});session.runs.push({kind,id:run.id,cases});await save();
  }
  server=makeServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,'127.0.0.1',resolve);});
  const base='http://127.0.0.1:'+config.port;
  config.concurrency=4; // Existing supported worker limit; model settings remain frozen.
  for(const entry of session.runs){const run=await repository.run(entry.id);if(run.status==='DRAFT')await startRun(entry.id);else if(['CANCELLED','INCOMPLETE'].includes(run.status))throw new Error('Explicitly inspect and resume saved run '+entry.id+' before restarting acceptance');}
  await launchWorker();let lastLog=0;
  while(session.runs.some(entry=>!entry.result)){
    const progress=[];
    for(const entry of session.runs){
      if(entry.result)continue;
      const run=await repository.run(entry.id),tasks=await repository.tasks(entry.id),done=tasks.filter(task=>task.status==='DONE').length;
      progress.push({kind:entry.kind,runId:entry.id,status:run.status,done,total:tasks.length,failed:tasks.filter(task=>task.status==='FAILED').length});
      if(entry.kind==='development'&&!session.cancelResumeVerified&&done>=4&&run.status==='RUNNING'){
        await drainWorker();const saved=(await repository.docs('OUTPUT',entry.id)).map(o=>[o.id,o.digest]);const attempts=(await repository.attempts(entry.id)).length;
        await repository.cancel(entry.id);assert.equal((await repository.run(entry.id)).status,'CANCELLED');await resumeRun(entry.id);
        assert.deepEqual((await repository.docs('OUTPUT',entry.id)).map(o=>[o.id,o.digest]),saved);assert.equal((await repository.attempts(entry.id)).length,attempts);
        session.cancelResumeVerified={completedAnswersPreserved:saved.length,attemptsBeforeResume:attempts};await save();log({stage:'cancel-resume-verified',...session.cancelResumeVerified});await launchWorker();
      }
      if(run.status==='COMPLETED')await verifyRun(entry,base);
      else if(['INCOMPLETE','CANCELLED'].includes(run.status))throw new Error('Live suite needs inspection: '+entry.id+' '+run.status);
    }
    if(Date.now()-lastLog>15000){log({stage:'evaluating',progress});lastLog=Date.now();}
    await new Promise(resolve=>setTimeout(resolve,2000));
  }
  await drainWorker();session.legacyAfter=await legacyAudit();assert.deepEqual(session.legacyAfter,session.legacyBefore,'Existing React tables/objects must remain unchanged');
  session.legacyFullAfter=await legacyDatabaseAudit();assert.deepEqual(session.legacyFullAfter,session.legacyFullBefore,'All original React database row fields and sequence metadata must remain unchanged');
  session.completedAt=new Date().toISOString();session.oldProjectUnchanged=true;await save();log({stage:'complete',sessionFile,runs:session.runs});
}catch(error){if(session){session.lastError=safeError(error);await save();}console.error(JSON.stringify({error:safeError(error)}));process.exitCode=1;}
finally{await drainWorker();if(server)await new Promise(resolve=>server.close(resolve));await closePool();}
