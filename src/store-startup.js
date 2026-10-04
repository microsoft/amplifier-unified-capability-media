import {DatabaseSync} from 'node:sqlite';
import {lstatSync} from 'node:fs';

const schemas={
 quiescence:{fence:['id','value'],receipts:['id','value'],calls:['id','state']},
 transcripts:{intents:['seq','session','call','item','role','text','append','command','status','attempted','created']},
 preferences:{commands:['account','id','fingerprint','body']},
};

/** Fixed metadata preflight, called under the enclosing Media lifetime lease.
 * History is a derived native-confirmed projection, not an append-intent source.
 * This does not detect whole-store disappearance, row loss or arbitrary tampering.
 */
export function validateMediaStore(path,kind){
 const schema=schemas[kind];if(!schema)throw Error('Unknown Media authority store');
 try{lstatSync(path);}catch(error){
  if(error.code!=='ENOENT')throw error;
  for(const suffix of ['-wal','-shm','-journal']){
   try{lstatSync(path+suffix);}catch(sidecarError){if(sidecarError.code==='ENOENT')continue;throw sidecarError;}
   throw Error('Existing Media authority main database is missing');
  }
  return false;
 }
 // Read-only validation can update derived SHM/read marks or create empty
 // coordination sidecars; it must not checkpoint authoritative main/WAL data.
 const db=new DatabaseSync(path,{readOnly:true});
 try{
  for(const [table,columns] of Object.entries(schema)){
   if(db.prepare('SELECT type FROM sqlite_master WHERE name=?').get(table)?.type!=='table')
    throw Error('Existing Media authority schema is incomplete: '+table);
   const actual=new Set(db.prepare('PRAGMA table_info('+table+')').all().map(column=>column.name));
   if(columns.some(column=>!actual.has(column)))throw Error('Existing Media authority schema is incomplete: '+table);
  }
  return true;
 }finally{db.close();}
}
