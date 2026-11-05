import {config,safeError} from '../config.mjs';
import {canonical,digest} from '../domain/policy.mjs';
import {artifactFileKey,storagePrefix} from '../domain/file-names.mjs';
import {ociRequest} from './auth.mjs';

export function createStorage({storage=config.storage,request=ociRequest}={}){
  const prefix=storagePrefix(storage.prefix);
  const bucketURL=()=>{
    if(!storage.region||!storage.namespace||!storage.bucket)throw new Error('Object Storage region, namespace and existing bucket are required');
    return`https://objectstorage.${storage.region}.oraclecloud.com/n/${encodeURIComponent(storage.namespace)}/b/${encodeURIComponent(storage.bucket)}`;
  };
  const checkKey=key=>{
    if(typeof key!=='string'||!key.startsWith(prefix)||key.split('/').some(part=>!/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(part))){
      throw new Error('Artifact outside configured Promptfoo application prefix');
    }
  };
  const read=async key=>{
    checkKey(key);
    for(let attempt=0;attempt<2;attempt++){
      try{return await request('GET',`${bucketURL()}/o/${encodeURIComponent(key)}`);}
      catch(error){
        const transient=['ECONNRESET','ECONNABORTED','ETIMEDOUT','EAI_AGAIN'].includes(error.code)||[408,429,500,502,503,504].includes(error.statusCode);
        if(attempt||!transient)throw error;
        console.error(JSON.stringify({event:'artifact-read-retry',attempt:attempt+1,error:safeError(error)}));
        await new Promise(resolve=>setTimeout(resolve,500));
      }
    }
  };
  const verify=(value,hash,key)=>{if(digest(value)!==hash)throw Object.assign(new Error(`Object digest mismatch: ${key}`),{code:'ARTIFACT_DIGEST_MISMATCH'});return value;};
  async function getJSON(artifact){
    if(!artifact?.key||!artifact.digest)throw new Error('Artifact key and digest are required');
    return verify((await read(artifact.key)).data,artifact.digest,artifact.key);
  }
  async function putJSON(kind,id,value){
    const hash=digest(value),key=artifactFileKey(prefix,kind,id,hash);
    const response=await request('PUT',`${bucketURL()}/o/${encodeURIComponent(key)}`,{body:canonical(value),headers:{'if-none-match':'*'}}).catch(async error=>{
      if(error.statusCode!==412)throw error;
      verify((await read(key)).data,hash,key);return{headers:{etag:null}};
    });
    return{...storage,prefix,key,digest:hash,etag:response.headers.etag||null};
  }
  async function bucketStatus(){const r=await request('GET',bucketURL());return{name:r.data.name,region:storage.region,versioning:r.data.versioning,publicAccessType:r.data.publicAccessType};}
  return{putJSON,getJSON,bucketStatus};
}
export const {putJSON,getJSON,bucketStatus}=createStorage();
