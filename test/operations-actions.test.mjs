import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../frontend/operations.mjs',import.meta.url),'utf8').replace(/^import[^\n]+\n/,'');
test('copy prompt copies only the saved instructions without inference or form submission',async()=>{
  const events=new Map(),status={setAttribute(){}},copied=[];let requests=0;
  const prompt={textContent:'The generated instructions only.'};
  vm.runInNewContext(source,{document:{getElementById:id=>id==='operation-status'?status:prompt,addEventListener:(name,fn)=>events.set(name,fn),querySelector:()=>null,body:{dataset:{active:'false'}}},navigator:{clipboard:{writeText:async text=>copied.push(text)}},fetch:async()=>{requests++;throw Error('No request expected');}});
  const button={dataset:{copyPrompt:'saved-prompt'},hasAttribute:()=>false};
  await events.get('click')({target:{closest:()=>button}});
  assert.deepEqual(copied,['The generated instructions only.']);assert.equal(requests,0);assert.equal(status.textContent,'Prompt copied.');
});
