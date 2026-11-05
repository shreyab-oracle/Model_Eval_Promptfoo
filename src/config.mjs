import fs from 'node:fs';
import path from 'node:path';
if(fs.existsSync('.env.local'))process.loadEnvFile('.env.local');
const env=process.env;
export function required(name){if(!env[name])throw Object.assign(new Error(`Missing backend configuration: ${name}`),{code:'CONFIG_MISSING'});return env[name];}
export const config={
  host:'127.0.0.1',port:Number(env.PROMPTFOO_PORT||3002),uiOrigin:env.PROMPTFOO_UI_ORIGIN||`http://127.0.0.1:${Number(env.PROMPTFOO_PORT||3002)}`,
  ociConfig:path.resolve(env.OCI_CONFIG_FILE||'.local/oci-config'),profile:env.OCI_PROFILE||'DEFAULT',
  compartment:env.OCI_COMPARTMENT_ID,genaiEndpoint:env.GENAI_ENDPOINT||'https://inference.generativeai.us-chicago-1.oci.oraclecloud.com',genaiRegion:env.GENAI_REGION||'us-chicago-1',
  models:{baseline:env.BASELINE_MODEL_ID,candidate:env.CANDIDATE_MODEL_ID,judge:env.JUDGE_MODEL_ID},
  modelNames:{baseline:env.BASELINE_MODEL_NAME||'Current model',candidate:env.CANDIDATE_MODEL_NAME||'New model',judge:env.JUDGE_MODEL_NAME||'AI reviewer'},
  modes:{baseline:env.BASELINE_SERVING_MODE||'ON_DEMAND',candidate:env.CANDIDATE_SERVING_MODE||'ON_DEMAND',judge:env.JUDGE_SERVING_MODE||'ON_DEMAND'},
  settings:{maxCompletionTokens:Number(env.GENAI_MAX_COMPLETION_TOKENS||2048),verbosity:env.GENAI_VERBOSITY||'MEDIUM'},
  geminiSettings:{maxTokens:Number(env.GEMINI_MAX_TOKENS||6000),temperature:Number(env.GEMINI_TEMPERATURE||1),frequencyPenalty:Number(env.GEMINI_FREQUENCY_PENALTY||0),presencePenalty:Number(env.GEMINI_PRESENCE_PENALTY||0),topP:Number(env.GEMINI_TOP_P||0.95),fixedTopK:64},
  timeoutMs:Number(env.GENAI_TIMEOUT_MS||180000),concurrency:Math.min(4,Math.max(1,Number(env.WORKER_CONCURRENCY||2))),leaseSeconds:240,
  storage:{region:env.OBJECT_STORAGE_REGION,namespace:env.OBJECT_STORAGE_NAMESPACE,bucket:env.OBJECT_STORAGE_BUCKET,prefix:env.PROMPTFOO_OBJECT_STORAGE_PREFIX||'ai-model-evaluation-promptfoo/'},
  reviewer:env.LOCAL_REVIEWER||'local-operator (unauthenticated)',
};
export function safeError(error){
  let message=String(error?.message||error);
  for(const name of ['DB_PASSWORD','DB_WALLET_PASSWORD','LOCAL_API_TOKEN','OCI_KEY_PASSPHRASE'])if(env[name])message=message.replaceAll(env[name],'[REDACTED]');
  message=message.replace(/(authorization["'\s:=]+)[^\r\n]+/ig,'$1[REDACTED]');
  return{code:error?.code||'ERROR',message,statusCode:error?.statusCode,requestId:error?.requestId,retryAfterMs:error?.retryAfterMs};
}
export function publicConfig(){return{models:config.models,modelNames:config.modelNames,modes:config.modes,settings:config.settings,genaiRegion:config.genaiRegion,database:{tablePrefix:'AIEP_'},storage:{region:config.storage.region,bucket:config.storage.bucket,prefix:config.storage.prefix},modelAccess:'Company OCI',reviewer:config.reviewer,identityMode:'Local loopback operator; production identity gateway not configured'};}
