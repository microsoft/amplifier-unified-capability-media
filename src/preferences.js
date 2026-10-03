import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {chmodSync} from 'node:fs';
import {join} from 'node:path';
const fields=['preferredModel','fallbackModel','voice','interruptions'];
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const token=(value,name)=>{if(typeof value!=='string'||!value||value.length>200||/[\x00-\x1f]/.test(value))throw Error(`A bounded ${name} is required`);return value};
const sha=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const unknown=()=>Object.assign(Error('Voice preference outcome is unknown. Inspect its original receipt; no change was replayed.'),{data:{reason:'voice-preferences-unknown'}});
const copy=value=>structuredClone(value);

/** Only public non-secret metadata crosses into the capability projection. */
export function projectPreferences(value={},writable=false){
 const result={fallbackBehavior:value.fallbackBehavior==='stored-only'?'stored-only':undefined,preferenceFields:[],models:[]};
 for(const key of ['preferredModel','fallbackModel','voice'])if(typeof value[key]==='string'&&value[key].length<=200)result[key]=value[key];
 if(typeof value.interruptions==='boolean')result.interruptions=value.interruptions;
 if(typeof value.preferencesRevision==='string'&&/^[a-f0-9]{64}$/.test(value.preferencesRevision))result.preferencesRevision=value.preferencesRevision;
 if(writable&&result.preferencesRevision&&Array.isArray(value.preferenceFields))result.preferenceFields=fields.filter(field=>value.preferenceFields.includes(field));
 if(value.models!==undefined){
  if(!Array.isArray(value.models)||value.models.length>16)throw Error('Voice model metadata exceeds its bounded contract');
  result.models=value.models.map(row=>{
   if(!row||typeof row.id!=='string'||row.id.length>200||!Array.isArray(row.voices)||row.voices.length>100)throw Error('Invalid bounded voice model metadata');
   const model={id:row.id,voices:row.voices.map(voice=>{
    if(!voice||typeof voice.id!=='string'||voice.id.length>200)throw Error('Invalid voice choice');
    return {id:voice.id,...Object.fromEntries(['name','description'].filter(key=>typeof voice[key]==='string'&&voice[key].length<=1000).map(key=>[key,voice[key]]))};
   })};
   for(const key of ['name','description','source','reference'])if(typeof row[key]==='string'&&row[key].length<=1000)model[key]=row[key];
   return model;
  });
 }
 if(Buffer.byteLength(JSON.stringify(result))>65536)throw Error('Voice preference metadata exceeds 64 KiB');
 return result;
}

/** Account-bound no-replay journal, protected by the enclosing media OS owner. */
export class VoicePreferences {
 constructor(directory,invoke,onSaved){
  this.invoke=invoke;this.onSaved=onSaved;this.pending=new Map();const path=join(directory,'voice-preferences.sqlite');this.db=new DatabaseSync(path);
  try{chmodSync(path,0o600);this.db.exec('PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;CREATE TABLE IF NOT EXISTS commands(account TEXT NOT NULL,id TEXT NOT NULL,fingerprint TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(account,id));')}catch(error){this.db.close();throw error}
 }
 row(account,id){const row=this.db.prepare('SELECT * FROM commands WHERE account=? AND id=?').get(account,id);return row&&{...row,body:JSON.parse(row.body)};}
 save(account,id,body){this.db.prepare('UPDATE commands SET body=? WHERE account=? AND id=?').run(JSON.stringify(body),account,id);}
 normalize(result,id){
  if(!result||result.commandId!==id||result.operation!=='voice.preferences.update'||result.replayed!==false||!['succeeded','failed','unknown'].includes(result.status))throw unknown();
  const receipt={commandId:id,operation:result.operation,status:result.status,replayed:false};
  if(result.status==='succeeded'){
   if(!result.result?.preferencesRevision||['preferredModel','fallbackModel','voice'].some(key=>typeof result.result[key]!=='string')||typeof result.result.interruptions!=='boolean')throw unknown();receipt.result=projectPreferences(result.result,true);if(!receipt.result.preferencesRevision)throw unknown();
  }else if(result.status==='failed'){
   if(result.executed!==false)throw unknown();receipt.executed=false;
   if(typeof result.reason==='string')receipt.reason=result.reason.slice(0,200);
   if(typeof result.error==='string')receipt.error=result.error.slice(0,1000);
   if(typeof result.currentRevision==='string'&&/^[a-f0-9]{64}$/.test(result.currentRevision))receipt.currentRevision=result.currentRevision;
  }
  return receipt;
 }
 async update(request,context){
  const id=token(request.commandId,'commandId'),account=token(context.account,'authenticated account'),args=request.args??{};
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>!['expectedRevision','patch'].includes(key)))return this.refused(id,'invalid_preferences','Unexpected voice preference argument');
  if(!/^[a-f0-9]{64}$/.test(args.expectedRevision??'')||!args.patch||typeof args.patch!=='object'||Array.isArray(args.patch)||!Object.keys(args.patch).length||Object.keys(args.patch).some(key=>!fields.includes(key)))return this.refused(id,'invalid_preferences','Review the current preference revision and choose advertised fields');
  if(Buffer.byteLength(JSON.stringify(args))>8192)return this.refused(id,'invalid_preferences','Voice preference request exceeds 8 KiB');
  const fingerprint=sha(args),key=JSON.stringify([account,id]),old=this.row(account,id);
  if(old){if(old.fingerprint!==fingerprint)throw Error('Voice preference command identity already binds different content');if(this.pending.has(key))return this.pending.get(key);return this.outcome(old.body);}
  this.db.prepare('INSERT INTO commands VALUES(?,?,?,?)').run(account,id,fingerprint,JSON.stringify({commandId:id,operation:'voice.preferences.update',status:'unknown',replayed:false}));
  const work=(async()=>{
   let receipt;
   try{receipt=this.normalize(await this.invoke('voice.preferences.update',{commandId:id,...copy(args)},context),id);}
   catch(error){
    const data=error?.data??error;
    if(data?.executed!==false)throw unknown();
    receipt={commandId:id,operation:'voice.preferences.update',status:'failed',executed:false,replayed:false,reason:typeof data.reason==='string'?data.reason:'preflight-refused',error:String(error.message??'Voice preference change was refused before execution').slice(0,1000)};
   }
   this.save(account,id,receipt);
   if(receipt.status==='succeeded'){try{Promise.resolve(this.onSaved()).catch(()=>{})}catch{/* advisory invalidation never changes a committed receipt */}}
   return this.outcome(receipt);
  })();this.pending.set(key,work);try{return await work}finally{this.pending.delete(key)}
 }
 refused(id,reason,error){return {accepted:false,result:{commandId:id,operation:'voice.preferences.update',status:'failed',executed:false,replayed:false,reason,error}};}
 outcome(receipt){if(receipt.status==='unknown')throw unknown();return {accepted:receipt.status==='succeeded',result:copy(receipt)};}
 async receipt(args,context){
  if(!args||Object.keys(args).some(key=>key!=='commandId'))throw Error('An exact voice preference commandId is required');
  const id=token(args.commandId,'commandId'),account=token(context.account,'authenticated account'),row=this.row(account,id);
  if(!row)return {accepted:true,result:null};
  if(row.body.status!=='unknown')return {accepted:true,result:copy(row.body)};
  const result=await this.invoke('voice.preferences.receipt',{commandId:id},context);
  // This is read-only during held intake. Do not rewrite private owner stores.
  return {accepted:true,result:result===null?copy(row.body):this.normalize(result,id)};
 }
 async close(){await Promise.allSettled([...this.pending.values()]);this.db.close();}
}

const text={type:'string',minLength:1,maxLength:200};
export const schemas={
 'voice.preferences.update':{description:'Save reviewed shared voice defaults with revision checking. The fallback value is stored only; it does not enable automatic transport fallback.',schema:{type:'object',additionalProperties:false,required:['expectedRevision','patch'],properties:{expectedRevision:{type:'string',pattern:'^[a-f0-9]{64}$'},patch:{type:'object',additionalProperties:false,minProperties:1,properties:{preferredModel:text,fallbackModel:text,voice:text,interruptions:{type:'boolean'}}}}}},
 'voice.preferences.receipt':{description:'Inspect the exact original voice preference command without replaying it.',schema:{type:'object',additionalProperties:false,required:['commandId'],properties:{commandId:text}}},
};
