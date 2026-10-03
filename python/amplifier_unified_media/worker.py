"""Bidirectional JSON-RPC worker. Credentials only transit private stdio, never disk."""
import asyncio, json, sys, uuid
import aiohttp
from .voice import VoiceCall, VoiceError, ProviderError, API, MODELS
from .voice_diagnostics import VoiceDiagnostics
from .voice_options import selected_voice, voices_for
from .sample import render_sample
from .voice_visual_image import validate_png
from .service_lifecycle import service_identity, service_proof
import base64

class Rpc:
    def __init__(self): self.pending={}; self.owners={}; self.tasks=set(); self.calls=set(); self.effects=0; self.fence=None; self.released={}; self.live_fence=None
    def send(self, value): print(json.dumps(value, ensure_ascii=False), flush=True)
    def may_be_idle(self):
        self.send({'jsonrpc':'2.0','method':'quiescence/mayBeIdle','params':{}})
    async def callback(self, name, params):
        identity='media:'+uuid.uuid4().hex; future=asyncio.get_running_loop().create_future(); self.pending[identity]=future
        self.send({'jsonrpc':'2.0','id':identity,'method':name,'params':params})
        try: return await asyncio.wait_for(future, 650 if name=='delegate' else 30)
        finally: self.pending.pop(identity,None); self.may_be_idle()
    async def handle(self, message):
        identity=message.get('id')
        if 'method' not in message:
            future=self.pending.get(identity)
            if future and not future.done():
                if 'error' in message: future.set_exception(VoiceError(message['error'].get('message','Host rejected media request')))
                else: future.set_result(message.get('result'))
            return
        try:
            result=await self.dispatch(message['method'],message.get('params',{}))
            self.send({'jsonrpc':'2.0','id':identity,'result':result})
        except Exception as error:
            # Provider errors are already sanitized. Never return arbitrary HTTP payloads.
            text=str(error) if isinstance(error,(VoiceError,ValueError)) else 'Media transport failed; the outcome may be unknown.'
            self.send({'jsonrpc':'2.0','id':identity,'error':{'code':-32000,'message':text[:500]}})
    def work(self):
        self.calls={call for call in self.calls if not call.closed or any(not task.done() for task in call.tasks) or any(task and not task.done() for task in (call.pump,call.observer))}
        return {'effects':self.effects,'owners':len(self.owners),'callbacks':len(self.pending),'callTasks':sum(sum(not task.done() for task in call.tasks) for call in self.calls),'liveCalls':sum(not call.closed for call in self.calls),'transportTasks':sum(sum(bool(task and not task.done()) for task in (call.pump,call.observer)) for call in self.calls)}
    @staticmethod
    def context(args):
        value={key:args.get('context',{}).get(key) for key in ('fenceId','commandId','purpose','instanceId','dataScope')}
        value['ownerId']=args.get('ownerId')
        if any(not isinstance(v,str) or not 1<=len(v)<=200 or any(ord(c)<32 for c in v) for v in value.values()) or value['purpose'] not in ('distribution-update','recovery','service-stop','retention-hide','managed-files-disposal'):
            raise ValueError('Bounded exact media fence context required')
        if value['purpose']=='service-stop':
            value['serviceIdentity']=service_identity(args['context'].get('serviceIdentity'))
            if any(value['serviceIdentity'][key]!=value[key] for key in ('instanceId','dataScope')):raise ValueError('Service identity differs from media worker fence')
        return value
    async def dispatch(self, method, args):
        if method=='quiescence.inspect':return {'intakeClosed':self.fence is not None,'fence':self.fence,'counts':self.work(),'serviceStop':{'version':1},'managedFiles':{'version':1,'preservesCanonical':True}}
        if method=='quiescence.acquire':
            context=self.context(args);owner=args['ownerId']
            if self.fence:
                if self.fence['ownerId']!=owner or any(self.fence[key]!=context[key] for key in ('fenceId','commandId','purpose','instanceId','dataScope')) or self.fence.get('serviceIdentity')!=context.get('serviceIdentity'):raise ValueError('Different media worker fence held')
                return {'held':True,'ownerId':owner,'fenceId':context['fenceId']}
            if context['fenceId'] in self.released:raise ValueError('Released fence cannot reacquire')
            work=self.work()
            if any(work.values()):return {'held':False,'executed':False,'counts':work}
            self.fence={**context,'ownerId':owner};self.live_fence=context['fenceId'];return {'held':True,'ownerId':owner,'fenceId':context['fenceId']}
        if method=='quiescence.release':
            context=self.context(args);old=self.fence
            if not old:
                if self.released.get(context['fenceId'])=={'context':context,'outcome':args['outcome'],'proof':args.get('proof')}:return {'released':True,'duplicate':True}
                raise ValueError('Exact media worker fence required')
            if old['ownerId']!=args['ownerId'] or any(old[key]!=context[key] for key in ('fenceId','commandId','purpose','instanceId','dataScope')) or old.get('serviceIdentity')!=context.get('serviceIdentity'):raise ValueError('Different media worker fence')
            if args['outcome']=='unknown':
                self.live_fence=None
                return {'released':False,'intakeClosed':True}
            proof=args.get('proof') or {};outcome=args['outcome']
            refused=proof=={'kind':'admission-refused'} and outcome=='unchanged' and (old['purpose'] not in {'service-stop','managed-files-disposal'} or self.live_fence==old['fenceId'])
            if old['purpose']=='service-stop' and not refused:proof=service_proof(proof,old,outcome)
            verified=proof.get('verified') is True and all(proof.get(key)==old[key] for key in ('fenceId','commandId','dataScope')) and proof.get('outcome')==outcome and outcome in ('ready','unchanged') and bool(proof.get('receiptId')) and bool(proof.get('instanceId')) and ((proof['instanceId']==old['instanceId'])==(outcome=='unchanged'))
            if not refused and not verified:raise ValueError('Exact verified media worker release proof required')
            self.released[context['fenceId']]={'context':context,'outcome':args['outcome'],'proof':args.get('proof')}
            while len(self.released)>256:self.released.pop(next(iter(self.released)))
            self.fence=None;self.live_fence=None;return {'released':True}
        if self.fence:raise ValueError('Media worker intake closed for quiescence; no new effect admitted')
        self.effects+=1
        try:return await self.execute(method,args)
        finally:self.effects-=1; self.may_be_idle()
    async def execute(self, method, args):
        lease=args.get('lease')
        if method in ('native.status','native.capture'):
            from .native_foreground import NativeForeground, observation_metadata
            from .host_identity import local_host_identity
            result=await NativeForeground().run('status' if method=='native.status' else 'capture')
            if method=='native.capture' and result.get('image'):
                result={**result,**observation_metadata(result)}
            return {**result,'host':local_host_identity()}
        if method=='image.validate':
            data=base64.b64decode(args['image'],validate=True); width,height=validate_png(data)
            return {'width':width,'height':height}
        if method in ('connect','preview'):
            if lease in self.owners: raise VoiceError('A media operation is already active for this lease.')
            owner=Owner(self,args); self.owners[lease]=owner
            try:
                if method=='preview':
                    if args['voice'] not in voices_for(args['model']): raise ValueError('Unknown model or voice')
                    return {'model':args['model'],'voice':args['voice'],'mimeType':'audio/wav','audio':await render_sample(owner,args['model'],args['voice'])}
                sdp=args.get('sdp','')
                if not isinstance(sdp,str) or not sdp.startswith('v=0') or len(sdp)>100000: raise VoiceError('A valid bounded SDP offer is required.')
                if not owner.api_key: raise VoiceError('Configure voice credentials before calling.')
                provider=args.get('provider','auto'); settings=args.get('settings',{})
                if provider=='auto': provider=next((key for key,model in MODELS.items() if model==settings.get('preferredModel',MODELS['live'])),None)
                if provider not in MODELS: raise VoiceError('The configured voice model is unsupported.')
                call=owner.call=VoiceCall(owner,owner.session);self.calls.add(call)
                call.voice_name=selected_voice(MODELS[provider],settings.get('voice','marin')); call.interruptions=settings.get('interruptions',True)
                result=await call.create(sdp,provider)
                await owner.set_voice_status({'status':'connecting',**{k:v for k,v in result.items() if k!='sdp'}})
                return result
            except Exception:
                if owner.call: await owner.call.close()
                self.owners.pop(lease,None); await owner.http.close(); raise
            finally:
                if method=='preview': self.owners.pop(lease,None); await owner.http.close()
        owner=self.owners.get(lease)
        if not owner:
            if method=='end': return {'closed':True,'finalized':False,'workContinues':True}
            raise VoiceError('This media lease is no longer active.')
        if method=='ready':
            if not owner.call or owner.call.closed or owner.call.id!=args.get('id'): raise VoiceError('This call is no longer active.')
            await owner.set_voice_status({'status':'connected'})
            if not owner.call.observer: owner.call.observer=asyncio.create_task(owner.call.observe())
            return {'ready':True}
        if method=='update':
            owner.context=args['context']
            while not owner.queue.empty(): owner.queue.get_nowait()
            owner.queue.put_nowait(owner.context); return {}
        if method=='end':
            if args.get('id') and owner.call.id!=args['id']: raise VoiceError('This call is no longer active.')
            result=await owner.call.close(); self.owners.pop(lease,None)
            # Delegated host work stays alive. It does not require this media socket.
            await owner.http.close(); return result
        raise ValueError('Unknown media method')

class Owner:
    def __init__(self,rpc,args):
        self.rpc,self.lease,self.session,self.client_id=rpc,args['lease'],args['session'],args['clientId']
        self.context=args.get('context',{}); self.api_key=args.get('apiKey',''); self.owner=self; self.call=None
        self.http=aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)); self.queue=asyncio.Queue(maxsize=1)
        self.protocol_diagnostics=VoiceDiagnostics(args.get('directory'))
    @property
    def headers(self): return {'Authorization':'Bearer '+self.api_key}
    async def callback(self,name,**args): return await self.rpc.callback(name,{'lease':self.lease,'session':self.session,'clientId':self.client_id,**args})
    async def admit(self): return await self.callback('admit')
    async def inspect(self): self.context=await self.callback('inspect'); return self.context
    async def delegate(self,text,command_id): return await self.callback('delegate',text=text,commandId=command_id)
    async def record_voice_transcript(self,role,text,**args): return await self.callback('transcript',role=role,text=text,callId=args['voice_id'],itemId=args['item_id'],append=args.get('append',False))
    async def record_voice_usage(self,session_id,call_id,response_id,model,usage,phase='completed',**_): return await self.callback('usage',callId=call_id,responseId=response_id,model=model,usage=usage,phase=phase)
    async def set_voice_status(self,status): return await self.callback('status',status=status)
    def work_changed(self): self.rpc.may_be_idle()
    def subscribe(self): return self.queue
    def unsubscribe(self,queue): pass
    async def request(self,method,path,**kwargs):
        async with self.http.request(method,API+path,headers=self.headers,**kwargs) as response:
            text=await response.text()
            try: body=json.loads(text)
            except ValueError: body={}
            if response.status>=400:
                code=body.get('error',{}).get('code','') if isinstance(body,dict) else ''
                raise ProviderError(response.status,code,f'Voice provider rejected the request (HTTP {response.status}). Check model access and credentials.')
            return body,text,dict(response.headers)

async def main():
    rpc=Rpc()
    try:
        while True:
            line=await asyncio.to_thread(sys.stdin.buffer.readline, 2*1024*1024+1)
            if not line: break
            if len(line)>2*1024*1024: raise ValueError('Media RPC message too large')
            task=asyncio.create_task(rpc.handle(json.loads(line))); rpc.tasks.add(task); task.add_done_callback(rpc.tasks.discard)
    finally:
        for owner in list(rpc.owners.values()):
            if owner.call: await owner.call.close()
            await owner.http.close()
        # Unknown delegated work is never restarted by a new worker.

if __name__=='__main__': asyncio.run(main())
