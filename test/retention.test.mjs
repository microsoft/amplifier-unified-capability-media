import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {DatabaseSync} from 'node:sqlite';
const {createMediaCapability}=await import(process.env.RETENTION_NODE_MODULE??'../src/index.js');
test('real media owner retains uncertain transcript without starting media provider',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'retention-media-'));const forbidden=async()=>{throw Error('No model, provider or credential access')};let owner=await createMediaCapability({directory,inspectSession:forbidden,delegate:forbidden,recordTranscript:forbidden,workerFactory:forbidden});
 try{
  const db=new DatabaseSync(join(directory,'transcript-intents.sqlite'));db.prepare("INSERT INTO intents(session,call,item,role,text,append,command,status,created) VALUES(?,?,?,?,?,?,?,?,?)").run('ahp-session:/one','call','item','user','Keep this text',0,'lost','unknown','now');db.close();
  const c={fenceId:'f',commandId:'retention',purpose:'retention-hide',instanceId:'instance',dataScope:'private'},p=owner.quiescenceParticipant('actual-media');const lease=await p.acquire(c);assert.ok(lease);
  assert.deepEqual(await lease.inspectRetentionReferences({sessions:['ahp-session:/one','ahp-session:/other']}),{coverage:'complete',protected:[{session:'ahp-session:/one',reasons:['voice-transcript']}],omissions:[]});
  await lease.release('unchanged',{verified:true,...c,outcome:'unchanged',receiptId:'no-hide-protection'});
  await assert.rejects(lease.inspectRetentionReferences({sessions:['ahp-session:/one']}));
 }finally{await owner.close();await rm(directory,{recursive:true,force:true})}
});
