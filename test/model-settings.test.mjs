import test from 'node:test';
import assert from 'node:assert/strict';
import {chatBody} from '../src/oracle/genai.mjs';
import {settingsForModel,settingsForRole} from '../src/domain/model-settings.mjs';

const google={vendor:'google',displayName:'google.gemini-2.5-flash'},openai={vendor:'openai',displayName:'openai.gpt-5.4-mini'};
const defaults={openai:{maxCompletionTokens:2048,verbosity:'MEDIUM'},gemini:{maxTokens:6000,temperature:1,frequencyPenalty:0,presencePenalty:0,topP:0.95,fixedTopK:64}};
const request=settings=>chatBody({modelId:'configured-model',compartmentId:'configured-compartment',messages:[{role:'SYSTEM',content:'Follow the policy'},{role:'USER',content:'Invoice facts'}],settings}).chatRequest;

test('Gemini uses its supported token and sampling parameters without GPT fields',()=>{
  const settings=settingsForModel(google,defaults),body=request(settings);
  assert.equal(body.maxTokens,6000);assert.equal(body.temperature,1);assert.equal(body.topP,0.95);assert.equal('topK' in body,false);assert.equal('fixedTopK' in body,false);assert.equal(settings.fixedTopK,64);
  assert.equal(body.frequencyPenalty,0);assert.equal(body.presencePenalty,0);
  assert.equal('maxCompletionTokens' in body,false);assert.equal('verbosity' in body,false);assert.equal('family' in body,false);
  assert.equal(body.messages[0].role,'SYSTEM');assert.equal(body.messages[1].content[0].text,'Invoice facts');
});

test('GPT requests retain their original wire parameters and have no Gemini sampling settings',()=>{
  const body=request(settingsForModel(openai,defaults));
  assert.equal(body.maxCompletionTokens,2048);assert.equal(body.verbosity,'MEDIUM');assert.equal('maxTokens' in body,false);assert.equal('temperature' in body,false);
});

test('all roles read frozen model settings rather than current environment defaults',()=>{
  const frozen={settings:defaults.openai,judgeSettings:defaults.openai,modelSettings:{baseline:{family:'openai',...defaults.openai},candidate:{family:'gemini',...defaults.gemini},judge:{family:'openai',...defaults.openai}}};
  assert.equal(request(settingsForRole(frozen,'candidate')).maxTokens,6000);
  assert.equal(request(settingsForRole(frozen,'baseline')).maxCompletionTokens,2048);
  assert.equal(request(settingsForRole(frozen,'judge')).verbosity,'MEDIUM');
  assert.equal(request(settingsForRole({settings:defaults.openai,judgeSettings:defaults.openai},'candidate')).maxCompletionTokens,2048);
});

test('invalid settings and unknown model families fail before any OCI request',()=>{
  for(const [field,value] of [['topK',1],['maxTokens',0],['temperature',3],['topP',2],['frequencyPenalty',NaN]]){
    assert.throws(()=>settingsForModel(google,{...defaults,gemini:{...defaults.gemini,[field]:value}}),/settings|Top-K/i);
  }
  assert.throws(()=>settingsForModel({vendor:'unknown',displayName:'unconfigured-family'},defaults),/unsupported/i);
});
