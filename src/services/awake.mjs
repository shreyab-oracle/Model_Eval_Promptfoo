import {spawn} from 'node:child_process';

// Request automatic-idle-sleep prevention only while work is active. Ending
// stdin releases it; process exit also clears Windows' thread-scoped request.
// This does not change the power plan or prevent deliberate user suspension.
const command=`$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class EvaluationPower {
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern uint SetThreadExecutionState(uint flags);
}
'@
if ([EvaluationPower]::SetThreadExecutionState([uint32]2147483649) -eq 0) { throw 'Windows rejected the active evaluation power request' }
[Console]::Out.WriteLine('ready')
try { [void][Console]::In.ReadLine() }
finally {
  if ([EvaluationPower]::SetThreadExecutionState([uint32]2147483648) -eq 0) { throw 'Windows could not clear the evaluation power request' }
  [Console]::Out.WriteLine('released')
}
`;
export function createAwakeGuard({platform=process.platform,spawnProcess=spawn,onError=()=>{}}={}){
  let child,disabled=false;
  return{setActive(active){
    if(!active){const previous=child;child=undefined;if(previous){previous.releasing=true;previous.stdin.end();}return;}
    if(platform!=='win32'||child||disabled)return;
    let helper;
    try{helper=spawnProcess('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-WindowStyle','Hidden','-Command',command],{windowsHide:true,stdio:['pipe','pipe','pipe']});}
    catch(error){disabled=true;onError(error);return;}
    child=helper;let stderr='';
    const failed=error=>{if(helper.releasing||disabled)return;disabled=true;if(child===helper)child=undefined;onError(error);};
    helper.stdout.on('data',()=>{});
    helper.stderr.on('data',data=>{stderr=(stderr+data.toString()).slice(-2000);});
    helper.stdin.on('error',failed);helper.on('error',failed);
    helper.on('close',code=>{if(child===helper)child=undefined;if(!helper.releasing)failed(new Error(`Evaluation sleep prevention stopped (${code}): ${stderr||'helper exited'}`));});
  }};
}
