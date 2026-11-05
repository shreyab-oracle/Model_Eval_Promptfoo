import {verifyOptimizer} from '../src/optimization/runner.mjs';
import {safeError} from '../src/config.mjs';
try{console.log(JSON.stringify(await verifyOptimizer(),null,2));}
catch(error){console.error(JSON.stringify({error:safeError(error)}));process.exitCode=1;}
