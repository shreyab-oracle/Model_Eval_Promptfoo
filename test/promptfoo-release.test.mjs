import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const gate=await import('../src/services/release-gate.mjs').catch(()=>({}));
const command=await import('../scripts/gate-command.mjs').catch(()=>({}));
test('shared release gate preserves BLOCK even when the configured promotion target differs',()=>{
  assert.equal(typeof gate.releaseGateResult,'function');
  const b={result:{decision:'BLOCK',complete:false,reasons:['Confirmed mandatory failure']},snapshot:{}};
  const result=gate.releaseGateResult(b,{expectedTarget:{models:{baseline:'b',candidate:'c',judge:'j'}},evaluatedTarget:{models:{baseline:'b',candidate:'old',judge:'j'}},currentEvidence:true});
  assert.equal(result.decision,'BLOCK');assert.equal(result.exitCode,1);
});
test('historical eligible decisions remain archived and require a new run at the release gate',()=>{
  assert.equal(typeof gate.releaseGateResult,'function');
  const b={result:{decision:'ELIGIBLE FOR PILOT',complete:true,reasons:[]},eligibilityRequiresNewRun:true};
  const result=gate.releaseGateResult(b,{currentEvidence:false});
  assert.equal(result.decision,'REVIEW');assert.equal(result.historicalDecision,'ELIGIBLE FOR PILOT');assert.equal(result.exitCode,1);
});
test('real command process propagates noneligible exit status to CI',()=>{
  assert.equal(typeof command.runGateCommand,'function');
  const url=new URL('../scripts/gate-command.mjs',import.meta.url).href;
  for(const [decision,exitCode] of [['BLOCK',1],['REVIEW',1],['ELIGIBLE FOR PILOT',0]]){
    const source=`import {runGateCommand} from ${JSON.stringify(url)}; await runGateCommand('saved-run',{evaluate:async()=>(${JSON.stringify({decision,exitCode,complete:true})})});`;
    const child=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8'});
    assert.equal(child.status,exitCode,child.stderr);assert.equal(JSON.parse(child.stdout).decision,decision);
  }
});
