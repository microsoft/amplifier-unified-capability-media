import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const {createMediaCapability}=await import(process.env.MEDIA_CAPABILITY_MODULE??'../src/index.js');
const session='ahp-session:/owned-call',context={account:'account',clientId:'one'};
const fence=id=>({fenceId:id,commandId:id,purpose:'recovery',instanceId:'owned',dataScope:'private'});
const pause=()=>{let release;const promise=new Promise(resolve=>release=resolve);return {promise,release}};
async function fixture(options={}){
 const directory=options.directory??await mkdtemp(join(tmpdir(),'media-lifecycle-'));let callbacks;const delegated=[],transcripts=[],connections=[];let saved={available:true,preferredModel:'gpt-live-1',fallbackModel:'gpt-realtime-2.1',voice:'marin',interruptions:true,fallbackBehavior:'stored-only',preferencesRevision:'a'.repeat(64)};
 const owner=await createMediaCapability({directory,inspectSession:async()=>({}),delegate:async args=>{delegated.push(args);return {response:'done'}},recordTranscript:async args=>{transcripts.push(args);return {recorded:true,text:args.text,nativeMessageId:args.itemId}},settings:async()=>saved,voicePreferences:async(_op,args)=>{saved={...saved,...args.patch};return {commandId:args.commandId,operation:'voice.preferences.update',status:'succeeded',replayed:false,result:saved}},resolveCredential:async()=>'owned-fixture',workerFactory:args=>{callbacks=args.callbacks;return {request:async(method,params)=>{if(method==='connect'){connections.push(params.settings);return {id:'call-'+connections.length}}if(method==='end')return {closed:true,finalized:true};if(method==='image.validate')return {width:1,height:1};return {}},close:async()=>{}}},...options});
 const attach=async(clientId='one',sid=session)=>(await owner.action({channel:sid,operation:'media.attach'},{...context,clientId})).result.lease;
 const post=async(lease,path,args={})=>{const response=await owner.handleFetch(new Request('http://fixture/media/'+path,{method:'POST',headers:{'X-Amplifier-Media-Lease':lease},body:JSON.stringify(args)}),{account:context.account});return {status:response.status,body:await response.json()}};
 return {owner,directory,attach,post,delegated,transcripts,connections,get callbacks(){return callbacks},async close(remove=true){await owner.close();if(remove)await rm(directory,{recursive:true,force:true})}};
}
async function frame(f,lease){const grant=(await f.post(lease,'computer/visual/grant',{source:{kind:'window'}})).body,command=(await f.post(lease,'computer/visual/request')).body;assert.equal((await f.post(lease,'computer/visual/complete',{requestId:command.id,grantId:grant.id,callId:null,image:'fixture-png',capturedAt:Date.now()/1000})).status,200);return {grant,command}}
async function delegate(f,lease,id='delegate'){return f.callbacks.delegate({lease,session,clientId:'one',commandId:id,text:'accepted work'})}

test('future connections read confirmed defaults while established calls exclude writes',async()=>{
 const f=await fixture();try{const lease=await f.attach();await f.post(lease,'voice/connect',{commandId:'first',sdp:'v=0'});const update=id=>({version:1,topic:'voice-preferences',channel:'ahp-root://',operation:'voice.preferences.update',commandId:id,args:{expectedRevision:'a'.repeat(64),patch:{preferredModel:'gpt-realtime-2.1',voice:'cedar'}}});
 assert.equal((await f.owner.action(update('active'),context)).accepted,false);assert.equal(f.connections[0].preferredModel,'gpt-live-1');await f.post(lease,'voice/end',{id:'call-1'});assert.equal((await f.owner.action(update('future'),context)).accepted,true);await f.post(lease,'voice/connect',{commandId:'second',sdp:'v=0'});assert.equal(f.connections[1].preferredModel,'gpt-realtime-2.1');assert.equal(f.connections[1].voice,'cedar');assert.equal(f.connections[1].fallbackBehavior,'stored-only');assert.equal(f.connections.length,2);
 }finally{await f.close()}
});

test('revoked and replaced grants cannot attach retained frames to later work',async()=>{
 for(const mode of ['revoked','replaced']){const f=await fixture();try{const lease=await f.attach();await f.post(lease,'voice/connect',{commandId:'call',sdp:'v=0'});const {grant,command}=await frame(f,lease);if(mode==='revoked')await f.post(lease,'computer/visual/revoke',{grantId:grant.id});else await f.post(lease,'computer/visual/grant',{source:{kind:'monitor'}});await delegate(f,lease);assert.equal(f.delegated[0].attachments,undefined);assert.equal((await f.post(lease,'computer/visual/result',{requestId:command.id})).status,409);
 }finally{await f.close()}}
});

test('frame selection stays bound to the originating client and conversation',async()=>{
 const f=await fixture();try{const one=await f.attach(),two=await f.attach('two'),other=await f.attach('one','ahp-session:/other');await f.post(one,'voice/connect',{commandId:'one',sdp:'v=0'});const {grant,command}=await frame(f,one);assert.equal((await f.post(two,'computer/visual/complete',{requestId:command.id,grantId:grant.id,callId:null,image:'fixture-png',capturedAt:Date.now()/1000})).status,409);assert.equal((await f.post(other,'computer/visual/result',{requestId:command.id})).status,409);await delegate(f,one);assert.equal(f.delegated[0].attachments.length,1);await delegate(f,one,'second');assert.equal(f.delegated[1].attachments,undefined);
 }finally{await f.close()}
});

test('detaching preserves provider-final transcript and refuses new delegated input',async()=>{
 let callbacks,token;const f=await fixture({workerFactory:args=>{callbacks=args.callbacks;return {request:async method=>{if(method==='connect')return {id:'owned-call'};if(method==='end'){await callbacks.transcript({lease:token,session,clientId:'one',callId:'owned-call',itemId:'final',role:'assistant',text:'Exact final text',append:false});return {closed:true,finalized:true}}return {}},close:async()=>{}}}});
 try{token=await f.attach();await f.post(token,'voice/connect',{commandId:'start',sdp:'v=0'});await f.owner.disconnect('one');await f.owner.flushTranscripts(session);assert.equal(f.transcripts.length,1);assert.equal(f.transcripts[0].text,'Exact final text');assert.equal((await f.owner.read({uri:'amplifier-media://configuration?scope='+encodeURIComponent(session)})).data.voiceTranscripts.items[0].text,'Exact final text');await assert.rejects(callbacks.delegate({lease:token,session,clientId:'one',commandId:'late',text:'new work'}),/expired|detached/);assert.equal(f.delegated.length,0);
 }finally{await f.close()}
});

test('revocation during frame validation keeps actual work busy and discards late frame',async()=>{
 const entered=pause(),done=pause();const f=await fixture({workerFactory:()=>({request:async (method,args)=>{if(method==='quiescence.acquire')return {held:true,ownerId:args.ownerId,fenceId:args.context.fenceId};if(method==='quiescence.release')return {released:true};if(method==='image.validate'){entered.release();await done.promise;return {width:1,height:1}}return {}},close:async()=>{}})});
 try{const token=await f.attach(),grant=(await f.post(token,'computer/visual/grant',{source:{kind:'window'}})).body,command=(await f.post(token,'computer/visual/request')).body;const completion=f.post(token,'computer/visual/complete',{requestId:command.id,grantId:grant.id,callId:null,image:'fixture-png',capturedAt:Date.now()/1000});await entered.promise;await f.post(token,'computer/visual/revoke',{grantId:grant.id});assert.equal(await f.owner.quiescenceParticipant().acquire(fence('in-flight')),null);done.release();assert.equal((await completion).status,409);const held=await f.owner.quiescenceParticipant().acquire(fence('settled'));assert.ok(held);await held.release('unchanged',{kind:'admission-refused'});
 }finally{done.release();await f.close()}
});

test('shutdown retains ownership until detached delegated callback finishes and refuses new effects',async()=>{
 const entered=pause(),done=pause();const f=await fixture({delegate:async()=>{entered.release();await done.promise;return {response:'accepted work completed'}}});
 try{const token=await f.attach();await f.post(token,'voice/connect',{commandId:'call',sdp:'v=0'});const work=delegate(f,token);await entered.promise;let closed=false;const closing=f.owner.close().then(()=>{closed=true});await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false);assert.equal((await f.post(token,'computer/visual/grant',{source:{kind:'window'}})).status,409);await assert.rejects(f.attach('two'),/closing/);await assert.rejects(createMediaCapability({directory:f.directory,inspectSession:async()=>({}),delegate:async()=>({}),recordTranscript:async()=>({recorded:true})}),/locked/);done.release();assert.equal((await work).response,'accepted work completed');await closing;assert.equal(closed,true);await f.owner.close();
 }finally{done.release();await f.close()}
});

test('shutdown waits for actual pending native capture before closing worker or releasing owner lock',async()=>{
 const entered=pause(),done=pause();let workerClosed=false;const f=await fixture({nativeStatus:async()=>({available:true,host:{id:'fixture-host'},hostInstanceId:'fixture-instance'}),nativeCapture:async()=>{entered.release();await done.promise;return {image:'fixture-png',capturedAt:Date.now()/1000}},workerFactory:()=>({request:async()=>({width:1,height:1}),close:async()=>{workerClosed=true}})});
 try{const token=await f.attach();await f.post(token,'computer/visual/grant',{source:{kind:'native-foreground',hostId:'fixture-host',hostInstanceId:'fixture-instance'}});const capture=f.post(token,'computer/visual/request');await entered.promise;let closed=false;const closing=f.owner.close().then(()=>{closed=true});await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false);assert.equal(workerClosed,false);await assert.rejects(createMediaCapability({directory:f.directory,inspectSession:async()=>({}),delegate:async()=>({}),recordTranscript:async()=>({recorded:true})}),/locked/);done.release();assert.equal((await capture).status,409);await closing;assert.equal(closed,true);
 }finally{done.release();await f.close()}
});

test('shutdown retains pending read callbacks in its census and rejects later callback admission',async()=>{
 const entered=pause(),done=pause();let reading=false;const f=await fixture({inspectSession:async()=>{if(reading){entered.release();await done.promise}return {}}});
 try{const token=await f.attach();await f.post(token,'voice/connect',{commandId:'call',sdp:'v=0'});reading=true;const inspection=f.callbacks.inspect({lease:token,session,clientId:'one'});await entered.promise;let closed=false;const closing=f.owner.close().then(()=>{closed=true});await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false);await assert.rejects(f.callbacks.admit({lease:token,session,clientId:'one'}),/closing/);done.release();await inspection;await closing;assert.equal(closed,true);
 }finally{done.release();await f.close()}
});

test('shutdown retains an in-flight private fence transition until its durable result settles',async()=>{
 const entered=pause(),done=pause();const f=await fixture({workerFactory:()=>({request:async(method,args)=>{if(method==='image.validate')return {width:1,height:1};if(method==='quiescence.acquire'){entered.release();await done.promise;return {held:true,ownerId:args.ownerId,fenceId:args.context.fenceId}}return {}},close:async()=>{}})});
 try{const token=await f.attach();await frame(f,token);const acquisition=f.owner.quiescenceParticipant().acquire(fence('transition'));await entered.promise;let closed=false;const closing=f.owner.close().then(()=>{closed=true});await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false);done.release();assert.ok(await acquisition);await closing;assert.equal(closed,true);
 }finally{done.release();await f.close()}
});

test('confirmed hangup is not sent again during shutdown or reclassified as an unknown lifetime',async()=>{
 let ends=0;const f=await fixture({workerFactory:()=>({request:async method=>{if(method==='connect')return {id:'call'};if(method==='end')return {closed:true,finalized:++ends===1};return {}},close:async()=>{}})});
 try{const token=await f.attach();await f.post(token,'voice/connect',{commandId:'call',sdp:'v=0'});await f.owner.disconnect('one');assert.equal(f.owner.activeCalls,0);assert.equal(f.owner.inspectQuiescence().unverifiedCalls,0);await f.owner.close();assert.equal(ends,1);const reopened=await createMediaCapability({directory:f.directory,inspectSession:async()=>({}),delegate:async()=>({}),recordTranscript:async()=>({recorded:true})});try{assert.equal(reopened.inspectQuiescence().unverifiedCalls,0)}finally{await reopened.close()}
 }finally{await f.close()}
});

test('repeated public hangup retains the confirmed result without another provider request',async()=>{
 let ends=0;const f=await fixture({workerFactory:()=>({request:async method=>{if(method==='connect')return {id:'call'};if(method==='end')return {closed:true,finalized:++ends===1,workContinues:true};return {}},close:async()=>{}})});
 try{const token=await f.attach();await f.post(token,'voice/connect',{commandId:'call',sdp:'v=0'});const first=await f.post(token,'voice/end',{id:'call'}),second=await f.post(token,'voice/end',{id:'call'});assert.equal(first.status,200);assert.deepEqual(second,first);assert.equal(ends,1);assert.equal(f.owner.inspectQuiescence().unverifiedCalls,0);assert.equal((await f.post(token,'voice/end',{id:'stale-call'})).status,409);
 }finally{await f.close()}
});
