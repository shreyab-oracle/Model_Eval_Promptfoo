import test from 'node:test';
import assert from 'node:assert/strict';
import {createStorage} from '../src/oracle/storage.mjs';
import {digest} from '../src/domain/policy.mjs';

const storage={region:'ap-hyderabad-1',namespace:'unit',bucket:'unit',prefix:'ai-model-evaluation-promptfoo/'};
const value={evidence:'unaltered'},artifact={key:'ai-model-evaluation-promptfoo/traces/unit/evidence.json',digest:digest(value)};
const locations={find:async()=>null};
test('a safe artifact read retries one reset and verifies the original content',async()=>{
  let calls=0;
  const api=createStorage({storage,locations,request:async method=>{assert.equal(method,'GET');if(++calls===1)throw Object.assign(new Error('read ECONNRESET'),{code:'ECONNRESET'});return{data:value,headers:{}};}});
  assert.deepEqual(await api.getJSON(artifact),value);assert.equal(calls,2);
});
test('an ongoing storage outage stops after two reads and preserves the actual error',async()=>{
  let calls=0;const error=Object.assign(new Error('read ECONNRESET'),{code:'ECONNRESET'});
  const api=createStorage({storage,locations,request:async()=>{calls++;throw error;}});
  await assert.rejects(()=>api.getJSON(artifact),e=>e===error);assert.equal(calls,2);
});
test('missing, denied and corrupt artifacts are not converted into successful evidence',async()=>{
  for(const statusCode of [403,404]){let calls=0;const error=Object.assign(new Error('Storage refused read'),{statusCode});const api=createStorage({storage,locations,request:async()=>{calls++;throw error;}});await assert.rejects(()=>api.getJSON(artifact),e=>e===error);assert.equal(calls,1);}
  let calls=0;const api=createStorage({storage,locations,request:async()=>{calls++;return{data:{altered:true},headers:{}};}});
  await assert.rejects(()=>api.getJSON(artifact),e=>e.code==='ARTIFACT_DIGEST_MISMATCH');assert.equal(calls,1);
});
test('an uncertain storage write is not automatically replayed by read recovery',async()=>{
  let calls=0;const error=Object.assign(new Error('write ECONNRESET'),{code:'ECONNRESET'});
  const api=createStorage({storage,locations:{...locations,reserve:async(sourceKey,contentDigest)=>({sourceKey,contentDigest,key:artifact.key})},request:async method=>{assert.equal(method,'PUT');calls++;throw error;}});
  await assert.rejects(()=>api.putJSON('traces','unit',value),e=>e===error);assert.equal(calls,1);
});
