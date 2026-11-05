import {createRequire} from 'node:module';
import path from 'node:path';
import {required,safeError} from '../config.mjs';
const require=createRequire(import.meta.url);let driver,pool;
export function getDriver(){if(driver)return driver;driver=require('oracledb');driver.fetchAsString=[driver.CLOB];driver.outFormat=driver.OUT_FORMAT_OBJECT;driver.fetchArraySize=500;return driver;}
async function getPool(){
  // Fixed capacity avoids dynamic expansion while leaving a connection for
  // heartbeats and short reads when another operation is awaiting Oracle.
  if(!pool){const d=getDriver(),creating=d.createPool({user:required('DB_USER'),password:required('DB_PASSWORD'),connectString:required('DB_CONNECT_STRING'),configDir:path.resolve(required('DB_WALLET_DIR')),walletLocation:path.resolve(required('DB_WALLET_DIR')),walletPassword:required('DB_WALLET_PASSWORD'),poolMin:2,poolMax:2,poolIncrement:1,queueTimeout:20000,connectTimeout:20,retryCount:0,poolPingInterval:30,poolPingTimeout:5000});pool=creating;creating.catch(()=>{if(pool===creating)pool=undefined;});}
  return pool;
}
function connectionInterrupted(error){return error?.isRecoverable===true||['NJS-040','NJS-500','NJS-501','NJS-503','NJS-510','DB_OPERATION_TIMEOUT','ECONNRESET','ECONNABORTED','ENETUNREACH','EHOSTUNREACH','ETIMEDOUT','EAI_AGAIN'].includes(error?.code);}
async function deadline(work,ms,onTimeout){
  let timer;
  try{return await Promise.race([Promise.resolve().then(work),new Promise((_,reject)=>{timer=setTimeout(()=>{onTimeout?.();reject(Object.assign(new Error(`Database operation exceeded ${ms} ms; its commit outcome must be checked before retrying a write`),{code:'DB_OPERATION_TIMEOUT'}));},ms);})]);}
  finally{clearTimeout(timer);}
}
export async function withConnection(fn,{readOnly=false,operationTimeoutMs=60000,cleanupTimeoutMs=10000}={}){
  for(let attempt=0;attempt<2;attempt++){
    let c,started=false,result,error,drop=false;
    try{c=await(await getPool()).getConnection();c.callTimeout=20000;started=true;result=await deadline(()=>fn(c),operationTimeoutMs,()=>{drop=true;Promise.resolve().then(()=>c.break?.()).catch(()=>{});});}
    catch(e){error=e;drop ||= connectionInterrupted(error);if(c&&!drop)await deadline(()=>c.rollback(),cleanupTimeoutMs).catch(()=>{drop=true;});}
    finally{if(c)try{await deadline(()=>drop?c.close({drop:true}):c.close(),cleanupTimeoutMs);}catch(e){error ||= e;const stale=pool;pool=undefined;if(stale)Promise.resolve(stale).then(p=>p.close(0)).catch(()=>{});}}
    if(!error)return result;
    // Acquiring a connection and explicitly read-only work are safe to replay.
    // A write or commit may already have succeeded: return its real error.
    if(attempt===1||!connectionInterrupted(error)||(started&&!readOnly))throw error;
    console.error(JSON.stringify({at:new Date().toISOString(),event:'database-retry',operation:started?'read':'connect',attempt:attempt+1,error:safeError(error)}));
    await new Promise(resolve=>setTimeout(resolve,500));
  }
}
export async function closePool(){if(pool){const p=await pool;pool=undefined;await p.close(5);}}
