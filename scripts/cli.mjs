import fs from 'node:fs';
import path from 'node:path';
import {generateDataset,validateDataset} from '../src/domain/dataset.mjs';
import {canonical} from '../src/domain/policy.mjs';
import {safeError,config} from '../src/config.mjs';
import {closePool} from '../src/db/pool.mjs';
const args=process.argv.slice(2),command=args.shift();const opts={};for(let i=0;i<args.length;i++)if(args[i].startsWith('--'))opts[args[i].slice(2)]=args[i+1]&&!args[i+1].startsWith('--')?args[++i]:true;
const print=value=>console.log(JSON.stringify(value,null,2));
try{
  const {repository}=await import('../src/db/repository.mjs');
  const data=await import('../src/services/datasets.mjs'),runs=await import('../src/services/runs.mjs');
  switch(command){
    case'migrate':print(await(await import('../src/db/migrate.mjs')).migrate());await data.seedVersions();break;
    case'generate':{const d=generateDataset({kind:opts.kind||'release',version:opts.version||'v1',seed:Number(opts.seed||20261028)}),file=path.resolve(opts.out||`data/${d.kind}-${d.version}.json`);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,canonical(d));print({file,kind:d.kind,cases:d.cases.length,validation:validateDataset(d),labelStatus:d.labelStatus});break;}
    case'import':{if(!opts.file)throw new Error('Use import --file data/dataset.json');const d=await data.importDataset(JSON.parse(fs.readFileSync(opts.file,'utf8')));print({id:d.id,cases:d.dataset.cases.length,artifact:d.artifact});break;}
    case'list':print({datasets:(await repository.docs('DATASET')).map(d=>({id:d.id,version:d.version,kind:d.dataset.kind,cases:d.dataset.cases.length})),prompts:await repository.docs('PROMPT'),policies:await repository.docs('POLICY'),runs:await repository.runs()});break;
    case'status':print(await(await import('../src/services/status.mjs')).connectionStatus());break;
    case'freeze':{const d=opts.dataset||(await repository.docs('DATASET')).find(d=>d.dataset.kind==='release')?.id,p=opts.prompt||(await repository.docs('PROMPT')).find(p=>!p.generated)?.id,l=opts.policy||(await repository.docs('POLICY'))[0]?.id;print(await runs.createRun({datasetId:d,promptId:p,policyId:l}));break;}
    case'start':print(await runs.startRun(opts.run));break;
    case'resume':print(await runs.resumeRun(opts.run));break;
    case'cancel':await repository.cancel(opts.run);print({cancelled:true});break;
    case'report':print(await runs.writeReport(opts.run));break;
    case'gate':{
      await(await import('./gate-command.mjs')).runGateCommand(opts.run,{print});break;
    }
    case'improve':print(await(await import('../src/services/prompts.mjs')).proposeImprovement({sourceRunId:opts.run,autoRetest:!opts['no-retest'],actor:config.reviewer,limits:{...(opts['max-case-evaluations']?{maxCaseEvaluations:Number(opts['max-case-evaluations'])}:{}),...(opts['max-proposals']?{maxProposals:Number(opts['max-proposals'])}:{})}}));break;
    case'history':print(await(await import('../src/services/history.mjs')).evaluationHistory());break;
    case'worker':await(await import('../src/services/worker.mjs')).workerLoop({once:opts.once===true});break;
    case'smoke':{const role=opts.role||'baseline';if(!config.models[role])throw new Error('Use --role baseline, candidate or judge');const ai=await import('../src/oracle/genai.mjs'),settings=(await import('../src/domain/model-settings.mjs')).settingsForModel(await ai.modelMetadata(config.models[role]),{openai:config.settings,gemini:config.geminiSettings});const r=await ai.chat({modelId:config.models[role],mode:config.modes[role],settings,messages:[{role:'USER',content:'Return exactly the JSON object {"connected":true}.'}]});const artifact=await(await import('../src/oracle/storage.mjs')).putJSON('smoke',`${role}-${Date.now()}`,r);await repository.saveDoc({kind:'SMOKE',value:{role,settings,artifact,requestId:r.requestId,latencyMs:r.latencyMs,usage:r.usage}});print({role,text:r.text,latencyMs:r.latencyMs,usage:r.usage,requestId:r.requestId,artifact});break;}
    default:throw new Error('Commands: migrate, generate, import, list, status, freeze, start --run ID, resume --run ID, cancel, report, gate --run ID, improve --run ID, history, worker, smoke --role baseline');
  }
}catch(e){console.error(JSON.stringify({error:safeError(e)}));process.exitCode=1;}finally{await closePool().catch(e=>{console.error(JSON.stringify({error:safeError(e)}));process.exitCode=1;});}
