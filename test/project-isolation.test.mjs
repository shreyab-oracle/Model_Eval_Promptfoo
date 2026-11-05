import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {eligibleWorkerRuns} from '../src/services/worker.mjs';

test('copied legacy environment cannot route this project to the React port or evidence prefix',()=>{
  const env={...process.env,PORT:'3001',UI_ORIGIN:'http://127.0.0.1:3001',OBJECT_STORAGE_PREFIX:'ai-model-evaluation/'};
  for(const key of ['PROMPTFOO_PORT','PROMPTFOO_UI_ORIGIN','PROMPTFOO_OBJECT_STORAGE_PREFIX'])delete env[key];
  const result=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',"import {config} from './src/config.mjs'; console.log(JSON.stringify({port:config.port,origin:config.uiOrigin,prefix:config.storage.prefix}))"],{env,encoding:'utf8',windowsHide:true}));
  assert.deepEqual(result,{port:3002,origin:'http://127.0.0.1:3002',prefix:'ai-model-evaluation-promptfoo/'});
});

test('a worker scope excludes unrelated jobs before reading their manifests',async()=>{
  const reads=[];
  await eligibleWorkerRuns([{id:'unrelated',manifestId:'foreign'}],{runIds:['acceptance-only'],loadManifest:async id=>{reads.push(id);return{};}});
  assert.deepEqual(reads,[]);
});
