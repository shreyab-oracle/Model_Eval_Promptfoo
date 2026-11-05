import {config,publicConfig,safeError} from '../config.mjs';
import {withConnection,getDriver} from '../db/pool.mjs';
import {bucketStatus} from '../oracle/storage.mjs';
import {modelMetadata} from '../oracle/genai.mjs';
import {verifyOptimizer} from '../optimization/runner.mjs';
export async function connectionStatus(){
  const checks={database:()=>withConnection(async c=>{const r=await c.execute('SELECT 1 AS OK,USER AS SCHEMA_NAME FROM dual');return{schema:r.rows[0].SCHEMA_NAME,version:c.oracleServerVersionString,thin:getDriver().thin};},{readOnly:true}),objectStorage:bucketStatus,optimizer:verifyOptimizer,...Object.fromEntries(Object.entries(config.models).map(([role,id])=>[role,async()=>{if(!id)throw new Error(`${role} model is not configured`);const m=await modelMetadata(id);return{displayName:m.displayName,state:m.lifecycleState,version:m.version,inferenceVerified:false};}]))};
  const entries=await Promise.all(Object.entries(checks).map(async([name,fn])=>{const start=performance.now();try{const details=await fn();return[name,{ok:true,checkedAt:new Date().toISOString(),latencyMs:Math.round(performance.now()-start),details}];}catch(e){return[name,{ok:false,checkedAt:new Date().toISOString(),error:safeError(e)}];}}));
  return{checks:Object.fromEntries(entries),configuration:publicConfig(),devops:{configured:false,message:'Existing OCI DevOps project and hosting target have not been supplied; no infrastructure was provisioned.'}};
}
