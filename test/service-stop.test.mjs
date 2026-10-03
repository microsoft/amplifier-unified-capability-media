import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawn} from 'node:child_process';import {once} from 'node:events';import {createInterface} from 'node:readline';
const identity={installationId:'installed-preview',dataScope:'private-scope',ownerId:'retained-owner',instanceId:'host-one',releaseDigest:'signed-release'};
const context=id=>({fenceId:id,commandId:'command-'+id,purpose:'service-stop',instanceId:identity.instanceId,dataScope:identity.dataScope,serviceIdentity:{...identity}});
const proof=(c,outcome='ready')=>({verified:true,fenceId:c.fenceId,commandId:c.commandId,outcome,instanceId:outcome==='ready'?'host-two':identity.instanceId,dataScope:c.dataScope,receiptId:'platform-settlement',kind:'service-lifecycle',serviceOutcome:outcome==='ready'?'resumed':'stop-refused',expected:{...identity},observed:{...identity,instanceId:outcome==='ready'?'host-two':identity.instanceId},...(outcome==='ready'?{resumeCommandId:'resume',exitReceiptId:'owned-process-exit',readyReceiptId:'authenticated-ready'}:{refusalReceiptId:'no-effect-stop'})});
import {createMediaCapability} from '../src/index.js';
const create=directory=>createMediaCapability({directory,inspectSession:async()=>({}),delegate:async()=>({}),recordTranscript:async()=>({recorded:true})});
const mutate=owner=>(()=>owner.action({channel:'ahp-session:/one',operation:'media.attach'},{account:'fixture',clientId:'client'}))();

test('service fence retains exact identity, refuses legacy proof, and permits only its live pre-effect rollback',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'service-owner-'));const owner=await create(directory);try{
  const participant=owner.quiescenceParticipant();assert.equal(participant.serviceStop.version,1);const c=context('held');const lease=await participant.acquire(c);assert.ok(lease);c.serviceIdentity.ownerId='changed-caller';assert.deepEqual(owner.inspectQuiescence().fence.serviceIdentity,identity);
  await assert.rejects(mutate(owner),/intake.*closed/);
  const correct=context('held');await assert.rejects(participant.reconcileRelease({...correct,outcome:'unchanged',proof:{kind:'admission-refused'}}),/proof|identity/);
  await assert.rejects(lease.release('unchanged',{verified:true,fenceId:c.fenceId,commandId:c.commandId,dataScope:c.dataScope,outcome:'unchanged',instanceId:identity.instanceId,receiptId:'old-update-proof'}),/proof|identity/);
  await lease.release('unchanged',{kind:'admission-refused'});await lease.release('unchanged',{kind:'admission-refused'});assert.equal(owner.inspectQuiescence().intakeClosed,false);
 }finally{await owner.close();await rm(directory,{recursive:true,force:true})}
});
test('restarted service owner preserves full identity and exact release evidence without reopening on changed proof',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'service-restart-'));let owner=await create(directory);const c=context('restart');try{
  await owner.quiescenceParticipant().acquire(c);await owner.close();owner=await create(directory);const participant=owner.quiescenceParticipant();assert.deepEqual(owner.inspectQuiescence().fence.serviceIdentity,identity);await assert.rejects(mutate(owner),/intake.*closed/);
  await assert.rejects(participant.reconcileRelease({...c,outcome:'unchanged',proof:{kind:'admission-refused'}}),/proof|identity/);
  for(const field of Object.keys(identity)){const wrong=proof(c);wrong.expected[field]='foreign';await assert.rejects(participant.reconcileRelease({...c,outcome:'ready',proof:wrong}),/proof|identity/);}
  const exact={...c,outcome:'ready',proof:proof(c)};await participant.reconcileRelease(exact);await owner.close();owner=await create(directory);await owner.quiescenceParticipant().reconcileRelease(exact);assert.equal(owner.inspectQuiescence().intakeClosed,false);
  await assert.rejects(owner.quiescenceParticipant().reconcileRelease({...exact,proof:{...exact.proof,readyReceiptId:'different'}}),/fence|proof/);assert.equal(owner.inspectQuiescence().intakeClosed,false);await mutate(owner);
 }finally{await owner.close();await rm(directory,{recursive:true,force:true})}
});
test('actual process death preserves service gate before any replacement mutation',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'service-kill-')),c=context('killed'),module=new URL('../src/index.js',import.meta.url).href;
 const code=`import {createMediaCapability} from ${JSON.stringify(module)};const directory=process.argv[1];const owner=await createMediaCapability({directory,inspectSession:async()=>({}),delegate:async()=>({}),recordTranscript:async()=>({recorded:true})});await owner.quiescenceParticipant().acquire(JSON.parse(process.argv[2]));console.log('held');setInterval(()=>{},1000);`;

 const child=spawn(process.execPath,['--input-type=module','-e',code,directory,JSON.stringify(c)],{stdio:['ignore','pipe','pipe']});child.stderr.resume();const lines=createInterface({input:child.stdout});let owner;
 try{assert.equal((await once(lines,'line'))[0],'held');child.kill('SIGKILL');await once(child,'exit');owner=await create(directory);assert.deepEqual(owner.inspectQuiescence().fence.serviceIdentity,identity);await assert.rejects(mutate(owner),/intake.*closed/);await owner.quiescenceParticipant().reconcileRelease({...c,outcome:'ready',proof:proof(c)});await mutate(owner);}finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit')}lines.close();await owner?.close();await rm(directory,{recursive:true,force:true})}
});

import {createPythonWorker} from '../src/index.js';
import {existsSync} from 'node:fs';import {fileURLToPath} from 'node:url';
const python=process.env.MEDIA_WORKER_PYTHON??fileURLToPath(new URL('../.venv/bin/python',import.meta.url));
async function workerFixture(workerFactory){
 const directory=await mkdtemp(join(tmpdir(),'service-worker-'));const owner=await createMediaCapability({directory,python,workerFactory,inspectSession:async()=>({messages:[]}),delegate:async()=>({response:'done'}),recordTranscript:async()=>({recorded:true}),resolveCredential:async()=>'',clientPresent:async()=>true});
 const session='ahp-session:/service',lease=(await owner.action({channel:session,operation:'media.attach'},{account:'fixture',clientId:'one'})).result.lease;
 const post=async(path,args={})=>{const r=await owner.handleFetch(new Request('http://owned/media/'+path,{method:'POST',headers:{'X-Amplifier-Media-Lease':lease},body:JSON.stringify(args)}),{account:'fixture'});return {status:r.status,body:await r.json()}};
 const grant=(await post('computer/visual/grant',{source:{kind:'window'}})).body,command=(await post('computer/visual/request')).body;
 const completed=await post('computer/visual/complete',{requestId:command.id,grantId:grant.id,sessionId:session,callId:null,capturedAt:Date.now()/1000,image:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'});
 return {owner,post,completed,async close(){await owner.close();await rm(directory,{recursive:true,force:true})}};
}
test('actual Python worker negotiates service identity and releases only exact proof',{skip:!existsSync(python)},async()=>{
 const f=await workerFixture(createPythonWorker);try{assert.equal(f.completed.status,200);const c=context('python-service'),lease=await f.owner.quiescenceParticipant().acquire(c);assert.ok(lease);assert.equal((await f.post('computer/visual/request')).status,409);await lease.release('ready',proof(c));await lease.release('ready',proof(c));assert.equal((await f.post('computer/visual/request')).status,200);}finally{await f.close()}
});
test('older media worker refuses before acquisition without claiming service coverage',async()=>{
 let acquired=0;const f=await workerFixture(()=>({async request(method){if(method==='quiescence.acquire')acquired++;if(method==='image.validate')return {valid:true};return {};},async close(){}}));try{assert.equal(await f.owner.quiescenceParticipant().acquire(context('old')),null);assert.equal(acquired,0);assert.equal(f.owner.inspectQuiescence().intakeClosed,false);}finally{await f.close()}
});
test('partial aggregate release retains exact proof before private worker reply is lost',async()=>{
 let releases=0;const f=await workerFixture(()=>({async request(method,params){if(method==='quiescence.inspect')return {serviceStop:{version:1}};if(method==='quiescence.acquire')return {held:true,ownerId:params.ownerId,fenceId:params.context.fenceId};if(method==='quiescence.release'){if(++releases===1)throw Error('lost release reply');return {released:true};}return {};},async close(){}}));try{const c=context('partial'),participant=f.owner.quiescenceParticipant(),lease=await participant.acquire(c);assert.ok(lease);await assert.rejects(lease.release('ready',proof(c)),/lost release reply/);assert.equal(f.owner.inspectQuiescence().intakeClosed,true);await assert.rejects(participant.reconcileRelease({...c,outcome:'ready',proof:{...proof(c),readyReceiptId:'changed'}}),/proof/);assert.equal(releases,1);await participant.reconcileRelease({...c,outcome:'ready',proof:proof(c)});assert.equal(releases,2);assert.equal(f.owner.inspectQuiescence().intakeClosed,false);}finally{await f.close()}
});
