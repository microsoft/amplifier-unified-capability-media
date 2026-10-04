import {managedParticipant,emptyManaged} from './managed-files.js';
import {emptyRetention,retentionParticipant} from './retention.js';
import {serviceIdentity,sameIdentity,validateServiceRelease} from './service-lifecycle.js';
const canonicalProof=value=>Array.isArray(value)?value.map(canonicalProof):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonicalProof(value[key])])):value;
const releaseSignature=(outcome,proof)=>JSON.stringify([outcome,canonicalProof(proof)]);
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {validateMediaStore} from './store-startup.js';
const token=(value,name)=>{if(typeof value!=='string'||!value||value.length>200||/[\x00-\x1f]/.test(value))throw Error(`Invalid ${name}`);return value};
const same=(a,b)=>['fenceId','commandId','purpose','instanceId','dataScope'].every(key=>a[key]===b[key])&&(a.purpose!=='service-stop'||sameIdentity(serviceIdentity(a.serviceIdentity),serviceIdentity(b.serviceIdentity)));
const blocked=()=>Object.assign(Error('Media owner intake is closed for quiescence; no new effect was admitted.'),{status:409,executed:false,mediaPublic:true});
const abortKeys='commandId,dataScope,fenceId,instanceId,kind,purpose,receiptId,verified';
const ownerReceiptKeys='commandId,dataScope,fenceId,instanceId,ownerId,receiptId,status';
function abortProof(context,proof){
 if(context.purpose!=='distribution-update'||!proof||Object.keys(proof).sort().join(',')!==abortKeys||proof.kind!=='distribution-admission-abort'||proof.verified!==true||proof.purpose!=='distribution-update'||['commandId','fenceId','instanceId','dataScope'].some(key=>proof[key]!==context[key]))throw Error('Exact authenticated distribution admission abort proof required');
 token(proof.receiptId,'admission abort receipt');return JSON.stringify(canonicalProof(proof));
}
/** Private durable owner gate. A separate lifetime lock excludes a second writer. */
export class MediaQuiescence {
 constructor(directory,inspect,worker,onMayBeIdle=()=>{},validateAuthority=()=>{}){
  this.inspectWork=inspect;this.worker=worker;this.onMayBeIdle=onMayBeIdle;this.active=0;this.transition=false;this.idleWaiters=new Set();
  this.lock=new DatabaseSync(join(directory,'media-owner-lock.sqlite'));try{this.lock.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS owner(id INTEGER); BEGIN EXCLUSIVE');}catch(error){this.lock.close();throw error;}
  try{
   const path=join(directory,'media-quiescence.sqlite'),existing=validateMediaStore(path,'quiescence');
   // Every configured composed store must pass before any authority opens writable.
   validateAuthority();
   this.db=new DatabaseSync(path);this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
   if(!existing)this.db.exec(`CREATE TABLE fence(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL);
    CREATE TABLE receipts(id TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE calls(id TEXT PRIMARY KEY,state TEXT NOT NULL);`);
   const old=this.current();if(old){old.state='unknown';this.save(old);}
   this.db.prepare("UPDATE calls SET state='unverified' WHERE state<>'unverified'").run();
  }catch(error){try{this.db?.close();}finally{this.lock.close();}throw error;}
 }
 current(){const row=this.db.prepare('SELECT value FROM fence WHERE id=1').get();return row&&JSON.parse(row.value);}
 save(value){this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('INSERT OR REPLACE INTO fence VALUES(1,?)').run(JSON.stringify(value));this.db.prepare('INSERT OR REPLACE INTO receipts VALUES(?,?)').run(value.fenceId,JSON.stringify(value));this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}}
 callState(id){return this.db.prepare('SELECT state FROM calls WHERE id=?').get(id)?.state;}
 call(id,state){if(state===null)this.db.prepare('DELETE FROM calls WHERE id=?').run(id);else this.db.prepare('INSERT OR REPLACE INTO calls VALUES(?,?)').run(id,state);}
 inspect(){const work=this.inspectWork(),unverifiedCalls=Number(this.db.prepare("SELECT count(*) n FROM calls WHERE state='unverified'").get().n);return {intakeClosed:!!this.current(),fence:this.current(),activeRequests:this.active,...work,unverifiedCalls,gaps:[...(work.gaps??[]),...(unverifiedCalls?['prior-provider-call-lifetime-unverified']:[])]};}
 async effect(work){if(this.current()||this.transition)throw blocked();this.active++;try{return await work()}finally{this.active--;this.wakeIdle();this.onMayBeIdle();}}
 wakeIdle(){if(!this.active&&!this.transition){for(const resolve of this.idleWaiters)resolve();this.idleWaiters.clear();}}
 async waitForIdle(){while(this.active||this.transition)await new Promise(resolve=>this.idleWaiters.add(resolve));}
 participant(ownerId='media'){
  token(ownerId,'owner identity');
  const release=async(context,outcome,proof,live=false)=>this.release(ownerId,context,outcome,proof,live);
  return managedParticipant(retentionParticipant({id:ownerId,serviceStop:{version:1},acquire:async context=>{
   if(this.transition)throw Error('Media quiescence transition already running');
   const value=Object.fromEntries(['fenceId','commandId','purpose','instanceId','dataScope'].map(key=>[key,token(context[key],key)]));
   if(!['distribution-update','recovery','service-stop','retention-hide','managed-files-disposal'].includes(value.purpose))throw Error('Unsupported quiescence purpose');
   if(value.purpose==='service-stop'){value.serviceIdentity=serviceIdentity(context.serviceIdentity);if(value.serviceIdentity.instanceId!==value.instanceId||value.serviceIdentity.dataScope!==value.dataScope)throw Error('Service identity differs from media fence');}
   value.ownerId=ownerId;value.state='checking';const old=this.current();
   if(old){if((!same(old,value)||old.ownerId!==ownerId))throw Error('Different media fence requires reconciliation');if(old.state!=='held')throw Error('Media fence is unknown; never reacquire');return {ownerId,fenceId:value.fenceId,release:(outcome,proof)=>release(value,outcome,proof,true)}}
   if(this.db.prepare('SELECT 1 FROM receipts WHERE id=?').get(value.fenceId))throw Error('Released media fence cannot be acquired again');
   if(value.purpose==='distribution-update'){value.admissionAttemptVersion=1;value.workerAttempted=false;}
   const work=this.inspect();if(work.activeRequests||work.gaps.length||Object.values(work.counts).some(value=>value>0)){if(value.admissionAttemptVersion)this.record({...value,state:'refused'});return null;}
   this.transition=true;this.save(value);
   try{
    const worker=this.worker();if(worker){if(value.purpose==='managed-files-disposal'){const hello=await worker.request('quiescence.inspect',{});if(hello.managedFiles?.version!==1){this.clear({...value,state:'refused'});return null;}}if(value.purpose==='service-stop'){const hello=await worker.request('quiescence.inspect',{});if(hello.serviceStop?.version!==1){this.clear({...value,state:'refused'});return null;}}if(value.admissionAttemptVersion){value.workerAttempted=true;this.save(value);}const native=await worker.request('quiescence.acquire',{ownerId,context:value});if(native.held===false&&native.executed===false){this.clear({...value,state:'refused'});return null;}if(native.held!==true||native.fenceId!==value.fenceId||native.ownerId!==ownerId)throw Error('Media worker held proof unavailable');}
    value.state='held';this.save(value);this.liveFence=value.fenceId;return {ownerId,fenceId:value.fenceId,release:(outcome,proof)=>release(value,outcome,proof,true)};
   }catch(error){value.state='unknown';this.save(value);throw error;}finally{this.transition=false;this.wakeIdle();}
  },abortAdmission:context=>this.abortAdmission(ownerId,context),reconcileRelease:async context=>release(context,context.outcome,context.proof)},args=>{const empty=emptyRetention(args.context,args,this.current());return this.retentionReferences?.(args.sessions)??empty;}),args=>{emptyManaged(args.context,args,this.current());return this.managedReferences(args);});
 }
 record(value){this.db.prepare('INSERT OR REPLACE INTO receipts VALUES(?,?)').run(value.fenceId,JSON.stringify(value));}
 async abortAdmission(ownerId,context){
  for(const key of ['fenceId','commandId','purpose','instanceId','dataScope'])token(context[key],key);
  const signature=abortProof(context,context.proof),row=this.db.prepare('SELECT value FROM receipts WHERE id=?').get(context.fenceId),prior=row&&JSON.parse(row.value);
  if(!prior||prior.ownerId!==ownerId||!same(prior,context)||prior.admissionAttemptVersion!==1)throw Error('Exact durable media admission attempt required; missing held row is not proof');
  if(prior.admissionAbortSignature&&prior.admissionAbortSignature!==signature)throw Error('Admission abort proof differs from retained proof');
  if(prior.state==='aborted')return structuredClone(prior.admissionAbortReceipt);
  const old=this.current();
  if(this.transition||prior.releaseSignature||(!old&&prior.state!=='refused')||(old&&(old.ownerId!==ownerId||!same(old,context))))throw Error('Media admission settlement is unavailable or already running');
  const work=this.inspect();if(work.activeRequests||work.gaps.length||Object.values(work.counts).some(value=>value>0))throw Error('Media admission work remains pending or unknown');
  this.transition=true;
  try{
   prior.admissionAbortSignature=signature;if(old)this.save(prior);else this.record(prior);
   const worker=this.worker();let status=old?'released':'not-acquired';
   if(prior.workerAttempted){
    if(!worker)throw Error('Original media worker admission evidence unavailable after restart');
    const receipt=await worker.request('quiescence.abortAdmission',{ownerId,context:prior,proof:context.proof});
    if(!receipt||Object.keys(receipt).sort().join(',')!==ownerReceiptKeys||receipt.ownerId!==ownerId||!['released','not-acquired'].includes(receipt.status)||['commandId','fenceId','instanceId','dataScope'].some(key=>receipt[key]!==prior[key]))throw Error('Exact media worker admission abort receipt required');
    if(!old&&receipt.status!=='not-acquired')throw Error('Worker receipt contradicts the retained media refusal');
    token(receipt.receiptId,'worker admission abort receipt');prior.workerAbortReceipt=receipt;
    // The outer gate was acquired even if its worker conclusively refused.
    status=old?'released':'not-acquired';
   }else if(worker){
    const state=await worker.request('quiescence.inspect',{});
    if(!state||state.intakeClosed!==false||!state.counts||Object.values(state.counts).some(value=>!Number.isSafeInteger(value)||value!==0))throw Error('Media worker work remains pending or unknown');
   }
   const settledWork=this.inspect();if(settledWork.activeRequests||settledWork.gaps.length||Object.values(settledWork.counts).some(value=>value>0))throw Error('Media admission work changed before abort settlement');
   const receipt={ownerId,status,receiptId:'media-admission-abort:'+createHash('sha256').update(JSON.stringify([ownerId,signature])).digest('hex'),...Object.fromEntries(['commandId','fenceId','instanceId','dataScope'].map(key=>[key,prior[key]]))};
   const settled={...prior,state:'aborted',admissionAbortReceipt:receipt};
   if(old)this.clear(settled);else this.record(settled);
   this.liveFence=undefined;return structuredClone(receipt);
  }catch(error){if(old){prior.state='unknown';this.save(prior);}throw error;}finally{this.transition=false;this.wakeIdle();}
 }
 clear(value){this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('INSERT OR REPLACE INTO receipts VALUES(?,?)').run(value.fenceId,JSON.stringify(value));this.db.prepare('DELETE FROM fence WHERE id=1').run();this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}}
 async release(ownerId,context,outcome,proof,live=false){
  if(this.transition)throw Error('Media quiescence transition running');
  const old=this.current();if(!old){const row=this.db.prepare('SELECT value FROM receipts WHERE id=?').get(context.fenceId),prior=row&&JSON.parse(row.value);if(prior?.state==='released'&&prior.ownerId===ownerId&&same(prior,context)&&prior.releaseSignature===releaseSignature(outcome,proof))return;throw Error('Exact retained media fence required');}
  if(old.ownerId!==ownerId||!same(old,context))throw Error('Exact media fence context required');
  if(outcome==='unknown'){this.liveFence=undefined;old.state='unknown';this.save(old);return;}
  const refused=proof?.kind==='admission-refused'&&Object.keys(proof).length===1&&old.state==='held'&&outcome==='unchanged'&&(old.purpose!=='service-stop'||live&&this.liveFence===old.fenceId);
  if(old.purpose==='service-stop'&&!refused)validateServiceRelease(old,outcome,proof);
  const verified=proof?.verified===true&&proof.fenceId===old.fenceId&&proof.commandId===old.commandId&&proof.dataScope===old.dataScope&&proof.outcome===outcome&&['ready','unchanged'].includes(outcome)&&((proof.instanceId===old.instanceId)===(outcome==='unchanged'))&&typeof proof.instanceId==='string'&&!!proof.instanceId&&typeof proof.receiptId==='string'&&!!proof.receiptId;
  if(!refused&&!verified)throw Error('Authoritative exact media release proof required');
  const signature=releaseSignature(outcome,proof);if(old.releaseSignature&&old.releaseSignature!==signature)throw Error('Exact retained media release proof required');
  old.releaseSignature=signature;this.save(old);this.transition=true;
  try{const worker=this.worker();if(worker){const result=await worker.request('quiescence.release',{ownerId,context:old,outcome,proof});if(result.released!==true)throw Error('Media worker release remains unconfirmed');}this.clear({...old,state:'released',outcome,releaseSignature:releaseSignature(outcome,proof)});this.liveFence=undefined;}
  catch(error){old.state='unknown';this.save(old);throw error;}finally{this.transition=false;this.wakeIdle();}
 }
 close(){this.db.close();this.lock.exec('ROLLBACK');this.lock.close();}
}
