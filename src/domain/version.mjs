import fs from 'node:fs';
import {digest} from './policy.mjs';
import {runnerIdentity,assertFrozenRunner} from '../evaluation/version.mjs';
import {REVIEW_POLICY_VERSION} from './judge.mjs';
const rules=['policy.mjs','checks.mjs','judge.mjs','decision.mjs'];
const files=[...rules,'../oracle/genai.mjs','model-settings.mjs','../services/model-answer.mjs','../services/task-policy.mjs','../services/execution-protocol.mjs'];
export const ENGINE_DIGEST=digest({files:Object.fromEntries(files.map(file=>[file,fs.readFileSync(new URL(file,import.meta.url),'utf8').replace(/\r\n/g,'\n')])),runner:runnerIdentity()});
export function assertFrozenEngine(snapshot){
  if(snapshot.engineDigest!==ENGINE_DIGEST)throw Object.assign(new Error('Frozen evaluation engine differs from this application version. Create a new run; do not mix evaluator versions during resume.'),{code:'ENGINE_VERSION_MISMATCH'});
  if(snapshot.reviewPolicyVersion!==undefined&&snapshot.reviewPolicyVersion!==REVIEW_POLICY_VERSION)throw new Error('Frozen review policy differs; create a new run');
  if(!Array.isArray(snapshot.judgeTemplates)||snapshot.judgeTemplates.length!==2||digest(snapshot.judgeTemplates)!==snapshot.judgeTemplateDigest)throw new Error('Frozen judge instructions are missing or corrupt');
  if(snapshot.schemaVersion>=4||snapshot.runner)assertFrozenRunner(snapshot);
}
