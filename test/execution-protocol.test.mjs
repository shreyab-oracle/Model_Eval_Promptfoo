import test from 'node:test';
import assert from 'node:assert/strict';
import {EXECUTION_PROTOCOL_VERSION,assertExecutionProtocol} from '../src/services/execution-protocol.mjs';

test('execution accepts only the frozen durable received protocol',()=>{
  assert.equal(EXECUTION_PROTOCOL_VERSION,'durable-received-v1');
  assert.doesNotThrow(()=>assertExecutionProtocol({executionProtocolVersion:EXECUTION_PROTOCOL_VERSION}));
  for(const executionProtocolVersion of ['older-protocol','',null,1]){
    assert.throws(()=>assertExecutionProtocol({executionProtocolVersion}),{code:'EXECUTION_PROTOCOL_MISMATCH'});
  }
});

test('unversioned snapshots cannot execute',()=>{
  for(const snapshot of [{},undefined,null]){
    assert.throws(()=>assertExecutionProtocol(snapshot),{code:'EXECUTION_PROTOCOL_MISMATCH'});
  }
});

test('execution validation preserves frozen evaluation identity and inputs',()=>{
  const snapshot=Object.freeze({executionProtocolVersion:EXECUTION_PROTOCOL_VERSION,engineDigest:'frozen-business-engine',prompt:'unchanged',policy:Object.freeze({version:'unchanged'})});
  const before=JSON.stringify(snapshot);
  assert.doesNotThrow(()=>assertExecutionProtocol(snapshot));
  assert.equal(JSON.stringify(snapshot),before);
});
