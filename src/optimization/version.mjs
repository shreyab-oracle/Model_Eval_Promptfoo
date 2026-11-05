import fs from 'node:fs';
import {digest} from '../domain/policy.mjs';
import {PROMPTFOO_VERSION} from '../evaluation/version.mjs';
import {config} from '../config.mjs';

export const OPTIMIZER_NAME='Promptfoo';
export const OPTIMIZER_VERSION=PROMPTFOO_VERSION;
export const OPTIMIZER_DIGEST=digest({version:OPTIMIZER_VERSION,files:Object.fromEntries(
  ['version.mjs','runner.mjs','promptfoo-provider.mjs','ledger.mjs','engine.mjs','../domain/optimization.mjs','../services/prompts.mjs']
    .map(file=>[file,fs.readFileSync(new URL(file,import.meta.url),'utf8').replace(/\r\n/g,'\n')]))});
export function assertOptimizer(snapshot){
  if(snapshot.optimizer?.name!==OPTIMIZER_NAME||snapshot.optimizer.version!==OPTIMIZER_VERSION||snapshot.optimizer.digest!==OPTIMIZER_DIGEST)
    throw new Error('Prompt optimizer integration changed; create a new optimization job rather than mixing implementations');
  if(snapshot.optimizer.requestTimeoutMs!==undefined&&snapshot.optimizer.requestTimeoutMs!==config.timeoutMs)
    throw new Error('Frozen optimization request timeout differs from the backend; restore its timeout or prepare a new job.');
}
