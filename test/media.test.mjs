import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createMediaCapability} from '../src/index.js';
const session='ahp-session:/one';
test('passive voice projections need no credential grant and start no worker',async()=>{
 let secrets=0;
 const f=await fixture({settings:async()=>({available:false,credentialAccess:'disabled',configurable:false,reason:'Voice credentials are disabled by the launcher.'}),
  resolveCredential:async()=>{secrets++;throw Error('Voice credentials require explicit trusted launcher enablement');}});
 try{
  const projection=(await f.provider.read({uri:'amplifier-media://configuration?scope=host'})).data.voiceConfiguration;
  assert.equal(projection.available,false);assert.equal(projection.configurable,false);assert.equal(projection.credentialAccess,'disabled');
  assert.match(projection.reason,/turned off/);
  const result=await f.provider.action({channel:session,operation:'voice.configuration'},{clientId:'a',account:'user'});
  assert.deepEqual(result.result,projection);
  const lease=await f.attach();
  assert.equal((await f.post(lease,'voice/config')).body.available,false);
  assert.equal(secrets,0);assert.equal(f.calls.length,0);
  assert.equal((await f.post(lease,'voice/connect',{commandId:'denied',sdp:'v=0'})).status,403);
  assert.equal(secrets,0);assert.equal(f.calls.length,0);
 }finally{await f.close();}
});
test('voice availability is sanitized owner metadata; unknown availability never probes a secret',async()=>{
 for(const settings of [{},{available:false},{available:true,source:'native',credentialAccess:'enabled',apiKey:'must-not-project'}]){
  const f=await fixture({settings:async()=>settings,resolveCredential:async()=>{throw Error('Passive secret read');}});
  try{
   const row=(await f.provider.read({uri:'amplifier-media://configuration?scope=host'})).data.voiceConfiguration;
   assert.equal(row.available,settings.available===true);assert.equal(row.reason===null,settings.available===true);
   assert.ok(!JSON.stringify(row).includes('must-not-project'));
  }finally{await f.close();}
 }
});
async function fixture(options={}){const directory=await mkdtemp(join(tmpdir(),'owned-media-')),calls=[];let callbacks;const provider=await createMediaCapability({directory,inspectSession:async()=>({title:'Selected',messages:[]}),delegate:async()=>({response:'done'}),recordTranscript:async()=>({recorded:true}),settings:async()=>({available:true,credentialAccess:'enabled'}),resolveCredential:async()=>'fixture-private-key',clientPresent:async()=>true,workerFactory:config=>{callbacks=config.callbacks;return {async request(method,args){calls.push([method,args]);if(method==='connect')return {id:'call-'+args.clientId,sessionId:args.session,sdp:'answer-sensitive',provider:'live'};if(method==='end')return {closed:true,finalized:true,workContinues:true};if(method==='image.validate'){if(args.image!=='fixture-png')throw Error('Invalid PNG');return {width:1,height:1}}return {ready:true}},close(){}}},...options});
const attach=async(clientId='a',account='user',sid=session)=>(await provider.action({channel:sid,operation:'media.attach',commandId:'attach'},{clientId,account})).result.lease;
const post=async(token,path,args={},account='user')=>{const response=await provider.handleFetch(new Request('http://fixture/media/'+path,{method:'POST',headers:{'X-Amplifier-Media-Lease':token},body:JSON.stringify(args)}),{account});return {status:response.status,body:await response.json()}};
return {provider,calls,directory,attach,post,get callbacks(){return callbacks},async close(){await provider.close();await rm(directory,{recursive:true,force:true})}}}
test('parallel clients own independent calls; account and session cannot borrow lease',async()=>{const f=await fixture();try{const a=await f.attach(),b=await f.attach('b');assert.notEqual(a,b);assert.equal((await f.post(a,'voice/connect',{commandId:'a',sdp:'v=0-sensitive',sessionId:session})).status,200);assert.equal((await f.post(b,'voice/connect',{commandId:'b',sdp:'v=0',sessionId:session})).status,200);assert.equal(f.provider.activeCalls,2);assert.equal((await f.post(a,'voice/status',{},'other')).status,403);assert.equal((await f.post(a,'voice/status',{sessionId:'ahp-session:/other'})).status,403);assert.equal((await f.post(a,'voice/end',{id:'call-a'})).body.workContinues,true);assert.equal(f.provider.activeCalls,1);const receipts=await Promise.all((await readdir(join(f.directory,'receipts'))).map(name=>readFile(join(f.directory,'receipts',name),'utf8')));assert(!receipts.join('').includes('sensitive'));assert(!receipts.join('').includes('fixture-private-key'));}finally{await f.close()}});
test('unknown connect is durable before send and never replayed',async()=>{let attempts=0;const f=await fixture({workerFactory:()=>({async request(){attempts++;throw Error('transport gone')},close(){}})});try{const a=await f.attach();assert.equal((await f.post(a,'voice/connect',{commandId:'same',sdp:'v=0'})).status,502);assert.equal((await f.post(a,'voice/connect',{commandId:'same',sdp:'v=0'})).status,409);assert.equal(attempts,1)}finally{await f.close()}});
test('snapshot requires owned grant, explicit request and valid fresh PNG',async()=>{const f=await fixture();try{const a=await f.attach(),b=await f.attach('b');const grant=(await f.post(a,'computer/visual/grant',{sessionId:session,source:{kind:'window'}})).body;assert.equal((await f.post(b,'computer/visual/complete',{grantId:grant.id})).status,409);const command=(await f.post(a,'computer/visual/request',{sessionId:session})).body;const target={requestId:command.id,grantId:grant.id,sessionId:session,callId:null,capturedAt:Date.now()/1000};assert.equal((await f.post(a,'computer/visual/complete',{...target,image:'bad'})).status,502);assert.equal((await f.post(a,'computer/visual/complete',{...target,image:'fixture-png'})).status,200);const saved=(await f.post(a,'computer/visual/result',{requestId:command.id})).body;assert.match(saved.resourceUri,/^amplifier-media:/);const image=await f.provider.resourceProvider.read({uri:saved.resourceUri,encoding:'base64'});assert.equal(image.contentType,'image/png');await f.post(a,'computer/visual/revoke',{grantId:grant.id});assert.equal((await f.post(a,'computer/visual/result',{requestId:command.id})).status,409)}finally{await f.close()}});
test('known busy transcript is retained and retries same identity; no prose execution',async()=>{let attempts=0;const f=await fixture({recordTranscript:async()=>++attempts===1?{recorded:false,reason:'busy',retryable:true,executed:false}:{recorded:true}});try{const lease=await f.attach();await f.post(lease,'voice/connect',{commandId:'start',sdp:'v=0'});assert.equal((await f.callbacks.transcript({lease,session,clientId:'a',callId:'call-a',itemId:'u1',role:'user',text:'keep',append:false})).durability,'pending');await f.provider.flushTranscripts(session);await f.provider.flushTranscripts(session);assert.equal(attempts,2);assert.equal((await f.provider.read({uri:'amplifier-media://configuration?scope='+encodeURIComponent(session)})).data.voiceTranscripts.items.length,1)}finally{await f.close()}});
test('detach revokes device grants without cancelling admitted agent work',async()=>{const f=await fixture();try{const lease=await f.attach();await f.post(lease,'voice/connect',{commandId:'start',sdp:'v=0'});await f.provider.disconnect('a');assert.equal((await f.post(lease,'voice/status')).status,409);assert(f.calls.some(([method])=>method==='end'))}finally{await f.close()}});
test('body limits and unavailable native adapter remain explicit',async()=>{const f=await fixture();try{const lease=await f.attach();assert.equal((await f.post(lease,'voice/connect',{sdp:'x'.repeat(750001)})).status,413);const native=(await f.post(lease,'computer/visual/native/status')).body;assert.equal(native.available,false);assert.equal(native.host.label,'This host')}finally{await f.close()}});

test('voice settings exclude active calls, previews, and concurrent media startup',async()=>{let configured=0,release;const f=await fixture({configure:async()=>{configured++;return {}},workerFactory:()=>({request:async(method)=>{if(method==='preview')await new Promise(resolve=>{release=resolve});return method==='connect'?{id:'active'}:{}},close(){}})});try{const a=await f.attach(),b=await f.attach('b');const preview=f.post(a,'voice/preview',{commandId:'preview'});while(!release)await new Promise(resolve=>setTimeout(resolve,1));assert.equal((await f.post(b,'voice/configure',{source:'private',apiKey:'fixture'})).status,409);release();await preview;assert.equal((await f.post(b,'voice/configure',{source:'private',apiKey:'fixture'})).status,200);await f.post(a,'voice/connect',{commandId:'connect'});assert.equal((await f.post(b,'voice/configure',{source:'private',apiKey:'fixture'})).status,409);await f.post(a,'voice/end');assert.equal((await f.post(b,'voice/configure',{source:'private',apiKey:'fixture'})).status,200);assert.equal(configured,2);}finally{await f.close()}});

test('late delegated results enter canonical transcript once without replay, even after detach',async()=>{
 let release,delegated=0;const records=[];
 const f=await fixture({delegate:async()=>{delegated++;await new Promise(resolve=>{release=resolve});return {completed:true,generation_id:'generation',text:'Verified final answer'}},recordTranscript:async row=>{records.push(row);return {recorded:true,text:row.text}}});
 try{
  const lease=await f.attach();await f.post(lease,'voice/connect',{commandId:'connect',sdp:'v=0'});
  const args={lease,session,clientId:'a',commandId:'voice:call-a:delegation',text:'Do work',delivery:{version:1,callId:'call-a',sourceItemIds:['utterance']}};
  const work=f.callbacks.delegate(args);while(!release)await new Promise(resolve=>setTimeout(resolve,1));
  await f.provider.disconnect('a');release();await work;
  await f.callbacks.fallback(args);await f.provider.flushTranscripts(session);await f.callbacks.fallback(args);await f.provider.flushTranscripts(session);
  assert.equal(delegated,1);assert.equal(records.length,1);assert.equal(records[0].text,'Verified final answer');assert.equal(records[0].callId,'call-a');
  assert.equal((await f.callbacks.fallback({...args,commandId:'not-admitted'})).recorded,false);
 }finally{await f.close()}
});
