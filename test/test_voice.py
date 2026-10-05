import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock
import pytest
from amplifier_unified_media.voice import VoiceCall, compact_context, MODELS
from amplifier_unified_media.voice_diagnostics import VoiceDiagnostics
class Socket:
    closed=False
    def __init__(self): self.sent=[];self.stopped=asyncio.Event()
    async def send_json(self,event):self.sent.append(event)
    async def close(self):self.closed=True;self.stopped.set()
    def __aiter__(self):return self
    async def __anext__(self):await self.stopped.wait();raise StopAsyncIteration
class Owner:
    client_id='browser-one'
    def __init__(self):
        self.context={'title':'Selected','messages':[]};self.admit=AsyncMock();self.record_voice_transcript=AsyncMock();self.set_voice_status=AsyncMock();self.record_voice_usage=AsyncMock();self.delegate=AsyncMock(return_value={'response':'verified'});self.queue=asyncio.Queue(maxsize=1)
    async def inspect(self):return self.context
    def subscribe(self):return self.queue
    def unsubscribe(self,q):pass

def call():
    owner=Owner();socket=Socket();manager=SimpleNamespace(owner=owner,api_key='fixture-secret',headers={},http=SimpleNamespace(ws_connect=AsyncMock(return_value=socket)),protocol_diagnostics=VoiceDiagnostics(None),request=AsyncMock(return_value=({'session':{'id':'live-one'},'transport':{'sdp':'answer'}},'answer',{'Location':'/v1/realtime/calls/realtime-one'})))
    return VoiceCall(manager,'ahp-session:/one'),owner,socket,manager
@pytest.mark.parametrize('provider',['live','realtime'])
async def test_preserved_provider_transport_and_only_delegation_tool(provider):
    c,o,s,m=call();result=await c.create('v=0',provider);assert result['model']==MODELS[provider];assert o.admit.await_count==1
    if provider=='live':
        config=m.request.call_args.kwargs['json']['session']
        assert config['delegation']=={'type':'client'}
        assert all(label in config['instructions'] for label in ('Backchannel policy:', 'Interruption policy:', 'Delegation policy:', 'Do not delegate to the backend when:', 'omit greetings already exchanged'))
    else:assert m.request.call_args.args==('POST','/realtime/calls')
    c.final.set();await c.close()
async def test_transcript_dedupe_without_prompt_execution():
    c,o,_,_=call();c.id='live-one';event={'type':'session.input_transcript.delta','delta':'Please check','end_ms':100,'event_id':'1'}
    await c.handle(event);await c.handle(event);await c.handle({**event,'event_id':'2','delta':' this','end_ms':200})
    assert o.record_voice_transcript.await_count==2;assert o.delegate.await_count==0;assert c.user_text=='Please check this';assert o.record_voice_transcript.call_args.kwargs['append']
async def test_hangup_keeps_admitted_work():
    c,o,s,m=call();c.id='live-one';c.socket=s;wait=asyncio.Event()
    async def delegated(*args,**kwargs):await wait.wait();return {'response':'verified'}
    o.delegate.side_effect=delegated;await c.record('user','Do work','u');c.background(c.delegate_live('d'));await asyncio.sleep(0);task=next(iter(c.tasks));c.final.set();result=await c.close();assert result['workContinues'];assert not task.cancelled();wait.set();await task;assert not s.sent
async def test_bounded_context_has_no_private_ui_or_estate():
    text=compact_context({'title':'Chosen','sessions':[{'title':'SECRET'}],'view':{'draft':'PRIVATE'},'messages':[{'text':'x'*10000,'role':'user'}]*100},'s');assert 'SECRET' not in text and 'PRIVATE' not in text;assert len(text)<6000
async def test_completion_speech_cannot_execute_tools():
    c,o,s,m=call();c.id='rtc';c.provider='realtime';c.socket=s;c.realtime_pending_response=True;await c.flush_realtime_response();assert s.sent[0]['response']['tool_choice']=='none';c.closed=True
