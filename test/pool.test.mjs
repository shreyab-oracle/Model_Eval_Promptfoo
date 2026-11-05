import test from 'node:test';
import assert from 'node:assert/strict';
import {getDriver,withConnection,closePool} from '../src/db/pool.mjs';

test('database pool uses two fixed connections and releases a connection after work',async()=>{
  const driver=getDriver(),original=driver.createPool;
  let options,closed=0;
  driver.createPool=async value=>{options=value;return{getConnection:async()=>({close:async()=>{closed++;}}),close:async()=>{}};};
  try{
    assert.equal(await withConnection(async()=>42),42);
    assert.equal(options.poolMax,2);
    assert.equal(options.poolMin,2);
    assert.equal(closed,1);
  }finally{await closePool();driver.createPool=original;}
});

test('a normal release calls the driver close method with no undefined options argument',async()=>{
  const driver=getDriver(),original=driver.createPool;
  driver.createPool=async()=>({getConnection:async()=>({close:async(...args)=>{assert.equal(args.length,0);}}),close:async()=>{}});
  try{assert.equal(await withConnection(async()=>9),9);}
  finally{await closePool();driver.createPool=original;}
});

test('a connection acquisition failure retries before any application SQL is executed',async()=>{
  const driver=getDriver(),original=driver.createPool;let acquisitions=0,work=0;
  driver.createPool=async()=>({getConnection:async()=>{if(++acquisitions===1)throw Object.assign(new Error('Network recovering'),{code:'NJS-503'});return{close:async()=>{}};},close:async()=>{}});
  try{assert.equal(await withConnection(async()=>{work++;return 7;}),7);assert.equal(acquisitions,2);assert.equal(work,1);}
  finally{await closePool();driver.createPool=original;}
});

test('an explicitly read-only operation reconnects after a reset and drops the stale connection',async()=>{
  const driver=getDriver(),original=driver.createPool;let reads=0,dropped=0;
  driver.createPool=async()=>({getConnection:async()=>({rollback:async()=>{},close:async options=>{if(options?.drop)dropped++;}}),close:async()=>{}});
  try{const value=await withConnection(async()=>{if(++reads===1)throw Object.assign(new Error('Connection reset'),{code:'NJS-500'});return 8;},{readOnly:true});assert.equal(value,8);assert.equal(reads,2);assert.equal(dropped,1);}
  finally{await closePool();driver.createPool=original;}
});

test('mutations are never replayed after an ambiguous network or close failure',async()=>{
  const driver=getDriver(),original=driver.createPool;let writes=0;
  driver.createPool=async()=>({getConnection:async()=>({rollback:async()=>{},close:async()=>{throw Object.assign(new Error('Close reset'),{code:'ECONNRESET'});}}),close:async()=>{}});
  try{await assert.rejects(()=>withConnection(async()=>{writes++;return 'committed';}),/Close reset/);assert.equal(writes,1);}
  finally{await closePool();driver.createPool=original;}
});

test('an outage has bounded retries and retains the actual database error',async()=>{
  const driver=getDriver(),original=driver.createPool;let attempts=0,work=0;
  driver.createPool=async()=>({getConnection:async()=>{attempts++;throw Object.assign(new Error('Host unreachable'),{code:'NJS-503'});},close:async()=>{}});
  try{await assert.rejects(()=>withConnection(async()=>{work++;}),e=>e.code==='NJS-503'&&e.message==='Host unreachable');assert.equal(attempts,2);assert.equal(work,0);}
  finally{await closePool();driver.createPool=original;}
});

test('a stalled database write has an overall deadline, breaks and drops its connection without replay',async()=>{
  const driver=getDriver(),original=driver.createPool;let writes=0,broken=0,dropped=0;
  driver.createPool=async()=>({getConnection:async()=>({break:async()=>{broken++;},close:async options=>{if(options?.drop)dropped++;}}),close:async()=>{}});
  try{await assert.rejects(()=>withConnection(()=>{writes++;return new Promise(()=>{});},{operationTimeoutMs:20,cleanupTimeoutMs:20}),e=>e.code==='DB_OPERATION_TIMEOUT');assert.equal(writes,1);assert.equal(broken,1);assert.equal(dropped,1);}
  finally{await closePool();driver.createPool=original;}
});
test('a stalled connection release does not pin the service pool forever',async()=>{
  const driver=getDriver(),original=driver.createPool;let forcedClose=0;
  driver.createPool=async()=>({getConnection:async()=>({close:()=>new Promise(()=>{})}),close:async drain=>{if(drain===0)forcedClose++;}});
  try{await assert.rejects(()=>withConnection(async()=>1,{cleanupTimeoutMs:20}),e=>e.code==='DB_OPERATION_TIMEOUT');assert.equal(forcedClose,1);}
  finally{await closePool();driver.createPool=original;}
});
