import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,chmod} from 'node:fs/promises';
import {Readable} from 'node:stream';
import {join} from 'node:path';
import {MediaQuiescence} from './quiescence.js';
import {VoicePreferences,projectPreferences,schemas as preferenceSchemas} from './preferences.js';
import {TranscriptQueue} from './transcripts.js';
import {voiceFailure,voiceAvailability,availabilityReason,requireVoice,voiceErrorResponse} from './voice-errors.js';
import {createPythonWorker} from './worker.js';
export {createPythonWorker} from './worker.js';
const METHOD='x-amplifier/capabilityAction',TTL=15*60*1000;
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=(message,status=409)=>Object.assign(Error(message),{status,mediaPublic:true});
const cleanSession=value=>{if(typeof value!=='string'||!value.startsWith('ahp-session:'))throw fail('An explicit AHP conversation is required.',400);return value};
function bounded(context={}){return {title:String(context.title||'').slice(0,300),activity:context.activity||{},screen_source:context.screen_source||{available:false},workers:(context.workers||[]).slice(0,20),messages:(context.messages||[]).slice(-12).map(row=>({role:row.role,text:String(row.text||'').slice(0,1000),via:row.via})),generations:(context.generations||[]).slice(-8)};}
export async function createMediaCapability({directory,inspectSession,delegate,recordTranscript,recordUsage=async()=>{},subscribeSession,resolveCredential=async()=>'',settings=async()=>({}),configure,voicePreferences,clientPresent=async()=>true,invokeClientTool,nativeStatus,nativeCapture,enableNative=false,recordCapture=async()=>({}),onChanged=()=>{},onMayBeIdle=()=>{},workerFactory=createPythonWorker,python,pythonMode='package-source',leaseMs=TTL}={}){
 if(!directory||!inspectSession||!delegate||!recordTranscript)throw Error('Media owner requires isolated storage and explicit session, delegate and durable transcript callbacks.');
 await mkdir(join(directory,'receipts'),{recursive:true,mode:0o700});await mkdir(join(directory,'frames'),{recursive:true,mode:0o700});
 let idleNotice;const notifyIdle=()=>{if(idleNotice)return;idleNotice=setTimeout(()=>{idleNotice=undefined;try{Promise.resolve(onMayBeIdle()).catch(()=>{})}catch{}},0);idleNotice.unref();};
 const leases=new Map(),owners=new Map(),locks=new Map();let revision=1,worker,configuring=false,startingMedia=0,closing=false,closePromise;const hostInstanceId=randomUUID();
 const quiescence=new MediaQuiescence(directory,()=>({counts:{closing:closing?1:0,activeCalls:[...leases.values()].filter(lease=>lease.voice.id&&!['ended','error'].includes(lease.voice.status)).length,captureRequests:[...leases.values()].reduce((sum,lease)=>sum+[...lease.requests.values()].filter(request=>request.outcome!=='completed'&&Date.now()-request.createdAt<=30000).length,0),pendingTranscripts:transcriptQueue.pendingCount(),transcriptDrains:transcriptQueue.running.size},gaps:[]}),()=>worker,notifyIdle);
 let preferences;try{preferences=voicePreferences?new VoicePreferences(directory,async(operation,args,context)=>{
  if(operation==='voice.preferences.receipt')return voicePreferences(operation,args,context);
  if(configuring||startingMedia||[...leases.values()].some(item=>item.voice.id&&!['ended','error'].includes(item.voice.status)))throw Object.assign(Error('End active calls and voice previews before changing shared voice defaults.'),{data:{executed:false,reason:'media-active'}});
  configuring=true;try{return await voicePreferences(operation,args,context)}finally{configuring=false}
 },()=>{revision++;onChanged('voice-preferences','host')}):undefined}catch(error){quiescence.close();throw error}
 const settleCall=(lease,result)=>{if(result?.closed===true)lease.endResult=result;if(lease.voice.id)quiescence.call(lease.id,result?.finalized===true?null:'unverified');};
 const persist=async(key,value)=>{const file=join(directory,'receipts',digest(key)+'.json'),tmp=file+'.'+randomUUID();await writeFile(tmp,JSON.stringify(value),{mode:0o600});await rename(tmp,file)};
 const load=async key=>{try{return JSON.parse(await readFile(join(directory,'receipts',digest(key)+'.json'),'utf8'))}catch(error){if(error.code==='ENOENT')return null;throw error}};
 const changed=session=>{revision++;onChanged('voice',session)};const transcriptQueue=new TranscriptQueue(join(directory,'transcript-intents.sqlite'),{record:recordTranscript,onRecorded:changed,admit:work=>quiescence.effect(work)});await chmod(join(directory,'transcript-intents.sqlite'),0o600);const flushTranscripts=session=>transcriptQueue.flush(session);
 const valid=async(lease,{cleanup=false}={})=>{if(!lease||(!cleanup&&(lease.expiresAt<Date.now()||!await clientPresent(lease.session,lease.clientId))))throw fail('Media permission expired or this client detached. Choose the source again.');return lease};
 const callbackLease=async args=>{const lease=leases.get(args.lease);await valid(lease,{cleanup:['status','usage','transcript'].includes(args.operation)});if(lease.session!==args.session||lease.clientId!==args.clientId)throw fail('Media scope mismatch.',403);return lease};
 const ensureWorker=()=>worker??=workerFactory({python,pythonMode,onMayBeIdle:notifyIdle,callbacks:Object.fromEntries(Object.entries({
  admit:async args=>{await callbackLease(args);await inspectSession(args.session);return {admitted:true}},
  inspect:async args=>{const lease=await callbackLease(args);return bounded(await inspectSession(lease.session))},
  delegate:async args=>{const lease=await callbackLease(args);return effect(lease,args.commandId,'delegate',args.text,async()=>{const frame=lease.nextFrame;lease.nextFrame=null;const current=()=>frame&&lease.grants.get(frame.scope)?.id===frame.grantId&&lease.grants.get(frame.scope).expiresAt*1000>Date.now()&&Date.now()/1000-frame.capturedAt<=30;const attachments=current()?await frameAttachment(frame):undefined;return delegate({session:lease.session,clientId:lease.clientId,commandId:args.commandId,text:args.text,attachments:current()?attachments:undefined})},true)},
  transcript:async args=>{const lease=await callbackLease({...args,operation:'transcript'});return transcriptQueue.enqueue({session:lease.session,callId:args.callId,itemId:args.itemId,role:args.role,text:args.text,append:!!args.append,commandId:`media-transcript:${lease.id}:${++lease.transcriptSequence}`})},
  usage:async args=>{const lease=await callbackLease({...args,operation:'usage'});return recordUsage({...args,session:lease.session})},
  status:async args=>{const lease=await callbackLease({...args,operation:'status'});lease.voice={...lease.voice,...args.status};if(args.status.status==='ended')settleCall(lease,args.status);return {}},
 }).map(([name,callback])=>[name,args=>quiescence.effect(()=>{if(closing&&!['transcript','status','usage'].includes(name))throw fail('The media owner is closing; no new callback effect was admitted.');return callback(args)})]))});
 async function effect(lease,id,operation,payload,run,saveResult=false,prepare){
  if(typeof id!=='string'||id.length>240)throw fail('A bounded durable commandId is required.',400);
  const key=[lease.account,lease.clientId,lease.session,id],fingerprint=digest([operation,payload]);
  if(locks.has(digest(key))){const lock=locks.get(digest(key));if(lock.fingerprint!==fingerprint)throw fail('Command identity was reused with different content.');return lock.work;}
  const work=(async()=>{const old=await load(key);if(old){if(old.fingerprint!==fingerprint)throw fail('Command identity was reused with different content.');if(old.outcome==='completed'&&old.result)return old.result;if(old.outcome==='refused')throw voiceFailure(old.code,false);throw fail('The earlier effect has an unknown outcome. It was not replayed.');}
   const prepared=await prepare?.();
   await persist(key,{fingerprint,operation,outcome:'unknown',at:Date.now()});
   let result;try{result=await run(prepared)}catch(error){if(error.voicePublic&&error.executed===false)await persist(key,{fingerprint,operation,outcome:'refused',at:Date.now(),code:error.code});throw error;}await persist(key,{fingerprint,operation,outcome:'completed',at:Date.now(),...(saveResult?{result}:{})});return result;
  })();locks.set(digest(key),{work,fingerprint});try{return await work}finally{locks.delete(digest(key))}
 }
 async function saveFrame(lease,item,value){const bytes=Buffer.from(value.image,'base64'),hash=createHash('sha256').update(bytes).digest('hex'),id=item.command.id,uri=`amplifier-media://frames/${id}?session=${encodeURIComponent(lease.session)}&sha256=${hash}`;const metadata={id,session:lease.session,clientId:lease.clientId,source:lease.grants.get(item.command.type.split('.')[0])?.source,capturedAt:value.capturedAt,hash,mimeType:'image/png',width:value.width,height:value.height,resourceUri:uri,untrustedData:true,...(value.window?{window:value.window}:{} )};await writeFile(join(directory,'frames',id+'.png'),bytes,{mode:0o600,flag:'wx'});await writeFile(join(directory,'frames',id+'.json'),JSON.stringify(metadata),{mode:0o600,flag:'wx'});await recordCapture(metadata);lease.nextFrame={...metadata,scope:item.command.type.split('.')[0],grantId:item.command.grantId};return metadata;}
 async function configuration(session){
  // A passive projection must never obtain credentials or require their grant.
  // The credential owner supplies sanitized availability; secrets are resolved
  // only when the client explicitly connects or requests a voice preview.
  let preference;try{preference=await settings(session)}catch{throw voiceFailure('voice_settings_unavailable',false)}preference=preference&&typeof preference==='object'?preference:{};const availability=voiceAvailability(preference),available=availability==='configured',projection=projectPreferences(preference,!!preferences);
  return {...projection,available,availability,credentialValidation:'not-checked',configurable:typeof configure==='function'&&preference.credentialAccess!=='disabled'&&(typeof preference.configurable==='boolean'?preference.configurable:preference.configurable===undefined),
   credentialAccess:['enabled','disabled'].includes(preference.credentialAccess)?preference.credentialAccess:undefined,
   source:['environment','private'].includes(preference.source)?preference.source:'environment',preferredModel:projection.preferredModel??'gpt-live-1',
   voice:projection.voice??'marin',interruptions:projection.interruptions??true,
   reason:availabilityReason(availability),
   mediaEndpoint:'/media',captureMode:'explicit-frame'};
 }
 const manifest={version:1,topics:{voice:{version:1,uri:'amplifier-media://configuration',watch:true}},actions:Object.fromEntries(['media.attach','voice.configuration'].map(name=>[name,{version:1,topic:'voice',operation:name,method:METHOD}]))};
 if(preferences){manifest.topics['voice-preferences']={version:1,uri:'amplifier-media://voice-preferences',watch:true,scope:'host'};for(const name of Object.keys(preferenceSchemas))manifest.actions[name]={version:1,topic:'voice-preferences',operation:name,method:METHOD};}
 async function read(request){const url=new URL(typeof request==='string'?request:request.uri),scope=request.scope??url.searchParams.get('scope')??'host';if(url.protocol!=='amplifier-media:')throw fail('Unknown media topic',400);if(url.hostname==='voice-preferences'){if(!preferences||scope!=='host')throw fail('Shared voice preferences require the advertised host scope.',400);return {topic:'voice-preferences',scope:'host',revision,data:{voicePreferences:projectPreferences(await settings(null),true)}};}if(url.protocol!=='amplifier-media:'||url.hostname!=='configuration')throw fail('Unknown media topic',400);return {topic:'voice',scope,revision,data:{voiceConfiguration:await configuration(scope==='host'?null:scope),...(scope!=='host'?{voiceTranscripts:{sessionId:scope,items:transcriptQueue.history(scope)}}:{})}};}
 const action=async(request,context={})=>{try{if(closing&&!['voice.configuration','voice.preferences.receipt'].includes(request.operation))throw fail('The media owner is closing; no new effect was admitted.');return await (['voice.configuration','voice.preferences.receipt'].includes(request.operation)?performAction(request,context):quiescence.effect(()=>performAction(request,context)))}catch(error){if(request.operation==='voice.preferences.update'&&error.executed===false)return {accepted:false,result:{commandId:request.commandId,operation:request.operation,status:'failed',executed:false,replayed:false,reason:'media-intake-fenced',error:error.message}};throw error}};
 async function performAction(request,context={}){
  if(request.operation.startsWith('voice.preferences.')){
   if(!preferences||request.channel!=='ahp-root://' ||request.topic!=='voice-preferences'||request.version!==1)throw fail('Advertised host-scoped voice preferences required.',400);
   if(!context.account||(!context.clientId&&context.origin!=='agent'))throw fail('Authenticated caller required.',401);
   if(request.operation==='voice.preferences.receipt')return preferences.receipt(request.args??{},context);
   if(request.operation==='voice.preferences.update')return preferences.update(request,context);
   throw fail('Unknown voice preference action.',400);
  }
  const session=cleanSession(request.channel),clientId=context.clientId,account=context.account;
  if(!clientId||!account)throw fail('Authenticated client and account are required.',401);
  if(request.operation==='voice.configuration')return {accepted:true,result:await configuration(session)};
  if(request.operation!=='media.attach')throw fail('Unsupported media control.',400);
  if(!await clientPresent(session,clientId))throw fail('Attach this client to the conversation before starting media.');await inspectSession(session);
  const key=JSON.stringify([account,clientId,session]);let lease=owners.get(key);
  if(lease&&lease.expiresAt>Date.now())return {accepted:true,result:{lease:lease.token,expiresAt:lease.expiresAt,endpoint:'/media'}};
  if(leases.size>=256)throw fail('The host media lease limit was reached. Close unused calls first.',429);
  const token=randomBytes(32).toString('base64url');lease={id:randomUUID(),token,account,clientId,session,expiresAt:Date.now()+leaseMs,voice:{},grants:new Map(),requests:new Map(),transcriptSequence:0};leases.set(token,lease);owners.set(key,lease);
  return {accepted:true,result:{lease:token,expiresAt:lease.expiresAt,endpoint:'/media'}};
 }
 function revokeSource(lease,scope){const grant=lease.grants.get(scope);lease.grants.delete(scope);if(lease.nextFrame?.scope===scope)lease.nextFrame=null;for(const [id,item]of lease.requests)if(item.command.grantId===grant?.id)lease.requests.delete(id);}
 async function visual(lease,scope,operation,args){
  const session=lease.session,callId=scope==='voice'?lease.voice.id:null;
  if(args.sessionId&&args.sessionId!==session)throw fail('Visual conversation changed.',403);
  if(scope==='voice'&&operation!=='revoke'&&(lease.voice.status!=='connected'||args.callId!==callId))throw fail('Connect this client call before granting a source.');
  if(operation==='native/status')return nativeStatus?nativeStatus({session,clientId:lease.clientId}):enableNative?{...await ensureWorker().request('native.status',{}),hostInstanceId}:{available:false,host:{label:'This host'},code:'backend_not_installed',reason:'This host has no native foreground adapter.'};
  if(operation==='grant'){
   const kind=args.source?.kind;if(!['browser','window','monitor','unknown','native-foreground'].includes(kind))throw fail('Unsupported source kind.',400);
   if(kind==='native-foreground'&&!nativeCapture&&!enableNative)throw fail('Native foreground capture is unavailable.');
   if(kind==='native-foreground'){const status=nativeStatus?await nativeStatus({session,clientId:lease.clientId}):{...await ensureWorker().request('native.status',{}),hostInstanceId};if(!status.available||status.host.id!==args.source.hostId||status.hostInstanceId!==args.source.hostInstanceId)throw fail('The named foreground host changed or is unavailable.');}
   const grant={id:randomUUID(),sessionId:session,callId,source:{kind,label:String(args.source.label||'User-selected source').slice(0,200),...(kind==='native-foreground'?{hostId:args.source.hostId,hostInstanceId:args.source.hostInstanceId}:{})},expiresAt:Math.min(lease.expiresAt,Date.now()+TTL)/1000};
   revokeSource(lease,scope);lease.grants.set(scope,grant);return grant;
  }
  const grant=lease.grants.get(scope);
  if(operation==='revoke'){if(grant?.id===args.grantId)revokeSource(lease,scope);return {revoked:true}}
  if(!grant||grant.expiresAt*1000<Date.now())throw fail('No current source permission.');
  if(operation==='status')return {available:true,...grant,captureMode:'explicit-frame'};
  if(operation==='request'){
   const command={id:randomUUID(),type:`${scope}.visual.capture`,grantId:grant.id,sessionId:session,callId:grant.callId};
   if(lease.requests.size>=8)lease.requests.delete(lease.requests.keys().next().value);
   lease.requests.set(command.id,{command,outcome:'unknown',createdAt:Date.now()});
   if(grant.source.kind==='native-foreground'){const result=nativeCapture?await nativeCapture({session,clientId:lease.clientId,source:grant.source,commandId:command.id}):await ensureWorker().request('native.capture',{});await valid(lease);if(lease.grants.get(scope)?.id!==grant.id)throw fail('The source changed during capture.');const dimensions=await ensureWorker().request('image.validate',{image:result.image});const receipt=await saveFrame(lease,lease.requests.get(command.id),{...result,...dimensions});lease.requests.get(command.id).result=receipt;lease.requests.get(command.id).outcome='completed';return {native:true,result:receipt}}
   return command;
  }
  const item=lease.requests.get(args.requestId);if(!item||item.command.grantId!==grant.id||Date.now()-item.createdAt>30000)throw fail('The capture request expired.');
  if(operation==='result'){if(item.outcome!=='completed')throw fail('Capture outcome is unknown. No frame was replayed.');return item.result;}
  if(operation==='complete'){
   if(args.grantId!==grant.id||args.callId!==grant.callId)throw fail('Capture grant mismatch.',403);
   if(item.outcome==='completed')return {completed:true,duplicate:true};
   if(args.error){item.result={error:String(args.error).slice(0,300)};item.outcome='completed';return {completed:true}}
   if(typeof args.image!=='string'||args.image.length>666668||!Number.isFinite(args.capturedAt)||Math.abs(Date.now()/1000-args.capturedAt)>30)throw fail('A fresh bounded PNG is required.',400);
   const dimensions=await ensureWorker().request('image.validate',{image:args.image});
   await valid(lease);if(lease.grants.get(scope)?.id!==grant.id)throw fail('The source changed during capture.');item.result=await saveFrame(lease,item,{image:args.image,...dimensions,capturedAt:args.capturedAt});item.outcome='completed';return {completed:true};
  }
  throw fail('Unsupported visual operation.',400);
 }
 async function handleFetch(request,context={}){
  const path=new URL(request.url).pathname,passive=['/media/voice/config','/media/voice/status','/media/voice/visual/status','/media/computer/visual/status','/media/voice/visual/result','/media/computer/visual/result'].includes(path);
  try{if(closing&&!passive)throw fail('The media owner is closing; no new effect was admitted.');return await (passive?handleFetchInner(request,context):quiescence.effect(()=>handleFetchInner(request,context)))}catch(error){return voiceErrorResponse(error,path)}
 }
 async function handleFetchInner(request,{account}={}){
  try{
   const url=new URL(request.url);if(!url.pathname.startsWith('/media/'))return new Response('Not found',{status:404});
   if(request.method!=='POST')throw fail('Media operations require POST.',405);
   const token=request.headers.get('X-Amplifier-Media-Lease'),lease=leases.get(token);if(!lease||lease.account!==account)throw fail('Invalid media lease.',403);
   const path=url.pathname.slice('/media/'.length),cleanup=path==='voice/end'||path.endsWith('/revoke');await valid(lease,{cleanup});
   const chunks=[];let size=0;for await(const chunk of request.body||[]){size+=chunk.length;if(size>750000)throw fail('Media request exceeds limit.',413);chunks.push(chunk);}const text=Buffer.concat(chunks).toString();const args=JSON.parse(text||'{}');if(args.sessionId&&args.sessionId!==lease.session)throw fail('Media conversation mismatch.',403);
   let result;
   const match=/^(voice|computer)\/visual\/(.+)$/.exec(path);
   if(match)result=await visual(lease,match[1],match[2],args);
   else if(path==='voice/config')result=await configuration(lease.session);
   else if(path==='voice/status'){lease.expiresAt=Date.now()+leaseMs;result={...lease.voice};}
   else if(path==='voice/configure'){if(!configure)throw fail('Credential configuration unavailable.');if(configuring||startingMedia||[...leases.values()].some(item=>item.voice.id&&!['ended','error'].includes(item.voice.status)))throw fail('End active calls and voice previews before changing voice settings.');configuring=true;try{const current=await configuration(lease.session);if(current.credentialAccess==='disabled')throw voiceFailure('voice_access_disabled',false);if(!current.configurable)throw voiceFailure('voice_unavailable',false);if(Object.keys(args).some(key=>!['source','apiKey'].includes(key))||!['environment','private'].includes(args.source)||(args.apiKey!==undefined&&(typeof args.apiKey!=='string'||args.apiKey.length>4000||/[\n\r\0]/.test(args.apiKey))))throw voiceFailure('voice_configuration_invalid',false);try{await configure({session:lease.session,account,args})}catch{throw voiceFailure('voice_configuration_unknown')}try{result=await configuration(lease.session)}catch{throw voiceFailure('voice_configuration_unknown')}changed();}finally{configuring=false;}}
   else if(['voice/connect','voice/preview'].includes(path)){
    const operation=path.split('/')[1];startingMedia++;try{result=await effect(lease,args.commandId,operation,{...args,sdp:args.sdp?digest(args.sdp):undefined},async({config,apiKey,context})=>{
     if(operation==='connect')quiescence.call(lease.id,'starting');
     let result;try{result=await ensureWorker().request(operation,{...args,lease:token,session:lease.session,clientId:lease.clientId,apiKey,context,settings:config,directory});}catch(error){if(operation==='connect')quiescence.call(lease.id,error.data?.source==='voice-provider'&&error.data.executed===false?null:'unverified');if(error.data?.source==='voice-provider'){const status=error.data.status;throw voiceFailure(status===401?'voice_credentials_invalid':[403,404].includes(status)?'voice_model_unavailable':status===429?'voice_rate_limited':'voice_connection_unknown',error.data.executed===false?false:undefined)}throw error;}
     if(operation==='connect'){quiescence.call(lease.id,'active');lease.endResult=undefined;lease.voice={...result,sdp:undefined,status:'connecting'};lease.unsubscribe=await subscribeSession?.(lease.session,async context=>quiescence.effect(async()=>{await flushTranscripts(lease.session);await worker?.request('update',{lease:token,context:bounded(context)}).catch(()=>{});}));}return result;
    },false,async()=>{
     if(configuring)throw fail('Voice settings are changing. Try again after they finish.');
     if(lease.voice.id&&!['ended','error'].includes(lease.voice.status))throw fail('This client already has an active call.');
     const config=await configuration(lease.session);requireVoice(config);let apiKey;try{apiKey=await resolveCredential(lease.session)}catch{throw voiceFailure('voice_settings_unavailable',false)}if(typeof apiKey!=='string'||!apiKey.trim())throw voiceFailure('voice_credentials_missing',false);const context=bounded(await inspectSession(lease.session));return {config,apiKey,context};
    });}finally{startingMedia--;}
   }else if(path==='voice/ready'){result=await ensureWorker().request('ready',{lease:token,id:args.id});lease.voice.status='connected';}
   else if(path==='voice/end'){if(args.id&&args.id!==lease.voice.id)throw fail('This call is no longer active.');result=lease.voice.status==='ended'?(lease.endResult??{closed:true,finalized:false,workContinues:true}):worker?await worker.request('end',{lease:token,id:args.id}):{closed:true,finalized:false,workContinues:true};settleCall(lease,result);lease.voice={...lease.voice,status:'ended'};revokeSource(lease,'voice');lease.unsubscribe?.();lease.unsubscribe=null;}
   else throw fail('Unknown media operation.',404);
   return Response.json(result,{headers:{'Cache-Control':'no-store'}});
  }catch(error){return voiceErrorResponse(error,new URL(request.url).pathname)}
 }
 async function endLease(lease){if(worker&&lease.voice.id&&lease.voice.status!=='ended'){try{settleCall(lease,await worker.request('end',{lease:lease.token,id:lease.voice.id}));lease.voice={...lease.voice,status:'ended'};}catch{quiescence.call(lease.id,'unverified');}}}
 const timer=setInterval(()=>{void quiescence.effect(async()=>{for(const [token,lease]of leases)if(lease.expiresAt<Date.now()){lease.unsubscribe?.();revokeSource(lease,'voice');revokeSource(lease,'computer');await endLease(lease);leases.delete(token);for(const [key,value]of owners)if(value===lease)owners.delete(key);}}).catch(()=>{});},10000);timer.unref();
 async function frameAttachment(frame){const bytes=await readFile(join(directory,'frames',frame.id+'.png'));return [{type:'embeddedResource',data:bytes.toString('base64'),contentType:'image/png',displayName:'Explicit screen snapshot'}];}
 const resourceProvider={scheme:'amplifier-media',async read(params){const url=new URL(params.uri),session=cleanSession(url.searchParams.get('session'));await inspectSession(session);const id=url.pathname.slice(1);if(url.hostname!=='frames'||!/^[-a-f0-9]{36}$/.test(id))throw fail('Unknown frame.');const row=JSON.parse(await readFile(join(directory,'frames',id+'.json'),'utf8'));if(row.session!==session||row.hash!==url.searchParams.get('sha256'))throw fail('Frame scope mismatch.',403);const bytes=await readFile(join(directory,'frames',id+'.png'));if(createHash('sha256').update(bytes).digest('hex')!==row.hash)throw fail('Frame content changed.');return {data:bytes.toString('base64'),encoding:'base64',contentType:'image/png'};}};
 async function handleMedia(req,res,context){const request=new Request(new URL(req.url,'http://media.local'),{method:req.method,headers:req.headers,body:['GET','HEAD'].includes(req.method)?undefined:Readable.toWeb(req),duplex:'half'});const response=await handleFetch(request,context);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));}
 quiescence.retentionReferences=sessions=>({coverage:'complete',protected:sessions.flatMap(session=>transcriptQueue.db.prepare("SELECT 1 FROM intents WHERE session=? AND status IN ('pending','unknown') LIMIT 1").get(session)?[{session,reasons:['voice-transcript']}]:[]),omissions:[]});
 quiescence.managedReferences=args=>quiescence.retentionReferences(args.sessions);
 return {manifest,read,action,actionSchemas:preferences?preferenceSchemas:{},handleMedia,handleFetch,flushTranscripts,resourceProvider,quiescenceAccess:{'voice.configuration':'read',...(preferences?{'voice.preferences.receipt':'read'}:{})},quiescenceParticipant:ownerId=>quiescence.participant(ownerId),inspectQuiescence:()=>quiescence.inspect(),disconnect:clientId=>quiescence.effect(async()=>{for(const lease of leases.values())if(lease.clientId===clientId){lease.expiresAt=0;revokeSource(lease,'voice');revokeSource(lease,'computer');lease.unsubscribe?.();await endLease(lease);}}),close(){return closePromise??=(async()=>{closing=true;clearInterval(timer);for(const lease of leases.values()){lease.unsubscribe?.();revokeSource(lease,'voice');revokeSource(lease,'computer');await endLease(lease);}await quiescence.waitForIdle();for(const lease of leases.values()){lease.unsubscribe?.();lease.unsubscribe=null;revokeSource(lease,'voice');revokeSource(lease,'computer');await endLease(lease);}await worker?.close();await quiescence.waitForIdle();leases.clear();owners.clear();await transcriptQueue.close();await preferences?.close();if(idleNotice)clearTimeout(idleNotice);quiescence.close();})();},get activeCalls(){return [...leases.values()].filter(item=>item.voice.id&&!['ended','error'].includes(item.voice.status)).length}};
}
