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
async def test_live_seeds_roles_and_delegates_plain_user_text_with_identity():
    c,o,s,m=call()
    o.context['messages']=[{'role':'user','text':'Good morning','via':'call'},{'role':'assistant','text':'Hello!','via':'call'}]
    await c.create('v=0','live')
    config=m.request.call_args.kwargs['json']['session']
    assert [row['role'] for row in config['input']]==['user','assistant']
    await c.record('user','What can you help with?','spoken-one')
    await c.delegate_live('delegation-one')
    args=o.delegate.call_args
    assert args.args==('What can you help with?',)
    assert args.kwargs['delivery']['sourceItemIds']==['spoken-one']
    assert args.kwargs['delivery']['context'][0]['text']=='Good morning'
    c.final.set();await c.close()

async def test_typed_result_retries_only_known_busy_and_speaks_once():
    c,o,s,m=call();c.id='live-one';c.socket=s
    o.record_delivery=AsyncMock(side_effect=[{'recorded':False,'reason':'busy','retryable':True,'executed':False},{'recorded':True}])
    snapshot={'generations':[{'event':'generation.finished','generation_id':'typed-one','input_ids':['typed-one'],'response':'An answer'}]}
    await c.announce_generations(snapshot);await c.announce_generations(snapshot)
    assert o.record_delivery.await_count==2 and len(s.sent)==1
    assert 'typed-one' in c.delivered_generations
    c.closed=True

async def test_delegation_offset_does_not_consume_a_later_question():
    c,o,s,m=call();c.id='live-one';c.socket=s
    await c.record('user','Check tools','u1',delta=True,start=10,at=100)
    await c.record('user','Now file feedback','u2',delta=True,start=300,at=400)
    await c.delegate_live('first',200)
    assert o.delegate.call_args.args==('Check tools',)
    assert o.delegate.call_args.kwargs['delivery']['sourceItemIds']==['u1']
    await c.delegate_live('second',500)
    assert o.delegate.call_args.args==('Now file feedback',)
    assert o.delegate.await_count==2

async def test_late_answer_requests_durable_fallback_without_speech():
    c,o,s,m=call();c.id='live-one';c.socket=s;wait=asyncio.Event()
    o.record_result_fallback=AsyncMock()
    async def delegated(*args,**kwargs):
        await wait.wait()
        return {'text':'Saved answer','generation_id':'turn','completed':True,'status':'completed'}
    o.delegate.side_effect=delegated
    await c.record('user','Check tools','u')
    task=asyncio.create_task(c.delegate_live('d'));await asyncio.sleep(0)
    c.closed=True;wait.set();await task
    o.record_result_fallback.assert_awaited_once_with('voice:live-one:d')
    assert not s.sent

def test_context_retains_facts_and_is_always_parseable():
    import json
    context={'title':'t'*10000,'activity':{'status':'working','activeTurnId':'turn','executionRevision':7,'private':'secret'},'selection':[{'id':'model','value':'Astra'}],
             'capabilities':{'actions':['feedback.submit','feedback.receipt'],'secret':'private'},'messages':[{'role':'user','text':'x'*10000}]*40}
    data=json.loads(compact_context(context,'session'))
    assert data['activity']=={'status':'working','activeTurnId':'turn','executionRevision':7}
    assert data['selection'][0]['value']=='Astra'
    assert 'feedback.submit' in data['capabilities']['actions']
    assert data['capabilities']['nativeTools']=='not-inspected'
    assert 'private' not in json.dumps(data)

def test_pending_outcome_never_reads_progress_as_success():
    from amplifier_unified_media.voice import result_text
    value=result_text({'completed':False,'status':'dispatching','workContinues':True,'text':'I filed it'})
    assert 'still running' in value and 'I filed it' not in value

async def test_answered_exchange_is_reference_not_repeated_request():
    c,o,s,m=call();c.id='live-one';c.socket=s
    await c.record('user','What tools do you have?',delta=True,start=0,at=100)
    await c.record('assistant','I can check the current tools.',delta=True,start=150,at=200)
    await c.record('user','Please check.',delta=True,start=250,at=350)
    await c.delegate_live('d',400)
    assert o.delegate.call_args.args==('Please check.',)
    reference=o.delegate.call_args.kwargs['delivery']['context']
    assert reference==[{'role':'user','text':'What tools do you have?'},{'role':'assistant','text':'I can check the current tools.'}]

async def test_completed_result_survives_failed_voice_delivery_without_replay():
    c,o,s,m=call();c.id='live-one';c.socket=s
    o.record_result_fallback=AsyncMock()
    o.delegate.return_value={'text':'Saved answer','generation_id':'turn','completed':True,'status':'completed'}
    s.send_json=AsyncMock(side_effect=ConnectionError('closed'))
    await c.record('user','Check tools','u')
    await c.delegate_live('d')
    assert o.delegate.await_count==1
    o.record_result_fallback.assert_awaited_once_with('voice:live-one:d')

def test_capability_catalog_does_not_evict_recent_conversation():
    import json
    context={'messages':[{'role':'user','text':'Already greeted'},{'role':'assistant','text':'Already answered'}],
        'capabilities':{'nativeTools':'inspected','tools':[{'name':str(i),'description':'x'*120} for i in range(48)],'actions':['x'*100]*80}}
    data=json.loads(compact_context(context,'session'))
    assert data['recent_messages']==context['messages']
    assert len(json.dumps(data,ensure_ascii=False))<=5900

async def test_oversized_spoken_request_is_not_silently_submitted_in_part():
    c,o,s,m=call();c.id='live-one';c.socket=s
    for i in range(513):await c.record('user','word ','u',delta=True,start=i,at=i+1)
    await c.delegate_live('d',600)
    assert o.delegate.await_count==0
    assert len(c.user_fragments)==512
    assert 'No new work was submitted' in ''.join(e['content'] for e in s.sent)
