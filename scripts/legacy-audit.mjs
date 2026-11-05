import {createHash} from 'node:crypto';
import {withConnection} from '../src/db/pool.mjs';

// Read-only fingerprint of every field, including payloads and receipts. Hash
// rows incrementally so this check never copies the old application's data.
export async function legacyDatabaseAudit(){
  return withConnection(async connection=>{
    const tables={};
    for(const table of ['AIE_DOCUMENTS','AIE_RUNS','AIE_TASKS','AIE_ATTEMPTS','AIE_MIGRATIONS']){
      const hash=createHash('sha256');let count=0;
      const result=await connection.execute(`SELECT * FROM ${table} ORDER BY ${table==='AIE_MIGRATIONS'?'version':'id'}`,{},{resultSet:true,fetchArraySize:100});
      try{for(;;){const rows=await result.resultSet.getRows(100);if(!rows.length)break;for(const row of rows){hash.update(JSON.stringify(row)+'\n');count++;}}}
      finally{await result.resultSet.close();}
      tables[table]={count,digest:hash.digest('hex')};
    }
    const sequence=(await connection.execute("SELECT sequence_name,last_number,increment_by,min_value,max_value,cache_size,cycle_flag,order_flag FROM user_sequences WHERE sequence_name='AIE_FILE_NUMBER'")).rows;
    return{tables,sequence};
  },{readOnly:true,operationTimeoutMs:180000});
}
