import test from 'node:test';
import assert from 'node:assert/strict';
import {chatBody} from '../src/oracle/genai.mjs';
import {safeError} from '../src/config.mjs';
import {canonical,digest} from '../src/domain/policy.mjs';
import {validateJudge} from '../src/domain/judge.mjs';
const adapter=await import('../src/oracle/genai.mjs');

test('saved OCI REST response shape parses without SDK nesting and preserves usage',()=>{
  const raw={modelId:'configured-id',modelVersion:'test-shape',chatResponse:{choices:[{finishReason:'stop',message:{content:[{type:'TEXT',text:'{"connected":true}'}]}}],usage:{promptTokens:20,completionTokens:8,totalTokens:28}}};
  assert.equal(typeof adapter.parseChatResponse,'function');
  const parsed=adapter.parseChatResponse(raw,'request-id');assert.equal(parsed.text,'{"connected":true}');assert.equal(parsed.usage.totalTokens,28);
});
test('empty or truncated OCI replies retain the raw response and request identifier',()=>{
  for(const [finishReason,content,code] of [['length',[{type:'TEXT',text:'partial'}],'TRUNCATED_RESPONSE'],['stop',[],'EMPTY_MODEL_RESPONSE']]){
    const raw={chatResponse:{choices:[{finishReason,message:{content}}]}};
    assert.throws(()=>adapter.parseChatResponse(raw,'req'),e=>e.code===code&&e.raw===raw&&e.requestId==='req');
  }
});
test('OCI wire contract uses configured model IDs and generic chat messages',()=>{
  const b=chatBody({modelId:'configured-id',compartmentId:'configured-compartment',messages:[{role:'SYSTEM',content:'policy'}],settings:{maxCompletionTokens:2048,verbosity:'MEDIUM'}});
  assert.equal(b.servingMode.modelId,'configured-id');assert.equal(b.chatRequest.maxCompletionTokens,2048);assert.deepEqual(b.chatRequest.messages[0].content,[{type:'TEXT',text:'policy'}]);assert.ok(!('temperature'in b.chatRequest));
});
test('artifact hashes are stable across object key order',()=>{assert.equal(digest({a:1,b:2}),digest({b:2,a:1}));assert.equal(canonical({b:2,a:1}),'    {"a":1,"b":2}'.trim());});
test('provider errors redact configured passwords',()=>{process.env.DB_PASSWORD='TEST_SECRET_DO_NOT_PRINT';assert.ok(!safeError(new Error('bad TEST_SECRET_DO_NOT_PRINT')).message.includes('TEST_SECRET'));delete process.env.DB_PASSWORD;});
test('judge evidence must quote the tested output',()=>{
  const j={scores:{policy:3,evidence:3,tone:3,clarity:3,nextSteps:3},critical:false,rationale:'Clear response',evidence:[{quote:'Invented quote',axis:'policy',reason:'test'}]};assert.throws(()=>validateJudge(j,{reply:'actual text'}),/quote/i);
});
