import {digest} from '../domain/policy.mjs';
import {safeError} from '../config.mjs';
export function createCallLedger({jobId,cycle,maxCalls,store,guard,writeTrace,loadTrace,call}){
  let tail=Promise.resolve();
  const invoke=async(operation,options,validate)=>{
    await guard();const key=digest({operation,options});
    const completed=(await store.docs('GEPA_CALL_RESULT',jobId)).find(d=>d.key===key&&(d.success||d.evaluationFailure));
    if(completed){
      const result=await loadTrace(completed.artifact);
      // A recorded malformed answer is terminal feedback, never a fresh roll.
      if(completed.evaluationFailure)return{...result,evaluationError:completed.error,trace:completed.artifact,responseSource:'SAVED_RESPONSE'};
      validate(result);return{...result,trace:completed.artifact,responseSource:'SAVED_RESPONSE'};
    }
    const starts=await store.docs('GEPA_CALL_START',jobId),existing=starts.find(d=>d.key===key&&d.cycle===cycle);
    if(existing)throw Object.assign(new Error('Prompt optimization call outcome is failed or uncertain; explicit resume is required before another request attempt.'),{code:'GEPA_UNCERTAIN_CALL'});
    if(starts.length>=maxCalls)throw Object.assign(new Error('Prompt optimization request limit reached; no more requests will be sent.'),{code:'GEPA_CALL_LIMIT'});
    const id=digest({jobId,key,cycle});
    await store.saveDoc({id,kind:'GEPA_CALL_START',parentId:jobId,value:{key,cycle,operation,requestDigest:digest(options),startedAt:new Date().toISOString()}});
    let result;
    try{await guard();result=await call(options);validate(result);}
    catch(error){
      const failure=safeError(error),evaluationFailure=error.evaluationFailure===true&&!!result;
      const artifact=await writeTrace(id,{...result,options,raw:result?.raw||error.raw||null,error:failure});
      await store.saveDoc({id:digest({result:id}),kind:'GEPA_CALL_RESULT',parentId:jobId,value:{key,startId:id,cycle,success:false,evaluationFailure,artifact,error:failure}});
      // Only validation of a received response may continue. Failed persistence,
      // transport errors, cancellation and lost leases still stop the search.
      if(evaluationFailure)return{...result,evaluationError:failure,trace:artifact,responseSource:'FRESH_MODEL_RESPONSE'};
      throw error;
    }
    const artifact=await writeTrace(id,{...result,options});
    await store.saveDoc({id:digest({result:id}),kind:'GEPA_CALL_RESULT',parentId:jobId,value:{key,startId:id,cycle,success:true,artifact}});
    return{...result,trace:artifact,responseSource:'FRESH_MODEL_RESPONSE'};
  };
  return(operation,options,validate=()=>{})=>{
    // One durable PROPOSE task owns this ledger. Serialize its reservations so
    // overlapping native callbacks see committed receipts and the latest count.
    const queued=tail.then(()=>invoke(operation,options,validate));
    tail=queued.catch(()=>{});return queued;
  };
}
export function callLedgerStatus(starts,results,{activeCycle,leaseUntil=0,now=Date.now()}={}){
  const missing=starts.filter(s=>!results.some(r=>r.startId===s.id||r.id===digest({result:s.id})));
  const activeCalls=missing.filter(s=>activeCycle!==undefined&&s.cycle===activeCycle&&leaseUntil>now).length;
  return{callAttempts:starts.length,recordedResults:results.length,activeCalls,uncertainCalls:missing.length-activeCalls,evaluationFailures:results.filter(r=>r.evaluationFailure).length};
}
