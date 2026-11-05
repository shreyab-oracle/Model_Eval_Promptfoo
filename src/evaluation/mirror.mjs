import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {digest} from '../domain/policy.mjs';
import {comparison} from '../services/runs.mjs';
import {repository} from '../db/repository.mjs';
import {viewerTable,viewerReviewCounts,viewerOutcomeCounts,VIEWER_PROTOCOL_VERSION} from './viewer.mjs';
const filterFlags=new Set(['newCandidateFailure','candidateImprovement','confirmedCriticalFailure','needsHumanReview','unresolved']);
// Hide internal mirror revisions in navigation labels, including saved mirrors.
// Only presentation fields are changed; evidence and revision metadata stay intact.
export function viewerLabels(data){
  const clean=value=>typeof value==='string'?value.replace(/\s*· mirror snapshot \d+(?=\s*\(|$)/g,''):value;
  for(const config of [data.config,data.data?.config])if(config)config.description=clean(config.description);
  if(Array.isArray(data.data))for(const entry of data.data){entry.description=clean(entry.description);entry.label=clean(entry.label);}
  return data;
}
const nativeMetadata=metadata=>Object.fromEntries(Object.entries(metadata).map(([key,value])=>[key,filterFlags.has(key)?String(value):value]));
function mirrorPage(bundle){
  const page=viewerTable(bundle);
  for(const row of page.table.body)for(const output of row.outputs)output.metadata=nativeMetadata(output.metadata);
  return page;
}

export function mirrorPayload(bundle){
  const page=mirrorPage(bundle);
  return{config:page.config,prompts:page.table.head.prompts,vars:page.table.head.vars,createdAt:bundle.run.createdAt,
    results:page.table.body.flatMap(row=>row.outputs.map((output,promptIdx)=>({
      ...output,provider:{id:['baseline','candidate'][promptIdx],label:page.table.head.prompts[promptIdx].label},
      prompt:{raw:output.prompt,label:page.table.head.prompts[promptIdx].label},testCase:row.test,
      response:{output:output.text,...(output.tokenUsage?{tokenUsage:output.tokenUsage}:{})},
      metadata:{...output.metadata,oracleRunId:bundle.run.id,oracleOutputId:output.id,viewerProtocol:VIEWER_PROTOCOL_VERSION},
    })))};
}

const freePort=()=>new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function startNativeViewer(directory){
  await fs.mkdir(directory,{recursive:true});
  await fs.writeFile(path.join(directory,'promptfoo.yaml'),'id: oracle-evidence-viewer\n');
  const port=await freePort(),root=fileURLToPath(new URL('../../',import.meta.url));
  const main=createRequire(import.meta.url).resolve('promptfoo'),entry=path.join(path.dirname(main),'entrypoint.js');
  const env=Object.fromEntries(['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
  const token=randomBytes(32).toString('hex');
  Object.assign(env,{AIE_MIRROR_TOKEN:token,PROMPTFOO_CONFIG_DIR:directory,PROMPTFOO_DISABLE_TELEMETRY:'1',PROMPTFOO_DISABLE_UPDATE:'1',PROMPTFOO_DISABLE_REMOTE_GENERATION:'true',PROMPTFOO_DISABLE_SHARING:'true',PROMPTFOO_CACHE_ENABLED:'false'});
  const child=spawn(process.execPath,['--require',path.join(root,'scripts/viewer-loopback.cjs'),entry,'view','--port',String(port),'--no'],{env,cwd:directory,windowsHide:true,stdio:['ignore','ignore','pipe']});
  let failure,logs='';child.on('error',error=>failure=error);child.stderr.on('data',chunk=>{logs=(logs+chunk.toString()).slice(-4000);});
  const base=`http://127.0.0.1:${port}`;
  for(let attempt=0;attempt<150;attempt++){
    if(failure||child.exitCode!==null)throw new Error(`Native Promptfoo viewer could not start: ${failure?.message||logs||child.exitCode}`);
    try{const response=await fetch(base+'/health',{headers:{'x-aie-mirror-token':token},signal:AbortSignal.timeout(500)});if(response.ok)return{base,token,close:()=>child.kill('SIGTERM')};}catch{}
    await pause(100);
  }
  child.kill('SIGTERM');throw new Error('Native Promptfoo viewer startup timed out');
}

export function createViewerMirror({directory=path.resolve('.local/promptfoo-project/viewer'),readComparison=comparison,listRuns=()=>repository.runs(),start=startNativeViewer}={}){
  let runtime,index,indexLoad,indexWrite=Promise.resolve(),closed=false;const pending=new Map();
  const native=()=>runtime??=(closed?Promise.reject(new Error('Viewer closed')):start(directory));
  async function loadIndex(){
    if(index)return index;
    return indexLoad??=(async()=>{
      try{const saved=JSON.parse(await fs.readFile(path.join(directory,'oracle-index.json'),'utf8'));index=saved.version===1?saved.entries:{};}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;index={};}
      return index;
    })();
  }
  async function request(route,{method='GET',body}={}){
    const {base,token}=await native();const response=await fetch(base+route,{method,headers:{'x-aie-mirror-token':token,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});
    const data=await response.json();if(!response.ok)throw Object.assign(new Error(data.error||'Promptfoo mirror request failed'),{statusCode:response.status});return data;
  }
  async function synchronize(runId){
    const b=await readComparison(runId),entries=await loadIndex(),sourceDigest=digest({input:b.inputDigest,result:b.result,outputs:b.inputDigest?undefined:b.outputs,protocol:VIEWER_PROTOCOL_VERSION});
    let entry=entries[runId];
    if(entry){try{await request('/api/results/'+encodeURIComponent(entry.viewerId));}catch(error){if(error.statusCode!==404)throw error;entry=null;}}
    if(entry?.sourceDigest===sourceDigest)return{...entry,bundle:b,oracleRunId:runId};
    const payload=mirrorPayload(b);
    const revision=(entry?.revision||0)+1;
    Object.assign(payload.config.metadata,{mirrorSnapshot:revision,runStatus:b.run.status,criticalCandidateFailures:b.result.criticalCandidateFailures??null,pendingReviews:b.result.pendingReviews??null});
    // The supported v4 import API creates immutable mirror snapshots. Do not
    // overwrite prior judgments or use the v3-only table-update endpoint.
    const saved=await request('/api/eval',{method:'POST',body:payload});
    entries[runId]={viewerId:saved.id,sourceDigest,revision};
    await fs.mkdir(directory,{recursive:true});
    // Serialize only the tiny rebuildable lookup index, never an Oracle record.
    await(indexWrite=indexWrite.catch(()=>{}).then(()=>fs.writeFile(path.join(directory,'oracle-index.json'),JSON.stringify({version:1,entries}))));
    return{...entries[runId],bundle:b,oracleRunId:runId};
  }
  async function ensure(id){
    if(id.startsWith('eval-')){const saved=await request('/api/results/'+encodeURIComponent(id));return{viewerId:id,oracleRunId:saved.data.config.metadata.oracleRunId};}
    if(!pending.has(id))pending.set(id,synchronize(id).finally(()=>pending.delete(id)));
    return pending.get(id);
  }
  async function searchParameters(relative,search){
    const params=new URLSearchParams(search);
    const label=params.get('search')?.trim().match(/^example\s*(\d+)(?:\s*,?\s*repetition\s*(\d+))?$/i);
    if(!/^\/api\/eval\/[^/]+\/table$/.test(relative)||!label)return params;
    const example=Number(label[1]),offset=(example-1)*3;
    if(example<1||!Number.isSafeInteger(offset)||(label[2]!==undefined&&!Number.isSafeInteger(Number(label[2]))))return params;
    // Native filters use flat OR clauses. Leave those expressions untouched
    // rather than changing their grouping when adding an exact case constraint.
    if(params.getAll('filter').some(value=>{try{return JSON.parse(value)?.logicOperator?.toUpperCase()==='OR';}catch{return false;}}))return params;
    // Resolve the displayed example number within this immutable snapshot.
    // This reads the native mirror only; it never evaluates or calls a model.
    const page=await request(relative+'?offset='+offset+'&limit=1');
    const metadata=page.table?.body?.[0]?.outputs?.[0]?.metadata;
    if(typeof metadata?.caseId!=='string'||(label[2]!==undefined&&typeof metadata.repeat!=='number'))return params;
    params.delete('search');
    params.append('filter',JSON.stringify({type:'metadata',field:'caseId',operator:'equals',value:metadata.caseId}));
    if(label[2]!==undefined)params.append('filter',JSON.stringify({type:'metadata',field:'repeat',operator:'equals',value:Number(label[2])-1}));
    return params;
  }
  return{ensure,
    async latest(){const run=(await listRuns()).find(r=>!['improvement','diagnostic'].includes(r.kind));return run?ensure(run.id):null;},
    async context(id){const saved=await request('/api/results/'+encodeURIComponent(id)),m=saved.data.config.metadata;return{oracleRunId:m.oracleRunId,result:{decision:m.businessGate,reasons:m.businessGateReasons,criticalCandidateFailures:m.criticalCandidateFailures,pendingReviews:m.pendingReviews},reviewCounts:viewerReviewCounts(saved.data.results?.results),outcomes:viewerOutcomeCounts(saved.data.results?.results),historical:!!m.historical,mirrorSnapshot:m.mirrorSnapshot};},
    async proxy(method,url){
      if(method!=='GET')throw Object.assign(new Error('Use Invoice controls for scheduling, review decisions and reports; direct viewer mutations are disabled.'),{statusCode:409});
      const relative=url.pathname.replace(/^\/promptfoo/,'');
      const params=await searchParameters(relative,url.search);
      const {base,token}=await native();const response=await fetch(base+relative+(params.size?'?'+params:''),{headers:{'x-aie-mirror-token':token},signal:AbortSignal.timeout(30000)});
      if(response.ok&&(/^\/api\/results(?:\/[^/]+)?$/.test(relative)||/^\/api\/eval\/[^/]+\/table$/.test(relative))){
        return Response.json(viewerLabels(await response.json()),{status:response.status});
      }
      return response;
    },
    async close(){closed=true;if(runtime)(await runtime).close();},
  };
}
