import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Set once, before loading Promptfoo. Never inherit a user's Promptfoo cloud
// configuration, graders, telemetry, or disk cache in the backend worker.
let runtime;
export function loadPromptfoo(){
  if(runtime)return runtime;
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'aie-promptfoo-'));
  fs.writeFileSync(path.join(directory,'promptfoo.yaml'),'id: local-invoice-evaluator\n');
  Object.assign(process.env,{
  PROMPTFOO_CONFIG_DIR:directory,
  PROMPTFOO_DISABLE_TELEMETRY:'1',PROMPTFOO_DISABLE_UPDATE:'1',
  PROMPTFOO_CACHE_ENABLED:'false',PROMPTFOO_DISABLE_REMOTE_GENERATION:'true',
  PROMPTFOO_DISABLE_TEMPLATE_ENV_VARS:'true',PROMPTFOO_DISABLE_TEMPLATING:'true',
  PROMPTFOO_TRACING_ENABLED:'false',
  });
  return runtime=import('promptfoo');
}

// Repetition, parallelism, timeouts and retry budgets belong to durable tasks.
export const EVALUATE_OPTIONS=Object.freeze({cache:false,repeat:1,maxConcurrency:1,
  showProgressBar:false,silent:true,generateSuggestions:false,delay:0,timeoutMs:0,maxEvalTimeMs:0});
