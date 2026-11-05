import test from 'node:test';
import assert from 'node:assert/strict';
import {canonical,digest} from '../src/domain/policy.mjs';
import {artifactFileKey,PROJECT_STORAGE_PREFIX,storagePrefix} from '../src/domain/file-names.mjs';
import {createStorage} from '../src/oracle/storage.mjs';

// Replace only HTTP. New storage writes and reads never need a database name map.
function fixture(prefix=PROJECT_STORAGE_PREFIX){
  const storage={region:'ap-hyderabad-1',namespace:'example',bucket:'existing',prefix};
  const objects=new Map(),requests=[];
  const request=async(method,url,options={})=>{
    const u=new URL(url),key=decodeURIComponent(u.pathname.split('/o/')[1]||'');requests.push({method,key,...options});
    if(method==='GET'){
      if(!objects.has(key))throw Object.assign(new Error('Missing object'),{statusCode:404});
      return{data:structuredClone(objects.get(key)),headers:{etag:'source-etag'}};
    }
    if(method==='PUT'){
      assert.equal(options.headers['if-none-match'],'*');
      if(objects.has(key))throw Object.assign(new Error('Already exists'),{statusCode:412});
      objects.set(key,JSON.parse(options.body));return{headers:{etag:'written-etag'}};
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };
  const locations={find:async()=>assert.fail('No database name lookup'),reserve:async()=>assert.fail('No database name reservation')};
  return{api:createStorage({storage,request,locations}),objects,requests};
}

test('project prefix is compulsory and cannot target earlier application folders',()=>{
  assert.equal(storagePrefix(),PROJECT_STORAGE_PREFIX);
  assert.equal(storagePrefix('ai-model-evaluation-promptfoo'),PROJECT_STORAGE_PREFIX);
  assert.equal(storagePrefix(`${PROJECT_STORAGE_PREFIX}development`),`${PROJECT_STORAGE_PREFIX}development/`);
  for(const prefix of ['', '/', 'ai-model-evaluation/', 'ai-model-evaluation-promptfoo-other/', '../ai-model-evaluation-promptfoo/', `${PROJECT_STORAGE_PREFIX}../`, `${PROJECT_STORAGE_PREFIX}old/../../`, `${PROJECT_STORAGE_PREFIX}a\\b/`, `${PROJECT_STORAGE_PREFIX}%2e%2e/`])assert.throws(()=>fixture(prefix),/prefix/i,prefix);
});

test('new artifacts use their kind, identity and full content digest without database rows',async()=>{
  const f=fixture(),data={kind:'release',version:'release-v1',cases:[{}]},hash=digest(data);
  const a=await f.api.putJSON('datasets','release-v1',data),b=await f.api.putJSON('datasets','release-v1',data);
  assert.equal(a.key,`${PROJECT_STORAGE_PREFIX}datasets/release-v1/${hash}.json`);assert.equal(b.key,a.key);
  assert.equal(a.digest,hash);assert.deepEqual(await f.api.getJSON(a),data);assert.equal(f.objects.size,1);
  assert.equal(f.requests[0].body,canonical(data));assert.equal(a.etag,'written-etag');assert.equal(b.etag,null);
});

test('diagnostics remain readable with the same deterministic key convention',async()=>{
  const f=fixture(),value={connected:true},artifact=await f.api.putJSON('_verification','connection-check',value);
  assert.deepEqual(await f.api.getJSON(artifact),value);
});

test('writes preserve every previous object and expose no relocation operations',async()=>{
  const f=fixture(),oldKey='ai-model-evaluation/model-conversations/conversation-1.json',oldValue={previous:'evidence'};
  f.objects.set(oldKey,oldValue);
  const a=await f.api.putJSON('traces','attempt-one',{answer:1}),b=await f.api.putJSON('traces','attempt-one',{answer:2});
  assert.notEqual(a.key,b.key);assert.equal(f.objects.size,3);assert.deepEqual(f.objects.get(oldKey),oldValue);
  assert.ok(f.requests.every(r=>r.method==='PUT'));
  assert.equal(f.api.renameLegacyObject,undefined);assert.equal(f.api.listLegacyObjects,undefined);
});

test('occupied immutable destinations are verified and never overwritten',async()=>{
  const f=fixture(),data={correct:true},hash=digest(data),key=artifactFileKey(PROJECT_STORAGE_PREFIX,'traces','attempt',hash);
  f.objects.set(key,{correct:false});
  await assert.rejects(()=>f.api.putJSON('traces','attempt',data),e=>e.code==='ARTIFACT_DIGEST_MISMATCH');
  assert.deepEqual(f.objects.get(key),{correct:false});assert.deepEqual(f.requests.map(r=>r.method),['PUT','GET']);
});

test('artifact reads are bound to the exact project prefix before any request',async()=>{
  const f=fixture(`${PROJECT_STORAGE_PREFIX}development/`),hash=digest({});
  for(const key of ['ai-model-evaluation/traces/old.json',`${PROJECT_STORAGE_PREFIX}traces/other-environment.json`,`${PROJECT_STORAGE_PREFIX}development-other/file.json`,`${PROJECT_STORAGE_PREFIX}development/../file.json`,`${PROJECT_STORAGE_PREFIX}development/%2e%2e/file.json`,`${PROJECT_STORAGE_PREFIX}development/a\\b.json`])await assert.rejects(()=>f.api.getJSON({key,digest:hash}),/outside/i,key);
  assert.equal(f.requests.length,0);
});

test('artifact identities cannot introduce path traversal or encoded separators',async()=>{
  const f=fixture();
  for(const id of ['', '.', '..', '../previous', 'a/b', 'a\\b', '%2fprevious', 'line\nbreak'])await assert.rejects(()=>f.api.putJSON('traces',id,{}),/identity/i,id);
  for(const kind of ['', '../previous','a/b'])await assert.rejects(()=>f.api.putJSON(kind,'valid',{}),/identity/i);
  assert.equal(f.requests.length,0);
});

test('missing or corrupt artifacts fail without a database fallback',async()=>{
  const f=fixture(),data={correct:true},hash=digest(data),key=`${PROJECT_STORAGE_PREFIX}traces/old.json`;
  await assert.rejects(()=>f.api.getJSON({key,digest:hash}),e=>e.statusCode===404);
  f.objects.set(key,{correct:false});
  await assert.rejects(()=>f.api.getJSON({key,digest:hash}),e=>e.code==='ARTIFACT_DIGEST_MISMATCH');
});
