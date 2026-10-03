const canonicalProof=value=>Array.isArray(value)?value.map(canonicalProof):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonicalProof(value[key])])):value;
const releaseSignature=(outcome,proof)=>JSON.stringify([outcome,canonicalProof(proof)]);
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
const token=(value,name)=>{if(typeof value!=='string'||!value||value.length>200||/[\x00-\x1f]/.test(value))throw Error(`Invalid ${name}`);return value};
const blocked=()=>Object.assign(Error('Media owner intake is closed for quiescence; no new effect was admitted.'),{status:409,executed:false});
/** Private durable owner gate. A separate lifetime lock excludes a second writer. */
export class MediaQuiescence {
 constructor(directory,inspect,worker,onMayBeIdle=()=>{}){
  this.inspectWork=inspect;this.worker=worker;this.onMayBeIdle=onMayBeIdle;this.active=0;this.transition=false;
  this.lock=new DatabaseSync(join(directory,'media-owner-lock.sqlite'));try{this.lock.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS owner(id INTEGER); BEGIN EXCLUSIVE');}catch(error){this.lock.close();throw error;}
  this.db=new DatabaseSync(join(directory,'media-quiescence.sqlite'));this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
   CREATE TABLE IF NOT EXISTS fence(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY,value TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY,state TEXT NOT NULL);`);
  const old=this.current();if(old){old.state='unknown';this.save(old);}
  this.db.prepare("UPDATE calls SET state='unverified' WHERE state<>'unverified'").run();
 }
 current(){const row=this.db.prepare('SELECT value FROM fence WHERE id=1').get();return row&&JSON.parse(row.value);}
 save(value){this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('INSERT OR REPLACE INTO fence VALUES(1,?)').run(JSON.stringify(value));this.db.prepare('INSERT OR REPLACE INTO receipts VALUES(?,?)').run(value.fenceId,JSON.stringify(value));this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}}
 call(id,state){if(state===null)this.db.prepare('DELETE FROM calls WHERE id=?').run(id);else this.db.prepare('INSERT OR REPLACE INTO calls VALUES(?,?)').run(id,state);}
 inspect(){const work=this.inspectWork(),unverifiedCalls=Number(this.db.prepare("SELECT count(*) n FROM calls WHERE state='unverified'").get().n);return {intakeClosed:!!this.current(),fence:this.current(),activeRequests:this.active,...work,unverifiedCalls,gaps:[...(work.gaps??[]),...(unverifiedCalls?['prior-provider-call-lifetime-unverified']:[])]};}
 async effect(work){if(this.current())throw blocked();this.active++;try{return await work()}finally{this.active--;this.onMayBeIdle();}}
 participant(ownerId='media'){
  token(ownerId,'owner identity');
  const release=async(context,outcome,proof)=>this.release(ownerId,context,outcome,proof);
  return {id:ownerId,acquire:async context=>{
   if(this.transition)throw Error('Media quiescence transition already running');
   const value=Object.fromEntries(['fenceId','commandId','purpose','instanceId','dataScope'].map(key=>[key,token(context[key],key)]));
   if(!['distribution-update','recovery'].includes(value.purpose))throw Error('Unsupported quiescence purpose');
   value.ownerId=ownerId;value.state='checking';const old=this.current();
   if(old){if(['fenceId','commandId','purpose','instanceId','dataScope','ownerId'].some(key=>old[key]!==value[key]))throw Error('Different media fence requires reconciliation');if(old.state!=='held')throw Error('Media fence is unknown; never reacquire');return {ownerId,fenceId:value.fenceId,release:(outcome,proof)=>release(context,outcome,proof)}}
   if(this.db.prepare('SELECT 1 FROM receipts WHERE id=?').get(value.fenceId))throw Error('Released media fence cannot be acquired again');
   const work=this.inspect();if(work.activeRequests||work.gaps.length||Object.values(work.counts).some(value=>value>0))return null;
   this.transition=true;this.save(value);
   try{
    const worker=this.worker();if(worker){const native=await worker.request('quiescence.acquire',{ownerId,context:value});if(native.held===false&&native.executed===false){this.clear({...value,state:'refused'});return null;}if(native.held!==true||native.fenceId!==value.fenceId||native.ownerId!==ownerId)throw Error('Media worker held proof unavailable');}
    value.state='held';this.save(value);return {ownerId,fenceId:value.fenceId,release:(outcome,proof)=>release(context,outcome,proof)};
   }catch(error){value.state='unknown';this.save(value);throw error;}finally{this.transition=false;}
  },reconcileRelease:async context=>release(context,context.outcome,context.proof)};
 }
 clear(value){this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('INSERT OR REPLACE INTO receipts VALUES(?,?)').run(value.fenceId,JSON.stringify(value));this.db.prepare('DELETE FROM fence WHERE id=1').run();this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}}
 async release(ownerId,context,outcome,proof){
  if(this.transition)throw Error('Media quiescence transition running');
  const old=this.current();if(!old){const row=this.db.prepare('SELECT value FROM receipts WHERE id=?').get(context.fenceId),prior=row&&JSON.parse(row.value);if(prior?.state==='released'&&prior.ownerId===ownerId&&['fenceId','commandId','purpose','instanceId','dataScope'].every(key=>prior[key]===context[key])&&prior.releaseSignature===releaseSignature(outcome,proof))return;throw Error('Exact retained media fence required');}
  if(old.ownerId!==ownerId||['fenceId','commandId','purpose','instanceId','dataScope'].some(key=>old[key]!==context[key]))throw Error('Exact media fence context required');
  if(outcome==='unknown'){old.state='unknown';this.save(old);return;}
  const refused=proof?.kind==='admission-refused'&&old.state==='held'&&outcome==='unchanged';
  const verified=proof?.verified===true&&proof.fenceId===old.fenceId&&proof.commandId===old.commandId&&proof.dataScope===old.dataScope&&proof.outcome===outcome&&['ready','unchanged'].includes(outcome)&&((proof.instanceId===old.instanceId)===(outcome==='unchanged'))&&typeof proof.instanceId==='string'&&!!proof.instanceId&&typeof proof.receiptId==='string'&&!!proof.receiptId;
  if(!refused&&!verified)throw Error('Authoritative exact media release proof required');
  this.transition=true;
  try{const worker=this.worker();if(worker){const result=await worker.request('quiescence.release',{ownerId,context:old,outcome,proof});if(result.released!==true)throw Error('Media worker release remains unconfirmed');}this.clear({...old,state:'released',outcome,releaseSignature:releaseSignature(outcome,proof)});}
  catch(error){old.state='unknown';this.save(old);throw error;}finally{this.transition=false;}
 }
 close(){this.db.close();this.lock.exec('ROLLBACK');this.lock.close();}
}
