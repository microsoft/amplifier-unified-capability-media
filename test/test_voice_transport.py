"""Actual RPC/VoiceCall paths with only HTTP/WebSocket transport replaced offline."""
import asyncio
import json
import pytest
from amplifier_unified_media import worker


class Response:
    def __init__(self, status=200, text='', headers=None):
        self.status, self.body, self.headers = status, text, headers or {}
    async def __aenter__(self): return self
    async def __aexit__(self, *_): pass
    async def text(self): return self.body


class Socket:
    def __init__(self): self.closed=False; self.events=asyncio.Queue(); self.sent=[]
    def __aiter__(self): return self
    async def __anext__(self): return await self.events.get()
    async def send_json(self,event): self.sent.append(event)
    async def close(self): self.closed=True


class Transport:
    def __init__(self, attempts, refusal=None):
        self.attempts=attempts; self.refusal=refusal; self.socket=Socket()
    def request(self,method,url,**kwargs):
        if url.endswith('/hangup'):
            self.attempts.append({'path':'hangup'}); return Response()
        if 'json' in kwargs: config=kwargs['json']['session']; provider='live'
        else:
            config=json.loads(next(value for headers,_,value in kwargs['data']._fields if headers['name']=='session')); provider='realtime'
        self.attempts.append({'provider':provider,'config':config})
        refusal=self.refusal.pop(0) if isinstance(self.refusal,list) else self.refusal
        if refusal: return Response(refusal,json.dumps({'error':{'code':'model_not_available'}}))
        if provider=='live': return Response(text=json.dumps({'session':{'id':'offline-live'},'transport':{'sdp':'offline-answer'}}))
        return Response(text='offline-answer',headers={'Location':'/v1/realtime/calls/offline-realtime'})
    async def ws_connect(self,*_,**__): return self.socket
    async def close(self): self.socket.closed=True


def fixture(monkeypatch, refusal=None):
    attempts=[]; callbacks=[]; rpc=worker.Rpc();rpc.send=lambda _:None
    monkeypatch.setattr(worker.aiohttp,'ClientSession',lambda **_:Transport(attempts,refusal))
    async def callback(name,args): callbacks.append((name,args)); return {}
    rpc.callback=callback
    return rpc,attempts,callbacks


def offer(model,voice='cedar',interruptions=False):
    return {'lease':'owned','session':'owned-session','clientId':'client','apiKey':'synthetic-offline','sdp':'v=0',
            'settings':{'preferredModel':model,'fallbackModel':'gpt-live-1','voice':voice,'interruptions':interruptions}}


@pytest.mark.parametrize('model,provider',[('gpt-live-1','live'),('gpt-realtime-2.1','realtime')])
async def test_saved_defaults_reach_actual_transport_and_next_call(monkeypatch,model,provider):
    rpc,attempts,callbacks=fixture(monkeypatch)
    try:
        await rpc.dispatch('connect',offer(model))
        call=rpc.owners['owned'].call
        assert attempts[0]['provider']==provider
        assert attempts[0]['config']['audio']['output']['voice']=='cedar'
        if provider=='realtime': assert attempts[0]['config']['audio']['input']['turn_detection']['interrupt_response'] is False
        else: assert attempts[0]['config']['delegation']=={'type':'client'} and attempts[0]['config']['store'] is False
        if provider=='live': call.final.set()  # Explicit synthetic provider final, no close timeout.
        assert (await rpc.dispatch('end',{'lease':'owned','id':call.id}))['finalized'] is True
        await rpc.dispatch('connect',offer(model,'marin',True))
        config=[row['config'] for row in attempts if 'config' in row][-1]
        assert config['audio']['output']['voice']=='marin'
        if provider=='realtime': assert config['audio']['input']['turn_detection']['interrupt_response'] is True
        assert len([row for row in attempts if 'config' in row])==2
    finally:
        for owner in list(rpc.owners.values()):
            owner.call.final.set(); await rpc.dispatch('end',{'lease':owner.lease})


async def test_provider_refusal_stops_after_the_one_configured_fallback(monkeypatch):
    rpc,attempts,_=fixture(monkeypatch,404)
    with pytest.raises(worker.ProviderError) as error:
        await rpc.dispatch('connect',offer('gpt-realtime-2.1'))
    assert error.value.media_not_executed is True
    assert [row['provider'] for row in attempts]==['realtime','live']
    assert not rpc.owners


async def test_actual_fallback_transport_reports_selected_model_voice_and_no_sdp_in_status(monkeypatch):
    rpc,attempts,callbacks=fixture(monkeypatch,[404,None])
    args=offer('gpt-live-1','quartz')
    args['settings'].update(fallbackModel='gpt-realtime-2.1',fallbackVoice='cedar')
    try:
        result=await rpc.dispatch('connect',args)
        assert [row['provider'] for row in attempts]==['live','realtime']
        assert result['provider']=='realtime' and result['model']=='gpt-realtime-2.1' and result['voice']=='cedar'
        assert result['preferredModel']=='gpt-live-1' and result['fallbackReason']
        assert attempts[1]['config']['audio']['output']['voice']=='cedar'
        statuses=[args['status'] for name,args in callbacks if name=='status']
        assert statuses and statuses[-1]['voice']=='cedar'
        assert 'sdp' not in statuses[-1]
    finally:
        for owner in list(rpc.owners.values()):await rpc.dispatch('end',{'lease':owner.lease})


async def test_interruption_and_hangup_preserve_accepted_delegation_and_final_text(monkeypatch):
    rpc,attempts,callbacks=fixture(monkeypatch)
    entered=asyncio.Event(); release=asyncio.Event(); completed=asyncio.Event()
    original=rpc.callback
    async def callback(name,args):
        if name=='delegate':
            entered.set(); await release.wait(); completed.set(); return {'text':'Accepted backend result'}
        return await original(name,args)
    rpc.callback=callback
    try:
        await rpc.dispatch('connect',offer('gpt-realtime-2.1'))
        call=rpc.owners['owned'].call
        await call.handle({'type':'conversation.item.input_audio_transcription.completed','item_id':'user','transcript':'Exact café 漢字'})
        await call.handle({'type':'response.function_call_arguments.done','call_id':'accepted','name':'amplifier_delegate','arguments':json.dumps({'text':'Keep this accepted work'})})
        await asyncio.wait_for(entered.wait(),1)
        await call.handle({'type':'input_audio_buffer.speech_started'})
        assert rpc.work()['callTasks']==1 and not completed.is_set()
        await call.handle({'type':'response.output_audio_transcript.done','item_id':'final','transcript':'Final café 漢字'})
        ended=await rpc.dispatch('end',{'lease':'owned','id':call.id})
        assert ended=={'closed':True,'finalized':True,'workContinues':True}
        assert rpc.work()['callTasks']==1 and not completed.is_set()
        assert [args['text'] for name,args in callbacks if name=='transcript']==['Exact café 漢字','Final café 漢字']
        release.set(); await asyncio.wait_for(completed.wait(),1)
        await asyncio.gather(*call.tasks)
        assert rpc.work()['callTasks']==0
        assert sum(row.get('path')=='hangup' for row in attempts)==1
        await rpc.dispatch('end',{'lease':'owned'})
        assert sum(row.get('path')=='hangup' for row in attempts)==1
    finally:
        release.set()
        for owner in list(rpc.owners.values()): await rpc.dispatch('end',{'lease':owner.lease})
