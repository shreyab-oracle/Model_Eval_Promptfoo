import fs from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {canonical,digest} from '../domain/policy.mjs';

const fail=(code,message)=>Object.assign(new Error(message),{code});
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const checkId=(value,name)=>{if(!validId(value))throw fail('JOURNAL_INVALID_ID',`Invalid response journal ${name}`);return value;};
const within=(root,target)=>{const relative=path.relative(root,target);return relative!==''&&relative!=='..'&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative);};
const contained=(root,target)=>root===target||within(root,target);
export const receiptDigest=(binding,trace)=>digest({schemaVersion:1,binding,trace});

function verifyTrace(binding,trace){
  checkId(binding?.taskId,'task identifier');checkId(binding?.runId,'run identifier');checkId(binding?.attemptId,'attempt identifier');
  if(!trace||typeof trace!=='object'||Array.isArray(trace)||trace.taskId!==binding.taskId||trace.attemptId!==binding.attemptId||(trace.runId!==undefined&&trace.runId!==binding.runId)||(binding.stage!==undefined&&trace.stage!==binding.stage))throw fail('JOURNAL_BINDING_MISMATCH','Response journal task, run or attempt binding differs from the trace');
  if(!trace.requestBody||typeof trace.requestBody!=='object'||Array.isArray(trace.requestBody)||trace.requestDigest!==digest(trace.requestBody))throw fail('JOURNAL_REQUEST_MISMATCH','Response journal request digest does not match its frozen request');
  if(trace.raw===undefined||trace.raw===null)throw fail('JOURNAL_RESPONSE_MISSING','A received raw model response is required before journaling');
}
const descriptor=(record,file)=>({attemptId:record.binding.attemptId,taskId:record.binding.taskId,runId:record.binding.runId,digest:record.digest,path:file});

export function createResponseJournal({directory=path.resolve('.local/promptfoo-project/response-journal')}={}){
  const requested=path.resolve(directory),workspace=path.resolve(process.cwd()),temporary=path.resolve(os.tmpdir());
  // Windows temp paths may use the 8.3 spelling while callers hold the long path.
  const allowed=[workspace,realpathSync(workspace),temporary,realpathSync(temporary)].find(root=>within(root,requested));
  if(!allowed)throw fail('JOURNAL_PATH_OUTSIDE_ROOT','Response journal must be in a child directory of the workspace or temporary directory');

  async function prepare(create=false){
    const root=await fs.realpath(allowed);
    let ancestor=requested;
    for(;;){
      try{const real=await fs.realpath(ancestor);if(!contained(root,real))throw fail('JOURNAL_PATH_OUTSIDE_ROOT','Response journal parent resolves outside its allowed root');break;}
      catch(error){if(error.code!=='ENOENT')throw error;const parent=path.dirname(ancestor);if(parent===ancestor)throw error;ancestor=parent;}
    }
    if(create)await fs.mkdir(requested,{recursive:true,mode:0o700});
    let resolved;
    try{resolved=await fs.realpath(requested);}catch(error){if(error.code==='ENOENT'&&!create)return null;throw error;}
    if(!within(root,resolved))throw fail('JOURNAL_PATH_OUTSIDE_ROOT','Response journal directory resolves outside its allowed root');
    if(!(await fs.stat(resolved)).isDirectory())throw fail('JOURNAL_INVALID_FILE','Response journal location is not a directory');
    return resolved;
  }
  async function syncDirectory(directoryPath){
    let handle;
    try{handle=await fs.open(directoryPath,'r');await handle.sync();}
    catch(error){
      // Windows does not expose directory fsync through the Node file API.
      // The response file itself is always synced before its atomic rename.
      if(process.platform!=='win32'||!['EPERM','EACCES','EISDIR','EINVAL','ENOTSUP'].includes(error.code))throw error;
    }finally{if(handle)await handle.close();}
  }
  async function readAt(directoryPath,attemptId){
    const file=path.join(directoryPath,`${attemptId}.json`);
    let stat;
    try{stat=await fs.lstat(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw fail('JOURNAL_INVALID_FILE','Response journal entry must be an ordinary unlinked file');
    let record;
    try{record=JSON.parse(await fs.readFile(file,'utf8'));}catch(error){throw fail('JOURNAL_CORRUPT',`Response journal is not valid JSON: ${error.message}`);}
    if(record?.schemaVersion!==1||record.binding?.attemptId!==attemptId||record.digest!==receiptDigest(record.binding,record.trace))throw fail('JOURNAL_CORRUPT','Response journal digest or filename binding is invalid');
    verifyTrace(record.binding,record.trace);
    return{...record,...descriptor(record,file)};
  }
  async function lock(directoryPath,attemptId){
    const file=path.join(directoryPath,`.${attemptId}.lock`);
    for(let attempt=0;attempt<100;attempt++){
      try{return{file,handle:await fs.open(file,'wx',0o600)};}
      catch(error){if(error.code!=='EEXIST')throw error;if(attempt===99)throw fail('JOURNAL_BUSY','Response journal attempt is locked; preserve the response and recover it explicitly');await new Promise(resolve=>setTimeout(resolve,10));}
    }
  }
  async function release(held){await held.handle.close();await fs.unlink(held.file);}

  async function persistResponse(task,trace){
    const binding={taskId:checkId(task?.id,'task identifier'),runId:checkId(task?.runId,'run identifier'),attemptId:checkId(task?.attemptId,'attempt identifier'),...(task.stage===undefined?{}:{stage:task.stage})};
    verifyTrace(binding,trace);
    const normalized=JSON.parse(JSON.stringify(trace));
    if(digest(normalized)!==digest(trace))throw fail('JOURNAL_NON_JSON_TRACE','Response journal trace contains values that cannot be preserved as JSON');
    const payload={schemaVersion:1,binding,trace:normalized},record={...payload,digest:receiptDigest(binding,normalized)};
    const directoryPath=await prepare(true),file=path.join(directoryPath,`${binding.attemptId}.json`);
    const identical=existing=>{if(existing.digest!==record.digest)throw fail('JOURNAL_CONFLICT','Response journal already contains a different answer for this attempt');return descriptor(existing,file);};
    const existing=await readAt(directoryPath,binding.attemptId);if(existing)return identical(existing);
    const held=await lock(directoryPath,binding.attemptId);
    let temporaryPath,handle;
    try{
      const previous=await readAt(directoryPath,binding.attemptId);if(previous)return identical(previous);
      temporaryPath=path.join(directoryPath,`.${binding.attemptId}.${randomUUID()}.tmp`);
      handle=await fs.open(temporaryPath,'wx',0o600);
      await handle.writeFile(canonical(record),'utf8');await handle.sync();await handle.close();handle=null;
      await fs.rename(temporaryPath,file);temporaryPath=null;
      await syncDirectory(directoryPath);
      return descriptor(record,file);
    }catch(error){
      // An interrupted complete temporary file can still contain the only
      // received answer. Retain it for explicit recovery rather than rerolling.
      if(temporaryPath)error.journalTempPath=temporaryPath;
      throw error;
    }finally{if(handle)await handle.close();await release(held);}
  }
  async function read(attemptId){checkId(attemptId,'attempt identifier');const directoryPath=await prepare();return directoryPath?readAt(directoryPath,attemptId):null;}
  async function list(runId){
    if(runId!==undefined)checkId(runId,'run identifier');
    const directoryPath=await prepare();if(!directoryPath)return[];
    const names=(await fs.readdir(directoryPath)).sort();
    if(names.some(name=>name.endsWith('.tmp')||name.endsWith('.lock')))throw fail('JOURNAL_INTERRUPTED','Response journal contains an interrupted or active write; inspect and recover its evidence before resuming model requests');
    const entries=[];
    for(const name of names){
      if(!name.endsWith('.json'))continue;
      const attemptId=checkId(name.slice(0,-5),'attempt filename'),entry=await readAt(directoryPath,attemptId);
      if(entry&&(runId===undefined||entry.runId===runId))entries.push(entry);
    }
    return entries;
  }
  async function clear(attemptId,{remoteCommitted=false,expectedDigest}={}){
    checkId(attemptId,'attempt identifier');
    if(remoteCommitted!==true||typeof expectedDigest!=='string'||!/^[a-f0-9]{64}$/.test(expectedDigest))throw fail('JOURNAL_COMMIT_REQUIRED','Response journal removal requires a confirmed remote commit and the expected journal digest');
    const directoryPath=await prepare();if(!directoryPath)return false;
    const held=await lock(directoryPath,attemptId);
    try{const entry=await readAt(directoryPath,attemptId);if(!entry)return false;if(entry.digest!==expectedDigest)throw fail('JOURNAL_CONFLICT','Response journal changed before removal');await fs.unlink(entry.path);await syncDirectory(directoryPath);return true;}
    finally{await release(held);}
  }
  const remove=(entry,options)=>clear(typeof entry==='string'?entry:entry?.attemptId??entry?.binding?.attemptId,options);
  return{directory:requested,persistResponse,read,list,clear,remove};
}
export const responseJournal=createResponseJournal();
export const persistResponse=(task,trace)=>responseJournal.persistResponse(task,trace);
export default responseJournal;
