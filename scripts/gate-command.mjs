import {releaseGate} from '../src/services/release-gate.mjs';
export async function runGateCommand(runId,{evaluate=releaseGate,print=value=>console.log(JSON.stringify(value,null,2))}={}){
  if(!runId)throw new Error('Gate requires --run <completed-live-run-id>');
  const result=await evaluate(runId);print(result);process.exitCode=result.exitCode;return result;
}
