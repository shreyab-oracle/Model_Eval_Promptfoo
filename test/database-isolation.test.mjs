import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {migrate} from '../src/db/migrate.mjs';
import {repository} from '../src/db/repository.mjs';
import {getDriver,closePool} from '../src/db/pool.mjs';
import {canonical,digest} from '../src/domain/policy.mjs';

// Only the external Oracle connection is replaced. The real migration,
// repository and location reservation code execute against this driver.
Object.assign(process.env,{DB_USER:'unit-user',DB_PASSWORD:'unit-password',DB_CONNECT_STRING:'unit-only',DB_WALLET_DIR:'.',DB_WALLET_PASSWORD:'unit-wallet'});
const legacyNames=['AIE_MIGRATIONS','AIE_DOCUMENTS','AIE_RUNS','AIE_TASKS','AIE_ATTEMPTS','AIE_DOC_KIND_PARENT','AIE_TASK_CLAIM','AIE_FILE_NUMBER'];
function fixture(){
  const objects=new Map(legacyNames.map(name=>[name,{type:name.endsWith('NUMBER')?'SEQUENCE':name.includes('CLAIM')||name.includes('KIND_PARENT')?'INDEX':'TABLE'}]));
  const ledgers=new Map([['AIE_MIGRATIONS',new Map()]]),documents=new Map([['AIE_DOCUMENTS',new Map()]]),numbers=new Map([['AIE_FILE_NUMBER',91]]),calls=[];
  const connection={
    async execute(sql,binds={}){
      calls.push({sql,binds:structuredClone(binds)});
      if(sql.startsWith('SELECT table_name FROM user_tables')){
        const names=[...sql.matchAll(/'(AIEP?_\w+)'/g)].map(match=>match[1]);
        return{rows:names.filter(name=>objects.get(name)?.type==='TABLE').map(TABLE_NAME=>({TABLE_NAME}))};
      }
      const create=sql.match(/^CREATE (TABLE|INDEX|SEQUENCE) (AIEP?_\w+)/);
      if(create){
        const [,type,name]=create;
        if(objects.has(name))throw Object.assign(new Error('ORA-00955: name is already used by an existing object'),{errorNum:955});
        objects.set(name,{type});
        if(name.endsWith('_MIGRATIONS'))ledgers.set(name,new Map());
        if(name.endsWith('_DOCUMENTS'))documents.set(name,new Map());
        if(type==='SEQUENCE')numbers.set(name,0);
        return{};
      }
      if(sql.startsWith('SELECT object_name FROM user_objects'))return{rows:objects.get(binds.n)?.type===binds.t?[{OBJECT_NAME:binds.n}]:[]};
      const ledger=sql.match(/(?:FROM|INTO|UPDATE) (AIEP?_MIGRATIONS)/)?.[1];
      if(ledger){
        const rows=ledgers.get(ledger);
        assert.ok(rows,`Missing ledger ${ledger}`);
        if(sql.startsWith('SELECT'))return{rows:rows.has(binds.v)?[structuredClone(rows.get(binds.v))]:[]};
        if(sql.startsWith('INSERT'))rows.set(binds.v,{DIGEST:binds.d,STEP_INDEX:0,STATUS:'APPLYING'});
        else if(sql.includes('step_index=:s'))rows.get(binds.v).STEP_INDEX=binds.s;
        else rows.get(binds.v).STATUS='APPLIED';
        return{rowsAffected:1};
      }
      const sequence=sql.match(/^SELECT (AIEP?_FILE_NUMBER)\.NEXTVAL/);
      if(sequence){const name=sequence[1],next=numbers.get(name)+1;numbers.set(name,next);return{rows:[{N:next}]};}
      const table=sql.match(/(?:FROM|INTO) (AIEP?_DOCUMENTS)/)?.[1];
      if(table){
        const rows=documents.get(table);assert.ok(rows,`Missing documents table ${table}`);
        if(sql.startsWith('INSERT')){
          rows.set(binds.id,{ID:binds.id,KIND:binds.kind,PARENT_ID:binds.parentId,VERSION_NAME:binds.version,DIGEST:binds.hash,PAYLOAD:binds.payload,CREATED_AT:new Date('2026-11-04T00:00:00Z')});return{rowsAffected:1};
        }
        const row=rows.get(binds.id);return{rows:row?[structuredClone(row)]:[]};
      }
      throw new Error(`Unexpected database-isolation SQL: ${sql}`);
    },
    async commit(){},async rollback(){},async close(){}
  };
  return{objects,ledgers,documents,numbers,calls,connection};
}
async function withDatabase(f,work){
  const driver=getDriver(),original=driver.createPool;
  driver.createPool=async()=>({getConnection:async()=>f.connection,close:async()=>{}});
  try{return await work();}finally{await closePool();driver.createPool=original;}
}

test('migrations create an independent project schema and leave the React schema untouched',async()=>{
  const f=fixture(),legacyObjects=structuredClone(f.objects),legacyLedger=structuredClone(f.ledgers.get('AIE_MIGRATIONS'));
  const result=await withDatabase(f,()=>migrate());
  assert.deepEqual(result.migrations,[{version:1,status:'applied',statements:6}]);
  for(const name of ['AIEP_MIGRATIONS','AIEP_DOCUMENTS','AIEP_RUNS','AIEP_TASKS','AIEP_ATTEMPTS','AIEP_DOC_KIND_PARENT','AIEP_TASK_CLAIM'])assert.ok(f.objects.has(name),`${name} must be separate`);
  for(const [name,value] of legacyObjects)assert.deepEqual(f.objects.get(name),value);
  assert.deepEqual(f.ledgers.get('AIE_MIGRATIONS'),legacyLedger);
  assert.equal(f.calls.some(({sql})=>/\bAIE_\w+\b/.test(sql)),false,'migration SQL must never target legacy objects');
  const writes=f.calls.filter(({sql})=>/^(CREATE|INSERT|UPDATE)/.test(sql)).length;
  const repeat=await withDatabase(f,()=>migrate());
  assert.deepEqual(repeat.migrations,[{version:1,status:'already applied'}]);
  assert.equal(f.calls.filter(({sql})=>/^(CREATE|INSERT|UPDATE)/.test(sql)).length,writes);
});

test('migration recovery reconciles only the expected project object name and type',async()=>{
  const f=fixture(),sql=fs.readFileSync(new URL('../migrations/001-initial.sql',import.meta.url),'utf8');
  f.objects.set('AIEP_MIGRATIONS',{type:'TABLE'});f.objects.set('AIEP_DOCUMENTS',{type:'TABLE'});f.objects.set('AIEP_DOC_KIND_PARENT',{type:'INDEX'});
  f.ledgers.set('AIEP_MIGRATIONS',new Map([[1,{DIGEST:createHash('sha256').update(sql).digest('hex'),STEP_INDEX:1,STATUS:'APPLYING'}]]));
  await withDatabase(f,()=>migrate());
  assert.deepEqual(f.calls.find(({sql})=>sql.startsWith('SELECT object_name')).binds,{n:'AIEP_DOC_KIND_PARENT',t:'INDEX'});
  assert.equal(f.ledgers.get('AIEP_MIGRATIONS').get(1).STATUS,'APPLIED');
});

test('migration recovery rejects an object with the expected name but a different type',async()=>{
  const f=fixture(),sql=fs.readFileSync(new URL('../migrations/001-initial.sql',import.meta.url),'utf8');
  f.objects.set('AIEP_MIGRATIONS',{type:'TABLE'});f.objects.set('AIEP_DOCUMENTS',{type:'TABLE'});f.objects.set('AIEP_DOC_KIND_PARENT',{type:'TABLE'});
  f.ledgers.set('AIEP_MIGRATIONS',new Map([[1,{DIGEST:createHash('sha256').update(sql).digest('hex'),STEP_INDEX:1,STATUS:'APPLYING'}]]));
  await withDatabase(f,()=>assert.rejects(()=>migrate(),{errorNum:955}));
  assert.equal(f.ledgers.get('AIEP_MIGRATIONS').get(1).STEP_INDEX,1);
  assert.equal(f.ledgers.get('AIEP_MIGRATIONS').get(1).STATUS,'APPLYING');
});

test('migration recovery rejects a changed checksum before executing any schema statement',async()=>{
  const f=fixture();f.objects.set('AIEP_MIGRATIONS',{type:'TABLE'});
  f.ledgers.set('AIEP_MIGRATIONS',new Map([[1,{DIGEST:'changed',STEP_INDEX:1,STATUS:'APPLYING'}]]));
  await withDatabase(f,()=>assert.rejects(()=>migrate(),/Migration checksum changed/));
  assert.equal(f.calls.some(({sql})=>/^(CREATE|INSERT|UPDATE)/.test(sql)),false);
});

test('a conflicting project object without its own migration journal is rejected',async()=>{
  const f=fixture();f.objects.set('AIEP_DOCUMENTS',{type:'TABLE'});
  await withDatabase(f,()=>assert.rejects(()=>migrate(),/collision without migration ledger/));
  assert.equal(f.calls.some(({sql})=>/^(CREATE|INSERT|UPDATE)/.test(sql)),false);
});

test('document reads and writes use only project tables even when a legacy ID matches',async()=>{
  const f=fixture();f.objects.set('AIEP_DOCUMENTS',{type:'TABLE'});f.documents.set('AIEP_DOCUMENTS',new Map());
  const legacyValue={text:'React history'},legacyRow={ID:'same-id',KIND:'PROMPT',PARENT_ID:null,VERSION_NAME:null,DIGEST:digest(legacyValue),PAYLOAD:canonical(legacyValue),CREATED_AT:new Date('2026-11-01T00:00:00Z')};
  f.documents.get('AIE_DOCUMENTS').set('same-id',legacyRow);
  await withDatabase(f,async()=>{
    assert.equal(await repository.doc('same-id'),null);
    await repository.saveDoc({id:'same-id',kind:'PROMPT',value:{text:'Promptfoo history'}});
    assert.equal((await repository.doc('same-id')).text,'Promptfoo history');
  });
  assert.deepEqual(f.documents.get('AIE_DOCUMENTS').get('same-id'),legacyRow);
  assert.equal(f.numbers.get('AIE_FILE_NUMBER'),91);assert.equal(f.numbers.has('AIEP_FILE_NUMBER'),false);
  assert.equal(f.calls.some(({sql})=>/\bAIE_\w+\b/.test(sql)),false,'runtime SQL must never target legacy objects');
});
