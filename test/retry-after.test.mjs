import test from 'node:test';
import assert from 'node:assert/strict';
import {retryAfterMilliseconds} from '../src/oracle/auth.mjs';
test('server retry guidance accepts seconds and dates with a finite upper bound',()=>{
  const now=Date.parse('2026-11-02T15:00:00Z');
  assert.equal(retryAfterMilliseconds('45',now),45000);
  assert.equal(retryAfterMilliseconds('Mon, 02 Nov 2026 15:01:00 GMT',now),60000);
  assert.equal(retryAfterMilliseconds('9000',now),300000);
  assert.equal(retryAfterMilliseconds('Mon, 02 Nov 2026 14:59:00 GMT',now),0);
  for(const value of [undefined,'','invalid','-1'])assert.equal(retryAfterMilliseconds(value,now),undefined);
});
