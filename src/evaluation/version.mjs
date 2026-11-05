import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {digest} from '../domain/policy.mjs';

export const PROMPTFOO_VERSION='0.125.1';
const main=createRequire(import.meta.url).resolve('promptfoo');
const installed=JSON.parse(fs.readFileSync(path.resolve(path.dirname(main),'../../package.json'),'utf8')).version;
if(installed!==PROMPTFOO_VERSION)throw new Error(`Install pinned Promptfoo ${PROMPTFOO_VERSION}; found ${installed}`);
const files=['adapter.mjs','provider.mjs','assertions.mjs','findings.mjs','runtime.mjs','task.mjs','version.mjs'];
const adapterDigest=digest(Object.fromEntries(files.map(file=>[file,fs.readFileSync(new URL(file,import.meta.url),'utf8').replace(/\r\n/g,'\n')])));
const identity=Object.freeze({name:'promptfoo',version:PROMPTFOO_VERSION,adapterVersion:'oci-durable-v2',adapterDigest,
  evaluatorVersion:'invoice-promptfoo-v2',cache:false,providerRetries:0,implicitGraders:false,repeatPerTask:1});
export const runnerIdentity=()=>({...identity});
export function assertFrozenRunner(snapshot){
  if(digest(snapshot.runner||null)!==digest(identity))throw Object.assign(new Error('Frozen Promptfoo runner or adapter differs; create a new run instead of mixing evidence.'),{code:'RUNNER_VERSION_MISMATCH'});
}
