import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {createHash,randomUUID} from 'node:crypto';
const {createMediaCapability}=await import(process.env.MEDIA_CAPABILITY_MODULE??'../src/index.js');
const available=process.env.MEDIA_NATIVE_PYTHON&&process.env.MEDIA_NATIVE_HOST_MODULE;
const setup=String.raw`
import importlib.util,json,sys
from pathlib import Path
p=Path(sys.argv[1]); home=p/'native-home';home.mkdir();provider=p/'provider';provider.mkdir()
(provider/'pyproject.toml').write_text('[project]\nname="amplifier-module-provider-media-fixture"\nversion="0.1.0"\n')
module=provider/'amplifier_module_provider_media_fixture';module.mkdir()
(module/'__init__.py').write_text('''from pathlib import Path
from amplifier_core.models import ProviderInfo
class Provider:
    name='fixture'
    def parse_tool_calls(self,response):return []
    def get_info(self):return ProviderInfo(id='fixture',display_name='Offline media fixture',defaults={'model':'fixture','max_tokens':4096},capabilities=['tools'])
    async def list_models(self):return [{'id':'fixture'}]
    async def complete(self,request,**kwargs):
        Path(__file__).with_name('forbidden-model-call').write_text('called')
        raise RuntimeError('No model call is authorized in this preservation fixture')
async def mount(coordinator,config=None):await coordinator.mount('providers',Provider(),name='fixture')
''')
context=Path(importlib.util.find_spec('amplifier_module_context_simple').origin).parent
bundle=p/'fixture.yaml';bundle.write_text('bundle:\n  name: media-fixture\n  version: 1.0.0\nsession:\n  orchestrator:\n    module: loop-live\n  context:\n    module: context-simple\n    source: '+str(context)+'\nproviders:\n  - module: provider-media-fixture\n    source: '+str(provider)+'\n')
(home/'settings.yaml').write_text('bundle:\n  app: []\n')
(p/'native.json').write_text(json.dumps({'home':str(home),'appHome':str(p/'native-app'),'bundle':str(bundle),'startupTimeout':90,'adminWorkspaceRoots':[str(p/'workspace')]}))
`;

test('installed native Core/Foundation writer retains exact transcripts across reconnect and owner/host restart without a prompt',{skip:!available,timeout:120000},async()=>{
 const {createHost}=await import(process.env.MEDIA_NATIVE_HOST_MODULE),require=createRequire(process.env.MEDIA_NATIVE_HOST_MODULE),{WebSocket}=require('ws');
 const directory=await mkdtemp(join(tmpdir(),'media-native-preservation-')),workspace=join(directory,'workspace');await mkdir(workspace);
 const made=spawnSync(process.env.MEDIA_NATIVE_PYTHON,['-c',setup,directory],{encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});assert.equal(made.status,0,made.stderr);
 const session='ahp-session:/'+randomUUID(),context={account:'owned',clientId:'first'};let host,media,socket,callbacks,token,busy=false,writes=[],finalSent=false;
 const openHost=async()=>createHost({stateDirectory:join(directory,'host'),allowedWorkspaceRoots:[workspace],engines:[{id:'amplifier',label:'Actual installed native',command:process.env.MEDIA_NATIVE_PYTHON,args:['-m','amplifier_acp','--config',join(directory,'native.json')],env:{PYTHONDONTWRITEBYTECODE:'1'}}]});
 const openMedia=async()=>createMediaCapability({directory:join(directory,'media'),inspectSession:async()=>({}),delegate:async()=>{throw Error('No prompt allowed')},recordTranscript:async entry=>{writes.push({...entry});if(busy)return {recorded:false,reason:'busy',retryable:true,executed:false};const {session:uri,...args}=entry;return host.nativeControl(uri,'voice.transcript.record',args)},resolveCredential:async()=>'fixture-not-provider',workerFactory:args=>{callbacks=args.callbacks;return {request:async method=>{if(method==='connect')return {id:'fixture-call'};if(method==='end'&&!finalSent){finalSent=true;await callbacks.transcript({lease:token,session,clientId:context.clientId,callId:'fixture-call',itemId:'final',role:'assistant',text:'Provider final café 漢字',append:false})}return {closed:true,finalized:true}},close:async()=>{}}}});
 const attach=async()=>{token=(await media.action({channel:session,operation:'media.attach'},context)).result.lease;const result=await media.handleFetch(new Request('http://fixture/media/voice/connect',{method:'POST',headers:{'X-Amplifier-Media-Lease':token},body:JSON.stringify({commandId:randomUUID(),sdp:'v=0-fixture'})}),{account:context.account});assert.equal(result.status,200)};
 const spoken=(text,itemId,append=false)=>callbacks.transcript({lease:token,session,clientId:context.clientId,callId:'fixture-call',itemId,role:'user',text,append});
 const nativeBytes=async()=>{const paths=await readdir(join(directory,'native-home'),{recursive:true});const names=paths.filter(name=>name.endsWith('transcript.jsonl'));assert.equal(names.length,1);return readFile(join(directory,'native-home',names[0]))};
 try{
  host=await openHost();socket=new WebSocket(host.url,{origin:new URL(host.url.replace(/^ws/,'http')).origin});await once(socket,'open');let next=0;const pending=new Map();socket.on('message',raw=>{const row=JSON.parse(raw),entry=pending.get(row.id);if(entry){pending.delete(row.id);clearTimeout(entry.timer);row.error?entry.reject(Error(row.error.message)):entry.resolve(row.result)}});
  const request=(method,params)=>new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>reject(Error('Native creation timed out')),90000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({jsonrpc:'2.0',id,method,params}))});
  await request('initialize',{channel:'ahp-root://',clientId:'first',protocolVersions:['0.9.0'],initialSubscriptions:['ahp-root://']});await request('createSession',{channel:session,provider:'amplifier',workingDirectories:[pathToFileURL(workspace).href]});
  media=await openMedia();await attach();await spoken('Exact café ','one');await spoken('漢字\n','one',true);await media.flushTranscripts(session);assert.equal(writes.length,1);assert.equal(writes[0].text,'Exact café 漢字\n');
  busy=true;const retained=await spoken('Known busy retained','two');await media.flushTranscripts(session);assert.equal(writes.length,2);const original={...writes[1]};assert.equal(retained.commandId,original.commandId);
  await media.disconnect('first');await media.close();media=null;socket.close();await host.close();host=null;const before=await nativeBytes();
  busy=false;host=await openHost();media=await openMedia();assert.deepEqual(await nativeBytes(),before);await media.flushTranscripts(session);assert.equal(writes.length,4);assert.deepEqual(writes[2],original);await media.flushTranscripts(session);assert.equal(writes.length,4);
  const native=await nativeBytes(),rows=native.toString().trim().split('\n').map(line=>JSON.parse(line));const voice=rows.filter(row=>row.metadata?.amplifier_voice);assert.equal(voice.length,3);assert.equal(voice[0].content,'Exact café 漢字\n');assert.equal(voice[1].content,'Known busy retained');assert.equal(voice[2].content,'Provider final café 漢字');assert.equal(voice[2].role,'assistant');assert(voice.every(row=>row.metadata.amplifier_voice.recordedOnly===true));
  assert.equal((await media.read({uri:'amplifier-media://configuration?scope='+encodeURIComponent(session)})).data.voiceTranscripts.items.length,3);await attach();assert.equal(writes.length,4);
  await assert.rejects(readFile(join(directory,'provider/amplifier_module_provider_media_fixture/forbidden-model-call')));
  if(process.env.MEDIA_ACCEPTANCE_RECEIPT)await writeFile(process.env.MEDIA_ACCEPTANCE_RECEIPT,JSON.stringify({scenario:'native-transcript-reconnect-restart',nativeSha256:createHash('sha256').update(native).digest('hex'),nativeVoiceRows:voice.length,writerAttempts:writes.length,knownBusyRetriedWithExactCommand:true,modelCalls:0,mediaTranscripts:3,limits:['Synthetic signalling only; actual installed Core/Foundation persistence. No physical device or real provider.']},null,2)+'\n');
 }finally{await media?.close();socket?.close();await host?.close();await rm(directory,{recursive:true,force:true})}
});
