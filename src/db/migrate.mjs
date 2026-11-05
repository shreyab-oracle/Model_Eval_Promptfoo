import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {withConnection} from './pool.mjs';
export async function migrate(){
  const directory=new URL('../../migrations/',import.meta.url);
  const files=fs.readdirSync(directory).filter(name=>/^\d+-.*\.sql$/.test(name)).sort();
  return withConnection(async c=>{
    const tables=await c.execute("SELECT table_name FROM user_tables WHERE table_name IN ('AIEP_MIGRATIONS','AIEP_DOCUMENTS','AIEP_RUNS','AIEP_TASKS','AIEP_ATTEMPTS')");
    if(!tables.rows.some(r=>r.TABLE_NAME==='AIEP_MIGRATIONS')){
      if(tables.rows.length)throw new Error('AIEP_ table name collision without migration ledger; inspect existing tables before continuing');
      await c.execute('CREATE TABLE AIEP_MIGRATIONS (version NUMBER PRIMARY KEY, digest VARCHAR2(64) NOT NULL, step_index NUMBER DEFAULT 0 NOT NULL, status VARCHAR2(20) NOT NULL, applied_at TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL)');
    }
    const results=[];
    for(const file of files){
    const version=Number(file.split('-')[0]),sql=fs.readFileSync(new URL(file,directory),'utf8'),hash=createHash('sha256').update(sql).digest('hex');
    let row=(await c.execute('SELECT digest,step_index,status FROM AIEP_MIGRATIONS WHERE version=:v',{v:version})).rows[0];
    if(row&&row.DIGEST!==hash)throw new Error('Migration checksum changed; add a new version instead of editing an applied migration');
    if(row?.STATUS==='APPLIED'){results.push({version,status:'already applied'});continue;}
    if(!row){await c.execute("INSERT INTO AIEP_MIGRATIONS(version,digest,status) VALUES(:v,:d,'APPLYING')",{v:version,d:hash});await c.commit();row={STEP_INDEX:0};}
    const steps=sql.split('-- @statement').map(s=>s.trim()).filter(Boolean);
    for(let i=row.STEP_INDEX;i<steps.length;i++){
      // DDL auto-commits in Oracle. A crash after DDL but before journalling is reconciled by object identity.
      try{await c.execute(steps[i]);}catch(e){if(e.errorNum!==955)throw e;const match=steps[i].match(/^CREATE (TABLE|INDEX|SEQUENCE) (AIEP_\w+)/);if(!match)throw e;const object=(await c.execute('SELECT object_name FROM user_objects WHERE object_name=:n AND object_type=:t',{n:match[2],t:match[1]})).rows;if(!object.length)throw e;}
      await c.execute('UPDATE AIEP_MIGRATIONS SET step_index=:s WHERE version=:v',{s:i+1,v:version});await c.commit();
    }
    await c.execute("UPDATE AIEP_MIGRATIONS SET status='APPLIED',applied_at=SYSTIMESTAMP WHERE version=:v",{v:version});await c.commit();results.push({version,status:'applied',statements:steps.length});
    }
    return{migrations:results};
  });
}
