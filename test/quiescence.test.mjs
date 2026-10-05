import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawn} from 'node:child_process';import {once} from 'node:events';import {createInterface} from 'node:readline';
import {createMediaCapability,createPythonWorker} from '../src/index.js';
import {existsSync} from 'node:fs';import {fileURLToPath} from 'node:url';
const python=process.env.MEDIA_WORKER_PYTHON??fileURLToPath(new URL('../.venv/bin/python',import.meta.url));
const session='ahp-session:/media-proof',context=id=>({fenceId:id,commandId:'command-'+id,purpose:'recovery',instanceId:'host-one',dataScope:'media-private'}),proof=c=>({verified:true,fenceId:c.fenceId,commandId:c.commandId,outcome:'unchanged',instanceId:c.instanceId,dataScope:c.dataScope,receiptId:'verified-recovery'});
const pause=()=>{let release;const promise=new Promise(resolve=>release=resolve);return {promise,release}};
async function fixture(options={}){
 const directory=options.directory??await mkdtemp(join(tmpdir(),'media-quiescence-'));let callbacks;const calls=[];
 const config={directory,inspectSession:async()=>({messages:[]}),delegate:async()=>({response:'done'}),recordTranscript:async()=>({recorded:true}),resolveCredential:async()=>'',clientPresent:async()=>true,workerFactory:args=>{callbacks=args.callbacks;return {async request(method,params){calls.push(method);if(method==='quiescence.acquire')return {held:true,ownerId:params.ownerId,fenceId:params.context.fenceId};if(method==='quiescence.release')return {released:true};if(method==='connect')return {id:'call-'+params.clientId};if(method==='end')return {closed:true,finalized:true};return {};},async close(){}};},...options};
 const owner=await createMediaCapability(config);const attach=async(clientId='one')=>(await owner.action({channel:session,operation:'media.attach'},{account:'account',clientId})).result.lease;
 const post=async(lease,path,args={})=>{const result=await owner.handleFetch(new Request('http://owned/media/'+path,{method:'POST',headers:{'X-Amplifier-Media-Lease':lease},body:JSON.stringify(args)}),{account:'account'});return {status:result.status,body:await result.json()}};
 return {owner,directory,config,calls,attach,post,get callbacks(){return callbacks},async close(){await owner.close();if(!options.directory)await rm(directory,{recursive:true,force:true})}};
}

test('idle attachment and granted local source are not active work; held owner blocks effects but preserves selected reads',async()=>{
 const f=await fixture();try{
  const token=await f.attach(),grant=(await f.post(token,'computer/visual/grant',{source:{kind:'window'}})).body;
  const c=context('idle'),lease=await f.owner.quiescenceParticipant().acquire(c);assert.ok(lease);assert.equal(f.calls.length,0);
  await assert.rejects(f.attach('other'),/intake is closed/);assert.equal((await f.post(token,'voice/connect',{commandId:'never',sdp:'v=0'})).status,409);
  assert.equal((await f.post(token,'computer/visual/request')).status,409);assert.equal((await f.post(token,'voice/status')).status,200);assert.equal((await f.post(token,'voice/config')).status,200);
  assert.equal((await f.owner.read({uri:'amplifier-media://configuration?scope='+encodeURIComponent(session)})).topic,'voice');
  await lease.release('unchanged',proof(c));assert.equal((await f.post(token,'computer/visual/request')).status,200);
  assert.equal(await f.owner.quiescenceParticipant().acquire(context('capture-pending')),null);
  await f.post(token,'computer/visual/revoke',{grantId:grant.id});assert.ok(await f.owner.quiescenceParticipant().acquire(context('revoked')));
 }finally{await f.close();}
});

test('live calls and delegated work continuing after hangup are both retained',async()=>{
 const entered=pause(),done=pause(),f=await fixture({delegate:async()=>{entered.release();await done.promise;return {response:'settled'}}});
 try{
  const token=await f.attach();await f.post(token,'voice/connect',{commandId:'connect',sdp:'v=0'});assert.equal(await f.owner.quiescenceParticipant().acquire(context('live')),null);
  const work=f.callbacks.delegate({lease:token,session,clientId:'one',commandId:'delegate',text:'owned work'});await entered.promise;
  await f.post(token,'voice/end',{id:'call-one'});assert.equal(f.owner.activeCalls,0);assert.equal(await f.owner.quiescenceParticipant().acquire(context('delegate-active')),null);
  done.release();await work;assert.ok(await f.owner.quiescenceParticipant().acquire(context('settled')));
 }finally{done.release();await f.close();}
});

test('known-busy transcript intent prevents quiescence; its confirmed drain permits it',async()=>{
 let ready=false;const f=await fixture({recordTranscript:async()=>ready?{recorded:true}:{recorded:false,executed:false,retryable:true,reason:'busy'}});
 try{
  const token=await f.attach();await f.post(token,'voice/connect',{commandId:'connect',sdp:'v=0'});await f.post(token,'voice/end',{id:'call-one'});
  await f.callbacks.transcript({lease:token,session,clientId:'one',callId:'call-one',itemId:'input-one',role:'user',text:'retained',append:false});await f.owner.flushTranscripts(session);
  assert.equal(f.owner.inspectQuiescence().counts.pendingTranscripts,1);assert.equal(await f.owner.quiescenceParticipant().acquire(context('pending-transcript')),null);
  ready=true;await f.owner.flushTranscripts(session);assert.ok(await f.owner.quiescenceParticipant().acquire(context('recorded')));
 }finally{await f.close();}
});

test('unknown provider call lifetime is distinct from an old command receipt and survives restart',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'media-call-lifetime-'));let f=await fixture({directory,workerFactory:()=>({async request(){throw Error('Call creation acknowledgement lost')},async close(){}})});
 try{
  const token=await f.attach();assert.equal((await f.post(token,'voice/connect',{commandId:'uncertain',sdp:'v=0'})).status,502);assert.equal(await f.owner.quiescenceParticipant().acquire(context('unverified-call')),null);
  assert.deepEqual(f.owner.inspectQuiescence().gaps,['prior-provider-call-lifetime-unverified']);await f.close();f=await fixture({directory});assert.equal(f.owner.inspectQuiescence().unverifiedCalls,1);assert.equal(await f.owner.quiescenceParticipant().acquire(context('after-restart')),null);
 }finally{await f.close();await rm(directory,{recursive:true,force:true});}
});

test('confirmed provider close survives repeated cleanup; a new call requires its own confirmation',async()=>{
 let ends=0;const f=await fixture({workerFactory:()=>({async request(method){if(method==='connect')return {id:'call-one'};if(method==='end')return {closed:true,finalized:++ends===1};return {};},async close(){}})});
 try{
  const lease=await f.attach();await f.post(lease,'voice/connect',{commandId:'one',sdp:'v=0'});
  await f.post(lease,'voice/end',{id:'call-one'});await f.post(lease,'voice/end',{id:'call-one'});
  assert.equal(f.owner.inspectQuiescence().unverifiedCalls,0);
  await f.post(lease,'voice/connect',{commandId:'two',sdp:'v=0'});
  await f.post(lease,'voice/end',{id:'call-one'});
  assert.equal(f.owner.inspectQuiescence().unverifiedCalls,1);
 }finally{await f.close();}
});

test('provider close callback remains authoritative when a retired worker cannot confirm again',async()=>{
 let callbacks;const f=await fixture({workerFactory:options=>{callbacks=options.callbacks;return {async request(method){return method==='connect'?{id:'call-one'}:{closed:true,finalized:false}},async close(){}}}});
 try{
  const lease=await f.attach();await f.post(lease,'voice/connect',{commandId:'one',sdp:'v=0'});
  await callbacks.status({lease,session,clientId:'one',status:{status:'ended',finalized:true}});
  await callbacks.status({lease,session,clientId:'one',status:{status:'ended',finalized:false}});
  await f.post(lease,'voice/end',{id:'call-one'});
  assert.equal(f.owner.inspectQuiescence().unverifiedCalls,0);
  await f.owner.disconnect('one');assert.equal(f.owner.inspectQuiescence().unverifiedCalls,0);
 }finally{await f.close();}
});

test('actual owner process death retains unknown gate and exact proof releases without recreating media',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'media-gate-crash-')),c=context('crashed');
 const module=new URL('../src/index.js',import.meta.url).href;
 const script=`import {createMediaCapability} from ${JSON.stringify(module)};const owner=await createMediaCapability({directory:process.argv[1],inspectSession:async()=>({}),delegate:async()=>({}),recordTranscript:async()=>({recorded:true})});await owner.quiescenceParticipant().acquire(JSON.parse(process.argv[2]));console.log('held');setInterval(()=>{},1000);`;
 const child=spawn(process.execPath,['--input-type=module','-e',script,directory,JSON.stringify(c)],{stdio:['ignore','pipe','pipe']});child.stderr.resume();const lines=createInterface({input:child.stdout});let f;
 try{
  assert.equal((await once(lines,'line'))[0],'held');child.kill('SIGKILL');await once(child,'exit');lines.close();f=await fixture({directory});assert.equal(f.owner.inspectQuiescence().fence.state,'unknown');await assert.rejects(f.attach(),/intake is closed/);
  await assert.rejects(f.owner.quiescenceParticipant().reconcileRelease({...c,outcome:'unchanged',proof:{...proof(c),commandId:'foreign'}}),/proof/);
  await f.owner.quiescenceParticipant().reconcileRelease({...c,outcome:'unchanged',proof:proof(c)});assert.equal(f.owner.inspectQuiescence().intakeClosed,false);assert.ok(await f.attach());assert.equal(f.calls.length,0);
 }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit')}lines.close();await f?.close();await rm(directory,{recursive:true,force:true});}
});

test('a second owner cannot claim independent idle authority over the same media directory',async()=>{
 const f=await fixture();try{await assert.rejects(createMediaCapability(f.config),/locked/);assert.ok(await f.owner.quiescenceParticipant().acquire(context('single-owner')));}finally{await f.close();}
});

test('actual Python worker and Node participant hold and release together after immutable frame validation',{skip:!existsSync(python)},async()=>{
 let notices=0;const f=await fixture({python,workerFactory:createPythonWorker,onMayBeIdle:()=>{notices++;}});
 try{
  const token=await f.attach(),grant=(await f.post(token,'computer/visual/grant',{source:{kind:'window'}})).body,command=(await f.post(token,'computer/visual/request')).body;
  assert.equal((await f.post(token,'computer/visual/complete',{requestId:command.id,grantId:grant.id,sessionId:session,callId:null,capturedAt:Date.now()/1000,image:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'})).status,200);
  await new Promise(r=>setTimeout(r,10));assert.ok(notices>0);
  const c=context('actual-worker'),lease=await f.owner.quiescenceParticipant().acquire(c);assert.ok(lease);assert.equal((await f.post(token,'computer/visual/request')).status,409);
  assert.equal((await f.post(token,'computer/visual/result',{requestId:command.id})).status,200);await lease.release('unchanged',proof(c));assert.equal((await f.post(token,'computer/visual/request')).status,200);
 }finally{await f.close();}
});
