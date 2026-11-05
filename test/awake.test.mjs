import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
const awake=await import('../src/services/awake.mjs').catch(()=>({}));

test('active work holds one Windows sleep request and releases it when work stops',async()=>{
  assert.equal(typeof awake.createAwakeGuard,'function');
  let launches=0,released=0;
  const guard=awake.createAwakeGuard({platform:'win32',spawnProcess:()=>{
    launches++;const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin.on('finish',()=>{released++;child.emit('close',0);});return child;
  },onError:error=>{throw error;}});
  guard.setActive(true);guard.setActive(true);assert.equal(launches,1);
  guard.setActive(false);await new Promise(resolve=>setImmediate(resolve));assert.equal(released,1);
  guard.setActive(false);assert.equal(released,1);
  guard.setActive(true);assert.equal(launches,2);guard.setActive(false);
});

test('non-Windows workers do not launch a sleep-prevention helper',()=>{
  assert.equal(typeof awake.createAwakeGuard,'function');let launches=0;
  const guard=awake.createAwakeGuard({platform:'linux',spawnProcess:()=>{launches++;}});
  guard.setActive(true);guard.setActive(false);assert.equal(launches,0);
});
