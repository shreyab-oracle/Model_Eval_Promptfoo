// This project's evidence is confined to its own folder in the existing bucket.
export const PROJECT_STORAGE_PREFIX='ai-model-evaluation-promptfoo/';
export function storagePrefix(prefix=PROJECT_STORAGE_PREFIX){
  if(typeof prefix!=='string'||!prefix)throw new Error('A dedicated Promptfoo storage prefix is required');
  const normalized=`${prefix.replace(/\/+$/,'')}/`;
  if(!normalized.startsWith(PROJECT_STORAGE_PREFIX)||normalized.slice(0,-1).split('/').some(part=>!/^[-a-zA-Z0-9_]+$/.test(part))){
    throw new Error(`Storage prefix must be ${PROJECT_STORAGE_PREFIX} or a folder beneath it`);
  }
  return normalized;
}

// The kind and identity remain readable; the full digest makes each write immutable.
export function artifactFileKey(prefix,kind,id,hash){
  if(typeof kind!=='string'||!/^[a-zA-Z0-9_-]+$/.test(kind)||typeof id!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id))throw new Error('Invalid artifact identity');
  if(typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash))throw new Error('Invalid artifact digest');
  return`${storagePrefix(prefix)}${kind}/${id}/${hash}.json`;
}
