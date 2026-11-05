import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {digest} from '../domain/policy.mjs';
import {PROMPTFOO_VERSION} from '../evaluation/version.mjs';

const cli=path.join(path.dirname(createRequire(import.meta.url).resolve('promptfoo')),'entrypoint.js');
const providerPath=fileURLToPath(new URL('./promptfoo-provider.mjs',import.meta.url));
const provider='file://./promptfoo-provider.mjs';
function environment(directory){
  const env=Object.fromEntries(['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
  return{...env,PROMPTFOO_CONFIG_DIR:directory,PROMPTFOO_DISABLE_TELEMETRY:'1',PROMPTFOO_DISABLE_UPDATE:'1',PROMPTFOO_DISABLE_REMOTE_GENERATION:'true',PROMPTFOO_DISABLE_SHARING:'true',PROMPTFOO_CACHE_ENABLED:'false',PROMPTFOO_DISABLE_TEMPLATING:'true',PROMPTFOO_DISABLE_TEMPLATE_ENV_VARS:'true',PROMPTFOO_TRACING_ENABLED:'false'};
}
const cancelled=()=>Object.assign(new Error('Promptfoo optimization cancelled'),{code:'OPTIMIZER_CANCELLED'});

// Promptfoo owns search and candidate evaluation. This temporary, authenticated
// callback boundary keeps OCI, budgets and evidence in the existing worker.
export function optimizerTimeoutMs(limits,requestTimeoutMs=180000){
  const calls=limits.maxCalls??limits.maxCaseEvaluations*9+limits.maxProposals;
  if(!Number.isSafeInteger(calls)||calls<1||!Number.isFinite(requestTimeoutMs)||requestTimeoutMs<1)throw new Error('Invalid optimizer timeout budget');
  return Math.max(3600000,calls*(requestTimeoutMs+30000));
}
export async function runPromptfooOptimizer(input,handle,{signal,timeoutMs,onAbort=()=>{}}={}){
  if(signal?.aborted)throw cancelled();
  input=structuredClone(input);
  if(typeof input.prompt!=='string'||!input.prompt.trim()||!Array.isArray(input.trainIds)||!Array.isArray(input.validationIds))throw new Error('Invalid development optimization partition');
  const ids=[...input.trainIds,...input.validationIds],cases=new Set(ids);
  if(!ids.length||ids.some(id=>typeof id!=='string'||!id.trim())||cases.size!==ids.length||!input.trainIds.length||!input.validationIds.length||input.validationIds.length>ids.length/2)throw new Error('Invalid development optimization partition');
  if(!Number.isSafeInteger(input.limits?.maxCaseEvaluations)||input.limits.maxCaseEvaluations<ids.length||!Number.isSafeInteger(input.limits?.maxProposals)||input.limits.maxProposals<1)throw new Error('Invalid development optimization budget');
  const deadlineMs=timeoutMs??optimizerTimeoutMs(input.limits,input.requestTimeoutMs);
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'aie-promptfoo-optimize-')),token=randomBytes(32).toString('hex');
  const assessed=new Map(),suggestions=new Map();let proposed=0,stopped=null,failure,child,log='',timer;
  const stop=error=>{if(!failure){failure=error;onAbort();child?.kill('SIGTERM');}};
  const abort=()=>stop(cancelled());
  const active=()=>{if(failure||signal?.aborted)throw failure||cancelled();};
  const server=http.createServer(async(req,res)=>{
    let heartbeat;
    try{
      if(req.method!=='POST'||req.headers.authorization!=='Bearer '+token)throw new Error('Unauthorized optimizer callback');
      active();
      let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>2*1024*1024)throw new Error('Optimizer callback exceeds 2 MiB');}
      const body=JSON.parse(raw);
      active();
      res.writeHead(200,{'content-type':'application/json'});res.write(' ');
      // A case performs nine existing OCI calls. Keep the local HTTP response
      // alive while receipts are saved; the job lease still controls execution.
      heartbeat=setInterval(()=>{if(!res.destroyed)res.write(' ');},15000);heartbeat.unref();
      if(req.url==='/case'){
        if(typeof body.text!=='string'||!cases.has(body.caseId))throw new Error('Optimizer requested an unfrozen case or prompt');
        const key=digest({text:body.text,caseId:body.caseId});
        if(!assessed.has(key)){
          if(assessed.size>=input.limits.maxCaseEvaluations)throw new Error('Promptfoo case evaluation budget exceeded');
          assessed.set(key,Promise.resolve().then(()=>{active();return handle({operation:'evaluate',text:body.text,caseIds:[body.caseId]});}).then(value=>{
            if(value.rows?.length!==1||value.rows[0].caseId!==body.caseId||typeof value.rows[0].pass!=='boolean')throw new Error('Invalid backend case assessment');return value.rows[0];
          }));
        }
        res.end(JSON.stringify(await assessed.get(key)));return;
      }
      if(req.url!=='/v1/chat/completions')throw new Error('Unsupported optimizer callback');
      const key=digest(body);
      if(!suggestions.has(key))suggestions.set(key,(async()=>{
        const request=JSON.parse(body.messages?.at(-1)?.content||'{}');
        if(typeof request.currentPrompt!=='string')throw new Error('Invalid native optimization feedback');
        const capacity=Math.floor((input.limits.maxCaseEvaluations-assessed.size)/ids.length);
        const count=Math.min(3,input.limits.maxProposals-proposed,capacity),candidates=[];
        if(count<=0)stopped=capacity<=0?'case evaluation limit':'proposal limit';
        for(let index=0;index<count;index++){
          if(proposed>=input.limits.maxProposals){stopped='proposal limit';break;}
          active();proposed++;
          const result=await handle({operation:'propose',text:request.currentPrompt,feedback:request});
          if(typeof result.text!=='string')throw new Error('Invalid backend prompt proposal');
          if(result.text.trim()!==request.currentPrompt.trim())candidates.push({prompt:result.text,hypothesis:result.rationale||'Revision based on recorded development feedback'});
        }
        if(!candidates.length&&!stopped)stopped='No distinct prompt revision was proposed';
        return{choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({candidates})}}]};
      })());
      res.end(JSON.stringify(await suggestions.get(key)));
    }catch(error){stop(error);if(!res.headersSent)res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:error.message}));}
    finally{clearInterval(heartbeat);}
  });
  try{
    await fs.writeFile(path.join(directory,'promptfoo.yaml'),'id: oracle-prompt-optimizer\n');
    // The pinned assertion loader splits at the first colon, including Windows
    // drive letters. Relative callbacks also stay within its guarded base path.
    await fs.copyFile(providerPath,path.join(directory,'promptfoo-provider.mjs'));
    await fs.writeFile(path.join(directory,'assert-assessment.mjs'),"export {assertAssessment as default} from './promptfoo-provider.mjs';\n");
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const endpoint='http://127.0.0.1:'+server.address().port,configPath=path.join(directory,'optimization.json');
    await fs.writeFile(configPath,JSON.stringify({prompts:[input.prompt],providers:[provider],tests:ids.map(caseId=>({vars:{caseId},assert:[{type:'javascript',value:'file://./assert-assessment.mjs'}],options:{disableConversationVar:true,disableVarExpansion:true}})),
      defaultTest:{assert:[]},writeLatestResults:false,sharing:false,tracing:{enabled:false},evaluateOptions:{cache:false,repeat:1,maxConcurrency:1,showProgressBar:false,generateSuggestions:false,timeoutMs:0,maxEvalTimeMs:0}}));
    const env={...environment(directory),AIE_OPTIMIZER_ENDPOINT:endpoint,AIE_OPTIMIZER_TOKEN:token,OPENAI_API_KEY:token,OPENAI_API_BASE_URL:endpoint+'/v1',OPENAI_BASE_URL:endpoint+'/v1'};
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)throw cancelled();
    const code=await new Promise((resolve,reject)=>{
      child=childProcess.spawn(process.execPath,[cli,'optimize','--config',configPath,'--validation-split',String(input.validationIds.length/ids.length)],{cwd:directory,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
      for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{log=(log+chunk.toString()).slice(-64000);});
      child.once('error',reject);child.once('close',resolve);
      timer=setTimeout(()=>stop(Object.assign(new Error('Promptfoo optimization timed out'),{code:'OPTIMIZER_TIMEOUT'})),deadlineMs);
    });
    if(failure)throw failure;
    // The installed native optimizer rejects an intentionally empty first-round
    // candidate list. Only that precise expected exit may represent a budget
    // or convergence stop; unrelated native failures must still surface.
    const lastLine=log.replace(/\u001b\[[0-9;]*m/g,'').trim().split(/\r?\n/).map(line=>line.trim())
      .filter(line=>line&&!/^(There were some errors during the operation\. See logs for more details\.|Error log: |Debug log: )/.test(line)).at(-1);
    if(/Provider call failed during eval/.test(log))throw new Error(`Promptfoo native case assessment failed: ${log}`);
    if(code!==0&&!(stopped&&lastLine==='Optimizer provider returned no usable prompt candidates.'))throw new Error(`Promptfoo optimizer exited ${code}: ${log}`);
    if(!assessed.size)throw new Error('Promptfoo optimizer did not evaluate the frozen development cases');
    return{optimizer:'Promptfoo',version:PROMPTFOO_VERSION,evaluated:assessed.size,proposed,stopped,log};
  }finally{
    clearTimeout(timer);signal?.removeEventListener('abort',abort);child?.kill('SIGTERM');server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
    // Closing the CLI cannot cancel a received OCI response. Let the existing
    // callback finish saving its durable receipt before this worker unwinds.
    await Promise.allSettled([...assessed.values(),...suggestions.values()]);
    await fs.rm(directory,{recursive:true,force:true,maxRetries:8,retryDelay:150});
  }
}

export async function verifyOptimizer(){
  await fs.access(cli);await fs.access(fileURLToPath(new URL('./promptfoo-provider.mjs',import.meta.url)));
  return{optimizer:'Promptfoo',version:PROMPTFOO_VERSION,modelCalls:0};
}
