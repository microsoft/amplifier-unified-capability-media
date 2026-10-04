import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {DatabaseSync} from 'node:sqlite';
const {createMediaCapability}=await import(process.env.RETENTION_NODE_MODULE??'../src/index.js');
test('real media owner retains uncertain transcript without starting media provider',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'retention-media-'));const forbidden=async()=>{throw Error('No model, provider or credential access')};let owner=await createMediaCapability({directory,inspectSession:forbidden,delegate:forbidden,recordTranscript:forbidden,workerFactory:forbidden});
 try{
  const db=new DatabaseSync(join(directory,'transcript-intents.sqlite'));db.prepare("INSERT INTO intents(session,call,item,role,text,append,command,status,created) VALUES(?,?,?,?,?,?,?,?,?)").run('ahp-session:/one','call','item','user','Keep this text',0,'lost','unknown','now');db.close();
  const c={fenceId:'f',commandId:'retention',purpose:'retention-hide',instanceId:'instance',dataScope:'private'},p=owner.quiescenceParticipant('actual-media');assert.equal(await p.acquire(c),null);
  assert.equal(owner.inspectQuiescence().counts.unknownTranscripts,1);
  assert.equal(owner.inspectQuiescence().intakeClosed,false);
  await owner.close();owner=await createMediaCapability({directory,inspectSession:forbidden,delegate:forbidden,recordTranscript:forbidden,workerFactory:forbidden});
  assert.equal(await owner.quiescenceParticipant('actual-media').acquire(c),null);
  const retained=new DatabaseSync(join(directory,'transcript-intents.sqlite'),{readOnly:true});try{assert.equal(retained.prepare('SELECT text FROM intents WHERE command=?').get('lost').text,'Keep this text')}finally{retained.close()}

 }finally{await owner.close();await rm(directory,{recursive:true,force:true})}
});

test('idle retention inspector remains complete and expires on release',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'retention-media-idle-')),forbidden=async()=>{throw Error('No model, provider or credential access')},owner=await createMediaCapability({directory,inspectSession:forbidden,delegate:forbidden,recordTranscript:forbidden,workerFactory:forbidden});
 try{const c={fenceId:'idle',commandId:'idle-retention',purpose:'retention-hide',instanceId:'instance',dataScope:'private'},lease=await owner.quiescenceParticipant('actual-media').acquire(c);assert.ok(lease);assert.deepEqual(await lease.inspectRetentionReferences({sessions:['ahp-session:/one']}),{coverage:'complete',protected:[],omissions:[]});await lease.release('unchanged',{verified:true,...c,outcome:'unchanged',receiptId:'no-hide'});await assert.rejects(lease.inspectRetentionReferences({sessions:['ahp-session:/one']}))}finally{await owner.close();await rm(directory,{recursive:true,force:true})}
});
