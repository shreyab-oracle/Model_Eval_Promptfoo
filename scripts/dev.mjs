import {spawn} from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import {config} from '../src/config.mjs';
import {buildUI} from './build-ui.mjs';
if(!fs.existsSync('node_modules/promptfoo/dist/src/app/index.html')){console.error('Native Promptfoo UI is missing. Run npm.cmd ci --ignore-scripts from the project root.');process.exit(1);}
const apiPort=config.port,uiURL=`http://127.0.0.1:${apiPort}/eval`;
if(!Number.isInteger(apiPort)||apiPort<1||apiPort>65535){console.error('The configured API port must be an integer from 1 to 65535. No services were started.');process.exit(1);}
function portState(port){return new Promise(resolve=>{const socket=net.createConnection({host:'127.0.0.1',port});let settled=false;const finish=state=>{if(settled)return;settled=true;socket.destroy();resolve(state);};socket.setTimeout(750,()=>finish('unavailable'));socket.once('connect',()=>finish('occupied'));socket.once('error',error=>finish(error.code==='ECONNREFUSED'?'free':'unavailable'));});}
async function isOurAPI(){try{const response=await fetch(`http://127.0.0.1:${apiPort}/health`,{redirect:'error',signal:AbortSignal.timeout(4000)});return response.ok&&(await response.json()).app==='oracle-promptfoo';}catch{return false;}}
const apiState=await portState(apiPort);
if(apiState!=='free'){
  if(apiState==='occupied'&&await isOurAPI()){console.log(`Oracle-backed Promptfoo is already running: ${uiURL}`);console.log('Use the existing application. No additional workers were started.');process.exit(0);}
  console.error(`Port ${apiPort} is ${apiState}. No services were started. Reuse or stop the existing service before starting again.`);process.exit(1);
}
await buildUI();
console.log(`Native Promptfoo UI: ${uiURL}`);
const commands=[['UI/API',['--env-file=.env.local','src/http/server.mjs']],['Worker',['--env-file=.env.local','src/services/worker.mjs']]];
const children=commands.map(([name,args])=>{const child=spawn(process.execPath,args,{stdio:'inherit',windowsHide:true});child.on('error',e=>{console.error(`${name}: ${e.message}`);stop(1);});child.on('exit',code=>{if(!stopping&&code)stop(code);});return child;});
let stopping=false;function stop(code=0){if(stopping)return;stopping=true;for(const c of children)c.kill('SIGTERM');process.exitCode=code;}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>stop());
