import {connectionStatus} from '../src/services/status.mjs';
import {safeError} from '../src/config.mjs';
import {closePool} from '../src/db/pool.mjs';
try{const result=await connectionStatus();console.log(JSON.stringify(result,null,2));if(Object.values(result.checks).some(c=>!c.ok))process.exitCode=1;}catch(e){console.error(JSON.stringify(safeError(e)));process.exitCode=1;}finally{await closePool();}
