import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
/** A durable intent spool, never native history authority. Only unattempted
 * adjacent fragments coalesce. SQL indexes keep recovery scoped and bounded. */
export class TranscriptQueue{
 constructor(path,{record,onRecorded=()=>{},admit=work=>work()}){this.admit=admit;this.record=record;this.onRecorded=onRecorded;this.running=new Map();this.timers=new Map();this.closed=false;this.db=new DatabaseSync(path);this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
 CREATE TABLE IF NOT EXISTS intents(seq INTEGER PRIMARY KEY AUTOINCREMENT,session TEXT NOT NULL,call TEXT NOT NULL,item TEXT NOT NULL,role TEXT NOT NULL,text TEXT NOT NULL,append INTEGER NOT NULL,command TEXT NOT NULL UNIQUE,status TEXT NOT NULL,attempted INTEGER NOT NULL DEFAULT 0,created TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS pending_session ON intents(session,status,seq);
 CREATE INDEX IF NOT EXISTS call_order ON intents(session,call,seq);
 CREATE TABLE IF NOT EXISTS history(session TEXT NOT NULL,id TEXT NOT NULL,created TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(session,id));
 CREATE INDEX IF NOT EXISTS history_recent ON history(session,created DESC);`);}
 enqueue(entry){if(this.closed)throw Error('Transcript owner closed.');if(!['user','assistant'].includes(entry.role)||typeof entry.text!=='string'||entry.text.length>65536)throw Error('Invalid bounded voice transcript.');this.db.exec('BEGIN IMMEDIATE');let command;
  try{const previous=this.db.prepare('SELECT * FROM intents WHERE session=? AND call=? ORDER BY seq DESC LIMIT 1').get(entry.session,entry.callId);
   if(previous&&previous.item===entry.itemId&&previous.role===entry.role&&previous.status==='pending'&&!previous.attempted&&(!entry.append||previous.text.length+entry.text.length<=65536)){
    command=previous.command;this.db.prepare('UPDATE intents SET text=?,append=? WHERE seq=?').run(entry.append?previous.text+entry.text:entry.text,entry.append?previous.append:0,previous.seq);
   }else{command=entry.commandId||'media-transcript:'+randomUUID();this.db.prepare('INSERT INTO intents(session,call,item,role,text,append,command,status,created) VALUES(?,?,?,?,?,?,?,\'pending\',?)').run(entry.session,entry.callId,entry.itemId,entry.role,entry.text,entry.append?1:0,command,new Date().toISOString());}
   this.db.exec('COMMIT');
  }catch(error){this.db.exec('ROLLBACK');throw error;}
  if(!this.timers.has(entry.session)){const timer=setTimeout(()=>{this.timers.delete(entry.session);this.flush(entry.session).catch(()=>{});},100);timer.unref();this.timers.set(entry.session,timer);}
  this.onRecorded(entry.session);
  return {durability:'pending',commandId:command};
 }
 pendingCount(){return Number(this.db.prepare("SELECT count(*) n FROM intents WHERE status='pending'").get().n);}
 async flush(session){return this.admit(()=>this.flushSelected(session));}
 async flushSelected(session){if(this.closed)return;if(typeof session!=='string')throw Error('Transcript drain requires one explicit session.');if(this.running.has(session))return this.running.get(session);const work=this.drain(session);this.running.set(session,work);try{return await work}finally{this.running.delete(session)}}
 async drain(session){let count=0;const busyCalls=new Set();while(count++<64&&!this.closed){
  // Older unknown or busy intents fence later fragments for the same call.
  const rows=this.db.prepare(`SELECT q.* FROM intents q WHERE q.session=? AND q.status='pending' AND q.call NOT IN(SELECT value FROM json_each(?)) AND NOT EXISTS(SELECT 1 FROM intents earlier WHERE earlier.session=q.session AND earlier.call=q.call AND earlier.seq<q.seq) ORDER BY q.seq LIMIT 1`).all(session,JSON.stringify([...busyCalls]));
  const row=rows.find(item=>!busyCalls.has(item.call));if(!row)break;
  const admitted=this.db.prepare("UPDATE intents SET status='unknown',attempted=1 WHERE seq=? AND status='pending'").run(row.seq);if(!admitted.changes)continue;
  const entry={session:row.session,callId:row.call,itemId:row.item,role:row.role,text:row.text,append:!!row.append,commandId:row.command,createdAt:row.created};let result;
  try{result=await this.record(entry);}catch{continue;} // Unknown remains fenced; no guessed retry policy.
  if(result?.recorded===false&&result.reason==='busy'&&result.retryable===true&&result.executed===false){this.db.prepare("UPDATE intents SET status='pending' WHERE seq=?").run(row.seq);busyCalls.add(row.call);continue;}
  if(result?.recorded!==true)continue;
  const id=result.nativeMessageId||row.item,previous=this.db.prepare('SELECT created FROM history WHERE session=? AND id=?').get(session,id),created=result.timestamp||previous?.created||row.created;
  const message={id,historyTurnId:result.historyTurnId,role:result.role||row.role,text:result.text??row.text,via:'call',createdAt:created,callId:row.call,itemId:row.item,durability:'native'};
  this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('INSERT INTO history VALUES(?,?,?,?) ON CONFLICT(session,id) DO UPDATE SET data=excluded.data').run(session,id,created,JSON.stringify(message));this.db.prepare('DELETE FROM history WHERE session=? AND id NOT IN(SELECT id FROM history WHERE session=? ORDER BY created DESC LIMIT 50)').run(session,session);this.db.prepare('DELETE FROM intents WHERE seq=?').run(row.seq);this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
  this.onRecorded(session,message);
 }}
 history(session){
  const saved=this.db.prepare('SELECT data FROM history WHERE session=? ORDER BY created DESC LIMIT 50').all(session).reverse().map(row=>JSON.parse(row.data));
  for(const row of this.db.prepare('SELECT * FROM intents WHERE session=? ORDER BY seq DESC LIMIT 100').all(session).reverse()){
   const index=saved.findIndex(value=>value.callId===row.call&&value.itemId===row.item&&value.role===row.role),previous=index<0?null:saved[index];
   const value={...previous,id:previous?.id||`voice-pending:${row.call}:${row.item}`,role:row.role,text:row.append?(previous?.text||'')+row.text:row.text,via:'call',createdAt:previous?.createdAt||row.created,callId:row.call,itemId:row.item,durability:row.status==='unknown'?'unconfirmed':'pending'};
   if(index<0)saved.push(value);else saved[index]=value;
  }
  return saved.slice(-50);
 }

 status(session){return this.db.prepare('SELECT status,count(*) AS count FROM intents WHERE session=? GROUP BY status').all(session);}
 async close(){for(const timer of this.timers.values())clearTimeout(timer);this.timers.clear();await Promise.allSettled([...this.running.values()]);this.closed=true;this.db.close();}
}
