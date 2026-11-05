import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {publicConfig} from '../src/config.mjs';
import * as runs from '../src/services/runs.mjs';

test('company OCI access has no billing flags or acknowledgement requirements',()=>{
  assert.equal(runs.requirePaid,undefined);
  assert.equal(runs.startRun.length,1);
  assert.equal(runs.resumeRun.length,1);
  assert.equal(publicConfig().paidMode,undefined);
  for(const file of ['src/services/worker.mjs','src/http/routes.mjs','scripts/cli.mjs','src/http/operations.mjs','frontend/operations.mjs','frontend/viewer-bootstrap.js']){
    assert.doesNotMatch(fs.readFileSync(file,'utf8'),/PAID_EVALUATIONS_ENABLED|acknowledgePaid|paidEnabled|PaidAck|--paid/);
  }
});
