import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,mkdir,rm,readFile,readdir,writeFile,symlink,readlink,lstat,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';

const source=process.env.MEDIA_STARTUP_MODULE_ROOT??new URL('../src/',import.meta.url).href;
const {MediaQuiescence}=await import(new URL('quiescence.js',source));
const {TranscriptQueue}=await import(new URL('transcripts.js',source));
const {VoicePreferences}=await import(new URL('preferences.js',source));
const {createMediaCapability}=await import(new URL('index.js',source));
const names={quiescence:'media-quiescence.sqlite',transcripts:'transcript-intents.sqlite',preferences:'voice-preferences.sqlite'};
const tables={quiescence:['fence','receipts','calls'],transcripts:['intents'],preferences:['commands']};
const context={fenceId:'original-fence',commandId:'original-command',purpose:'recovery',instanceId:'fixture',dataScope:'fixture'};
const inert=async()=>{throw Error('inert callback must not run');};
function open(kind,directory){
 if(kind==='quiescence')return new MediaQuiescence(directory,()=>({counts:{},gaps:[]}),()=>undefined);
 if(kind==='transcripts')return new TranscriptQueue(join(directory,names[kind]),{record:inert});
 return new VoicePreferences(directory,inert,()=>{});
}
async function image(directory){
 const result={};
 for(const name of (await readdir(directory)).filter(name=>Object.values(names).some(main=>name===main||name===main+'-wal')).sort()){
  const bytes=await readFile(join(directory,name));if(name.endsWith('-wal')&&!bytes.length)continue;
  result[name]={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
 }
 return result;
}
const config=directory=>({directory,inspectSession:async()=>({}),delegate:inert,recordTranscript:inert,workerFactory:()=>{throw Error('worker must not start');}});
test('all required Media tables refuse read-only without implicit repair and release ownership',async()=>{
 for(const [kind,required] of Object.entries(tables))for(const table of required){
  const directory=await mkdtemp(join(tmpdir(),'media-schema-'));
  try{
   await open(kind,directory).close();const path=join(directory,names[kind]);
   const db=new DatabaseSync(path);db.exec('DROP TABLE '+table);db.close();const before=await image(directory);
   for(let attempt=0;attempt<2;attempt++)assert.throws(()=>open(kind,directory),/authority schema is incomplete/);
   assert.deepEqual(await image(directory),before);
  }finally{await rm(directory,{recursive:true,force:true});}
 }
});
test('required referenced columns refuse before writable open',async()=>{
 for(const kind of Object.keys(names)){
  const directory=await mkdtemp(join(tmpdir(),'media-column-'));
  try{
   await open(kind,directory).close();const db=new DatabaseSync(join(directory,names[kind]));
   const [table,column]={quiescence:['fence','value'],transcripts:['intents','text'],preferences:['commands','body']}[kind];
   db.exec('ALTER TABLE '+table+' RENAME COLUMN '+column+' TO missing_column');db.close();
   const before=await image(directory);assert.throws(()=>open(kind,directory),/authority schema is incomplete/);assert.deepEqual(await image(directory),before);
  }finally{await rm(directory,{recursive:true,force:true});}
 }
});
test('absent main with even empty sidecar refuses; dangling main and sidecars are not fresh',async()=>{
 for(const kind of Object.keys(names))for(const suffix of ['', '-wal','-shm','-journal'])for(const dangling of [false,true]){
  if(!suffix&&!dangling)continue;
  const directory=await mkdtemp(join(tmpdir(),'media-orphan-'));
  try{
   const main=join(directory,names[kind]),path=main+suffix,target=join(directory,'missing-target');
   await writeFile(join(directory,'sentinel'),'preserve');
   if(dangling)await symlink(target,path);else await writeFile(path,'');
   for(let attempt=0;attempt<2;attempt++)assert.throws(()=>open(kind,directory));
   if(dangling){assert.equal(await readlink(path),target);assert.ok((await lstat(path)).isSymbolicLink());await assert.rejects(lstat(target),{code:'ENOENT'});}
   else assert.equal((await readFile(path)).length,0);
   if(suffix)await assert.rejects(lstat(main),{code:'ENOENT'});
   assert.equal(await readFile(join(directory,'sentinel'),'utf8'),'preserve');
  }finally{await rm(directory,{recursive:true,force:true});}
 }
});
test('normal restart preserves unknown authority and legitimately released empty fences',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'media-reopen-'));
 try{
  let gate=open('quiescence',directory);await(await gate.participant().acquire(context)).release('unchanged',{kind:'admission-refused'});gate.close();
  gate=open('quiescence',directory);assert.equal(await gate.effect(()=>42),42);await assert.rejects(gate.participant().acquire(context),/cannot be acquired again/);gate.close();
  let attempts=0,queue=new TranscriptQueue(join(directory,names.transcripts),{record:async()=>{attempts++;throw Error('inert unknown');}});
  const entry={session:'fixture',callId:'call',itemId:'item',role:'user',text:'unknown',append:false,commandId:'original'};
  queue.enqueue(entry);await queue.flush('fixture');await queue.close();
  queue=new TranscriptQueue(join(directory,names.transcripts),{record:async()=>{attempts++;throw Error('must not replay');}});
  queue.enqueue({...entry,itemId:'later',commandId:'later'});await queue.flush('fixture');assert.equal(attempts,1);assert.equal(queue.unknownCount(),1);await queue.close();
  let invokes=0,prefs=new VoicePreferences(directory,async()=>{invokes++;throw Error('inert unknown');},()=>{});
  const request={commandId:'original',args:{expectedRevision:'a'.repeat(64),patch:{voice:'fixture'}}},account={account:'fixture'};
  await assert.rejects(prefs.update(request,account),/unknown/);await prefs.close();
  prefs=new VoicePreferences(directory,async()=>{invokes++;throw Error('must not replay');},()=>{});await assert.rejects(prefs.update(request,account),/unknown/);assert.equal(invokes,1);await prefs.close();
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('missing confirmed history rebuilds only projection and retains unknown intent barrier',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'media-history-'));
 try{
  const path=join(directory,names.transcripts);let attempts=0;
  let queue=new TranscriptQueue(path,{record:async entry=>{attempts++;if(entry.callId==='unknown')throw Error('uncertain');return {recorded:true,nativeMessageId:'native-confirmed',text:entry.text};}});
  const entry={session:'fixture',callId:'confirmed',itemId:'item',role:'user',text:'confirmed',append:false,commandId:'confirmed'};
  queue.enqueue(entry);await queue.flush('fixture');queue.enqueue({...entry,callId:'unknown',commandId:'unknown'});await queue.flush('fixture');assert.equal(queue.history('fixture').length,1);await queue.close();
  const db=new DatabaseSync(path);db.exec('DROP TABLE history');db.close();
  queue=new TranscriptQueue(path,{record:async()=>{attempts++;throw Error('must not replay');}});
  assert.deepEqual(queue.history('fixture'),[]);assert.equal(queue.unknownCount(),1);await queue.flush('fixture');assert.equal(attempts,2);await queue.close();
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('configured stores validate before quiescence writes; disabled preferences remain optional',async()=>{
 for(const kind of ['transcripts','preferences']){
  const directory=await mkdtemp(join(tmpdir(),'media-composed-'));
  try{
   let owner=await createMediaCapability({...config(directory),voicePreferences:inert});
   await owner.quiescenceParticipant().acquire(context);await owner.close();
   const db=new DatabaseSync(join(directory,names[kind]));db.exec('DROP TABLE '+tables[kind][0]);db.close();
   const before=await image(directory);
   for(let attempt=0;attempt<2;attempt++)await assert.rejects(createMediaCapability({...config(directory),voicePreferences:inert}),/authority schema is incomplete/);
   assert.deepEqual(await image(directory),before);
   if(kind==='preferences'){owner=await createMediaCapability(config(directory));assert.equal(owner.inspectQuiescence().intakeClosed,true);await owner.close();}
  }finally{await rm(directory,{recursive:true,force:true});}
 }
});
test('actual interrupted Media owners preserve main and nonempty WAL on schema and orphan refusal',async()=>{
 for(const kind of Object.keys(names)){
  const directory=await mkdtemp(join(tmpdir(),'media-crash-'));
  try{
   const path=join(directory,names[kind]),table=tables[kind][0];
   const child=spawnSync(process.execPath,['--input-type=module','-e',`
    import {DatabaseSync} from 'node:sqlite';import {join} from 'node:path';
    const source=${JSON.stringify(source)},directory=${JSON.stringify(directory)},kind=${JSON.stringify(kind)};
    const {MediaQuiescence}=await import(new URL('quiescence.js',source));
    const {TranscriptQueue}=await import(new URL('transcripts.js',source));
    const {VoicePreferences}=await import(new URL('preferences.js',source));
    if(kind==='quiescence'){const owner=new MediaQuiescence(directory,()=>({counts:{},gaps:[]}),()=>undefined);await owner.participant().acquire(${JSON.stringify(context)});owner.call('prior-inert-call','active');}
    if(kind==='transcripts'){const owner=new TranscriptQueue(join(directory,'transcript-intents.sqlite'),{record:async()=>{throw Error('uncertain');}});owner.enqueue({session:'fixture',callId:'call',itemId:'item',role:'user',text:'unknown',append:false,commandId:'original'});await owner.flush('fixture');}
    if(kind==='preferences'){const owner=new VoicePreferences(directory,async()=>{throw Error('uncertain');},()=>{});try{await owner.update({commandId:'original',args:{expectedRevision:'a'.repeat(64),patch:{voice:'fixture'}}},{account:'fixture'});}catch{}}
    const db=new DatabaseSync(${JSON.stringify(path)});db.exec('DROP TABLE '+${JSON.stringify(table)});
    process.kill(process.pid,'SIGKILL');
   `],{encoding:'utf8',timeout:10000});
   assert.equal(child.signal,'SIGKILL',child.stderr);const before=await image(directory);assert.ok(before[names[kind]+'-wal'].bytes>0);
   for(let attempt=0;attempt<2;attempt++)assert.throws(()=>open(kind,directory),/authority schema is incomplete/);
   assert.deepEqual(await image(directory),before);
   await unlink(path);const orphan=await image(directory);
   assert.throws(()=>open(kind,directory),/main database is missing/);assert.deepEqual(await image(directory),orphan);await assert.rejects(lstat(path),{code:'ENOENT'});
  }finally{await rm(directory,{recursive:true,force:true});}
 }
});
