import {randomUUID} from 'node:crypto';
import {repository} from '../db/repository.mjs';
import {generateDataset,validateDataset} from '../domain/dataset.mjs';
import {digest,POLICY,INITIAL_PROMPT} from '../domain/policy.mjs';
import {putJSON,getJSON} from '../oracle/storage.mjs';
export async function seedVersions(){
  const policies=await repository.docs('POLICY');if(!policies.some(p=>p.version===POLICY.version))await repository.saveDoc({id:digest(POLICY),kind:'POLICY',version:POLICY.version,value:{policy:POLICY}});
  const prompts=await repository.docs('PROMPT');if(!prompts.length)await repository.saveDoc({id:digest({text:INITIAL_PROMPT}),kind:'PROMPT',version:'prompt-v1',value:{text:INITIAL_PROMPT,generated:false,policyVersion:POLICY.version}});
}
export async function importDataset(dataset){
  const valid=validateDataset(dataset);if(!valid.valid)throw new Error(valid.errors.join('; '));
  const id=digest(dataset),existing=await repository.doc(id);if(existing)return existing;
  const artifact=await putJSON('datasets',id,dataset);await getJSON(artifact);
  try{await repository.saveDoc({id,kind:'DATASET',version:dataset.version,value:{dataset,artifact,labelDigest:digest(dataset.cases.map(c=>({id:c.id,expected:c.expected})))}});}catch(error){error.message=`Dataset object uploaded but database import failed; orphan artifact ${artifact.key}: ${error.message}`;throw error;}
  return repository.doc(id);
}
export const generateAndImport=options=>importDataset(generateDataset(options));
export async function datasetById(id){const d=await repository.doc(id);if(!d||d.kind!=='DATASET')throw new Error('Dataset version not found');return d;}
export async function approveEvidence({targetId,type,approved,reason,actor,sourceId}){
  if(!['labels','calibration','release'].includes(type)||typeof approved!=='boolean'||!reason?.trim()||!sourceId?.trim())throw new Error('Evidence requires type, approved flag, rationale and a supporting evidence reference');
  let targetDigest;
  if(type==='labels'){const d=await datasetById(targetId);targetDigest=d.labelDigest;}
  else {const r=await repository.run(targetId);if(!r)throw new Error('Run not found');const m=await repository.doc(r.manifestId);targetDigest=m.digest;}
  return repository.saveDoc({kind:'EVIDENCE',parentId:targetId,value:{type,approved,reason,actor,sourceId,targetDigest,approvalId:randomUUID()}});
}
