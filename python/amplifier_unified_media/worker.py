"""Bidirectional JSON-RPC worker. Credentials only transit private stdio, never disk."""
import asyncio, json, sys, uuid
import aiohttp
from .voice import VoiceCall, VoiceError, ProviderError, API, MODELS
from .voice_diagnostics import VoiceDiagnostics
from .voice_options import selected_voice, voices_for
from .sample import render_sample
from .voice_visual_image import validate_png
import base64

class Rpc:
    def __init__(self): self.pending={}; self.owners={}; self.tasks=set()
    def send(self, value): print(json.dumps(value, ensure_ascii=False), flush=True)
    async def callback(self, name, params):
        identity='media:'+uuid.uuid4().hex; future=asyncio.get_running_loop().create_future(); self.pending[identity]=future
        self.send({'jsonrpc':'2.0','id':identity,'method':name,'params':params})
        try: return await asyncio.wait_for(future, 650 if name=='delegate' else 30)
        finally: self.pending.pop(identity,None)
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
    async def dispatch(self, method, args):
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
                call=owner.call=VoiceCall(owner,owner.session)
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
