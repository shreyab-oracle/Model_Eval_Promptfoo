import {config,required} from '../config.mjs';
import {ociRequest} from './auth.mjs';
import {validateModelSettings} from '../domain/model-settings.mjs';
export function chatBody({modelId,mode='ON_DEMAND',messages,settings=config.settings,compartmentId=config.compartment}){
  if(!modelId||!compartmentId)throw new Error('Model identifier and OCI compartment are required');
  if(!['ON_DEMAND','DEDICATED'].includes(mode))throw new Error('Unsupported serving mode');
  const {family,fixedTopK,...parameters}=validateModelSettings(settings);
  return{compartmentId,servingMode:mode==='ON_DEMAND'?{servingType:mode,modelId}:{servingType:mode,endpointId:modelId},chatRequest:{apiFormat:'GENERIC',isStream:false,messages:messages.map(m=>({role:m.role,content:[{type:'TEXT',text:m.content}]})),...parameters}};
}
export function parseChatResponse(raw,requestId){
  // OCI REST returns chatResponse directly; chatResult belongs to SDK wrappers.
  const response=raw?.chatResponse,choice=response?.choices?.[0];
  const failure=(message,code)=>Object.assign(new Error(message),{code,requestId,raw});
  if(choice?.finishReason&&/length|max_tokens|token_limit/i.test(choice.finishReason))throw failure(`OCI response truncated: ${choice.finishReason}`,'TRUNCATED_RESPONSE');
  const content=choice?.message?.content;
  const text=Array.isArray(content)?content.filter(c=>c.type==='TEXT'&&typeof c.text==='string').map(c=>c.text).join(''):'';
  if(!text.trim())throw failure('OCI returned no textual chat content','EMPTY_MODEL_RESPONSE');
  return{text,usage:response.usage||raw.usage||null,finishReason:choice.finishReason||null};
}
export async function chat(options){
  required('OCI_COMPARTMENT_ID');const started=performance.now();
  const result=await ociRequest('POST',`${options.endpoint||config.genaiEndpoint}/20231130/actions/chat`,{body:chatBody(options),timeoutMs:config.timeoutMs});
  return{...parseChatResponse(result.data,result.headers['opc-request-id']),raw:result.data,latencyMs:Math.round(performance.now()-started),requestId:result.headers['opc-request-id']};
}
export async function modelMetadata(modelId){const r=await ociRequest('GET',`https://generativeai.${config.genaiRegion}.oci.oraclecloud.com/20231130/models/${encodeURIComponent(modelId)}`);return r.data;}
