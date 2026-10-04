import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
const {createMediaCapability}=await import(process.env.MEDIA_CAPABILITY_MODULE??'../src/index.js');
const context={account:'owned-account',clientId:'client-a',origin:'ui'},session='ahp-session:/selected';
const fence={fenceId:'held',commandId:'maintenance',purpose:'recovery',instanceId:'host',dataScope:'owned'};
const request=(operation,args={},commandId=randomUUID())=>({version:1,topic:'voice-preferences',channel:'ahp-root://',operation,commandId,args});
const base=()=>({preferredModel:'gpt-live-1',fallbackModel:'gpt-realtime-2.1',voice:'marin',interruptions:true,preferencesRevision:'a'.repeat(64),preferenceFields:['preferredModel','fallbackModel','voice','interruptions'],fallbackBehavior:'stored-only',models:[{id:'gpt-live-1',name:'Live',voices:[{id:'marin',name:'Marin'},{id:'cedar',name:'Cedar'}]}]});
const receipt=(id,result)=>({commandId:id,operation:'voice.preferences.update',status:'succeeded',replayed:false,result});
async function fixture(options={}){
 const directory=options.directory??await mkdtemp(join(tmpdir(),'media-prefs-'));const counts={workers:0,secrets:0,settings:0},changes=[];let saved=base();
 const provider=await createMediaCapability({directory,inspectSession:async()=>({title:'fixture'}),delegate:async()=>({}),recordTranscript:async()=>({recorded:true}),clientPresent:async()=>true,
  settings:async()=>{counts.settings++;return {...saved,available:false,configurable:false,credentialAccess:'disabled',apiKey:'must-not-project'}},
  resolveCredential:async()=>{counts.secrets++;throw Error('No credential access')},onChanged:(...args)=>changes.push(args),
  workerFactory:()=>{counts.workers++;return {request:async(method)=>method==='end'?{closed:true,finalized:true}:method==='connect'?{id:'call'}:{},close(){}}},
  voicePreferences:async(_operation,args)=>{saved={...saved,...args.patch,preferencesRevision:'b'.repeat(64)};return receipt(args.commandId,saved)},...options});
 return {provider,directory,counts,changes,async close(remove=true){await provider.close();if(remove)await rm(directory,{recursive:true,force:true})}};
}

test('optional preferences are host-scoped, lazy, bounded, and sanitized without credentials',async()=>{
 const f=await fixture();try{
  assert.equal(f.counts.settings,0);assert.equal(f.provider.manifest.topics['voice-preferences'].scope,'host');
  assert.equal(f.provider.actionSchemas['voice.preferences.update'].schema.properties.patch.additionalProperties,false);
  const page=await f.provider.read({uri:'amplifier-media://voice-preferences?scope=host',scope:'host'});
  assert.deepEqual(page.data.voicePreferences,base());assert(!JSON.stringify(page).includes('must-not-project'));
  const old=await f.provider.read({uri:'amplifier-media://configuration?scope='+encodeURIComponent(session)});
  assert.equal(old.data.voiceConfiguration.preferencesRevision,'a'.repeat(64));assert.equal(old.data.voiceConfiguration.configurable,false);
  await assert.rejects(f.provider.read({uri:'amplifier-media://voice-preferences',scope:session}),/host scope/);
  await assert.rejects(f.provider.action({...request('voice.preferences.update'),channel:session},context),/host-scoped/);
  assert.equal(f.counts.secrets,0);assert.equal(f.counts.workers,0);
 }finally{await f.close()}
 const absent=await fixture({voicePreferences:undefined});try{assert.equal(absent.provider.manifest.actions['voice.preferences.update'],undefined);assert.deepEqual((await absent.provider.read({uri:'amplifier-media://configuration'})).data.voiceConfiguration.preferenceFields,[])}finally{await absent.close()}
 const malformed=await fixture({settings:async()=>({...base(),preferredModel:{apiKey:'hidden'},voice:{apiKey:'hidden'},source:{apiKey:'hidden'},reason:{apiKey:'hidden'},configurable:{apiKey:'hidden'}})});
 try{const metadata=(await malformed.provider.read({uri:'amplifier-media://configuration'})).data.voiceConfiguration;assert.equal(metadata.preferredModel,'gpt-live-1');assert.equal(metadata.voice,'marin');assert.equal(metadata.configurable,false);assert(!JSON.stringify(metadata).includes('hidden'));}finally{await malformed.close()}
});

test('account journal retains exact commands across lost replies and owner restart without replay',async()=>{
 let updates=0,reads=0,original;const invoke=async(op,args)=>{if(op==='voice.preferences.receipt'){reads++;return original}updates++;original=receipt(args.commandId,{...base(),voice:'cedar',preferencesRevision:'b'.repeat(64)});throw Error('lost native acknowledgement')};
 let f=await fixture({voicePreferences:invoke});const directory=f.directory;const command=request('voice.preferences.update',{expectedRevision:'a'.repeat(64),patch:{voice:'cedar'}},'original-command');
 try{
  await assert.rejects(f.provider.action(command,context),/unknown/);assert.equal(updates,1);
  await assert.rejects(f.provider.action(command,context),/unknown/);assert.equal(updates,1);
  assert.equal((await f.provider.action(request('voice.preferences.receipt',{commandId:command.commandId}),{...context,account:'other-account'})).result,null);assert.equal(reads,0);
  await f.close(false);f=await fixture({directory,voicePreferences:invoke});
  const recovered=await f.provider.action(request('voice.preferences.receipt',{commandId:command.commandId}),{...context,clientId:'client-b'});assert.equal(recovered.result.status,'succeeded');assert.equal(recovered.result.result.voice,'cedar');
  assert.equal(updates,1);assert.equal(reads,1);
  await assert.rejects(f.provider.action({...command,args:{...command.args,patch:{voice:'marin'}}},context),/different content/);
 }finally{await f.close()}
});

test('known native preflight refusal is failed; unknown effect never becomes a known refusal',async()=>{
 for(const value of [
  {kind:'receipt',expected:false,value:{commandId:'command',operation:'voice.preferences.update',status:'failed',executed:false,replayed:false,reason:'preferences_changed',currentRevision:'c'.repeat(64)}},
  {kind:'error',expected:false,value:Object.assign(Error('unsupported'),{data:{executed:false,reason:'voice-preferences-unavailable'}})},
  {kind:'receipt',expected:'unknown',value:{commandId:'command',operation:'voice.preferences.update',status:'unknown',replayed:false}},
 ]){
  let calls=0;const f=await fixture({voicePreferences:async()=>{calls++;if(value.kind==='error')throw value.value;return value.value}});try{
   const cmd=request('voice.preferences.update',{expectedRevision:'a'.repeat(64),patch:{voice:'cedar'}},'command');
   if(value.expected==='unknown')await assert.rejects(f.provider.action(cmd,context),/unknown/);else assert.equal((await f.provider.action(cmd,context)).accepted,false);
   if(value.expected==='unknown')await assert.rejects(f.provider.action(cmd,context),/unknown/);else assert.equal((await f.provider.action(cmd,context)).accepted,false);
   assert.equal(calls,1);
  }finally{await f.close()}
 }
});

test('preference writes exclude call startup and keep whole native promise inside held intake',async()=>{
 let release,entered;const started=new Promise(resolve=>entered=resolve),wait=new Promise(resolve=>release=resolve);let updates=0;
 const f=await fixture({settings:async()=>({...base(),available:true,credentialAccess:'enabled'}),resolveCredential:async()=>'fixture',voicePreferences:async(op,args)=>{if(op.endsWith('receipt'))return null;updates++;entered();await wait;return receipt(args.commandId,{...base(),voice:'cedar'})}});
 try{
  const lease=(await f.provider.action({channel:session,operation:'media.attach'},context)).result.lease;
  const saving=f.provider.action(request('voice.preferences.update',{expectedRevision:'a'.repeat(64),patch:{voice:'cedar'}}),context);await started;
  assert.equal(await f.provider.quiescenceParticipant('media').acquire(fence),null);
  const denied=await f.provider.handleFetch(new Request('http://fixture/media/voice/connect',{method:'POST',headers:{'X-Amplifier-Media-Lease':lease},body:JSON.stringify({commandId:'call',sdp:'v=0'})}),{account:context.account});assert.equal(denied.status,409);assert.equal(f.counts.workers,0);
  release();assert.equal((await saving).accepted,true);assert.deepEqual(f.changes,[['voice-preferences','host']]);
  const held=await f.provider.quiescenceParticipant('media').acquire(fence);assert.ok(held);
  assert.equal((await f.provider.read({uri:'amplifier-media://voice-preferences?scope=host'})).topic,'voice-preferences');
  const blocked=await f.provider.action(request('voice.preferences.update',{expectedRevision:'a'.repeat(64),patch:{voice:'cedar'}}),context);assert.equal(blocked.accepted,false);assert.equal(blocked.result.executed,false);assert.equal(updates,1);
  assert.equal((await f.provider.action(request('voice.preferences.receipt',{commandId:'not-admitted'}),context)).result,null);
  await held.release('unchanged',{kind:'admission-refused'});
 }finally{release();await f.close()}
});

test('installed native adapter and media preserve shared CAS, loss recovery and held reads with no model or secret access',{skip:!process.env.MEDIA_NATIVE_ADMIN_MODULE||!process.env.MEDIA_NATIVE_PYTHON},async()=>{
 const {AdminConnection}=await import(process.env.MEDIA_NATIVE_ADMIN_MODULE);const directory=await mkdtemp(join(tmpdir(),'media-native-prefs-')),workspace=join(directory,'workspace'),home=join(directory,'home');await mkdir(workspace);await mkdir(home);const config=join(directory,'native.json');await writeFile(config,JSON.stringify({home,appHome:join(directory,'native-app'),adminWorkspaceRoots:[workspace],adminVoicePreferences:true,workerCommand:['/no/native-worker-allowed']}));
 const admin=new AdminConnection({command:process.env.MEDIA_NATIVE_PYTHON,args:['-m','amplifier_acp','--config',config],cwd:workspace,resolveWorkspace:()=>workspace});let updates=0,lost=false;
 const options={directory:join(directory,'media'),settings:()=>admin.perform('voice.configuration',{},{clientId:''}),voicePreferences:async(op,args)=>{const result=await admin.perform(op,args,{clientId:''});if(op==='voice.preferences.update'){updates++;if(args.commandId==='lost'&&!lost){lost=true;throw Error('fixture lost acknowledgement')}}return result}};
 let f=await fixture(options);
 try{
  const before=(await f.provider.read({uri:'amplifier-media://voice-preferences?scope=host'})).data.voicePreferences;
  const saved=await f.provider.action(request('voice.preferences.update',{expectedRevision:before.preferencesRevision,patch:{voice:'cedar'}},'saved'),context);assert.equal(saved.accepted,true);
  const stale=await f.provider.action(request('voice.preferences.update',{expectedRevision:before.preferencesRevision,patch:{voice:'marin'}},'stale'),context);assert.equal(stale.accepted,false);assert.equal(stale.result.reason,'preferences_changed');
  const lostCommand=request('voice.preferences.update',{expectedRevision:saved.result.result.preferencesRevision,patch:{interruptions:false}},'lost');await assert.rejects(f.provider.action(lostCommand,context),/unknown/);
  await f.close(false);f=await fixture(options);
  const recovered=await f.provider.action(request('voice.preferences.receipt',{commandId:'lost'}),context);assert.equal(recovered.result.status,'succeeded');assert.equal(recovered.result.result.interruptions,false);
  await assert.rejects(f.provider.action(lostCommand,context),/unknown/);assert.equal(updates,3);
  const mediaLease=await f.provider.quiescenceParticipant('media').acquire(fence),nativeLease=await admin.quiescenceParticipant.acquire(fence);assert.ok(mediaLease);assert.ok(nativeLease);
  assert.equal((await f.provider.action(request('voice.preferences.receipt',{commandId:'lost'}),context)).result.status,'succeeded');
  const metadata=(await f.provider.read({uri:'amplifier-media://configuration'})).data.voiceConfiguration;assert.equal(metadata.credentialAccess,'disabled');assert.equal(metadata.available,false);assert.equal(metadata.fallbackBehavior,'stored-only');
  await nativeLease.release('unchanged',{kind:'admission-refused'});await mediaLease.release('unchanged',{kind:'admission-refused'});
  assert.equal(f.counts.secrets,0);assert.equal(f.counts.workers,0);await assert.rejects(stat(join(home,'projects')));await assert.rejects(stat(join(home,'keys.env')));
  assert(!JSON.stringify(metadata).includes('apiKey'));assert.match(await readFile(join(home,'settings.yaml'),'utf8'),/interruptions: false/);
 }finally{await f.close();await admin.close();await rm(directory,{recursive:true,force:true})}
});

test('active preview and established calls refuse preference changes before the native callback',async()=>{
 let updates=0,release,entered;const started=new Promise(resolve=>entered=resolve),waiting=new Promise(resolve=>release=resolve);
 const f=await fixture({settings:async()=>({...base(),available:true,credentialAccess:'enabled'}),resolveCredential:async()=>'fixture-only',voicePreferences:async(_op,args)=>{updates++;return receipt(args.commandId,base())},workerFactory:()=>({request:async method=>{if(method==='preview'){entered();await waiting;return {audio:'fixture'}}if(method==='connect')return {id:'active-call'};return {closed:true,finalized:true}},close(){}})});
 const cmd=()=>request('voice.preferences.update',{expectedRevision:'a'.repeat(64),patch:{voice:'cedar'}});
 try{
  const lease=(await f.provider.action({channel:session,operation:'media.attach'},context)).result.lease;
  const post=async(path,args)=>f.provider.handleFetch(new Request('http://fixture/media/voice/'+path,{method:'POST',headers:{'X-Amplifier-Media-Lease':lease},body:JSON.stringify(args)}),{account:context.account});
  const preview=post('preview',{commandId:'preview',model:'gpt-live-1',voice:'marin'});await started;
  assert.equal((await f.provider.action(cmd(),context)).result.reason,'media-active');assert.equal(updates,0);release();await preview;
  await post('connect',{commandId:'call',sdp:'v=0'});assert.equal((await f.provider.action(cmd(),context)).accepted,false);assert.equal(updates,0);
  await post('end',{});assert.equal((await f.provider.action(cmd(),{...context,clientId:'',origin:'agent'})).accepted,true);assert.equal(updates,1);
 }finally{release();await f.close()}
});
