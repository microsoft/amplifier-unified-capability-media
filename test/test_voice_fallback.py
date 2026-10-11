"""Call admission and error boundaries with offline transport doubles."""
import pytest
from amplifier_unified_media import worker


@pytest.mark.parametrize('status,code,identified,provider,fallback,expected',[
    (404,'',False,'auto','gpt-realtime-2.1',2),
    (403,'',False,'auto','gpt-realtime-2.1',2),
    (400,'unsupported_model',False,'auto','gpt-realtime-2.1',2),
    (400,'invalid_request',False,'auto','gpt-realtime-2.1',1),
    (401,'',False,'auto','gpt-realtime-2.1',1),
    (429,'',False,'auto','gpt-realtime-2.1',1),
    (404,'',True,'auto','gpt-realtime-2.1',1),
    (404,'',False,'live','gpt-realtime-2.1',1),
    (404,'',False,'auto','',1),
    (404,'',False,'auto','gpt-live-1',1),
    (404,'',False,'auto','unadvertised',1),
])
async def test_fallback_only_after_conclusive_pre_call_model_rejection(monkeypatch,status,code,identified,provider,fallback,expected):
    attempts=[];admissions=[];statuses=[]
    class Call:
        def __init__(self,*args):
            self.id='';self.closed=False;self.tasks=set();self.pump=self.observer=None
        async def require_admission(self):admissions.append(True)
        async def create(self,sdp,selected):
            attempts.append((selected,self.voice_name,self.interruptions))
            if len(attempts)==1:
                if identified:self.id='already-allocated'
                raise worker.ProviderError(status,code)
            self.id='fallback-call'
            return {'id':self.id,'sdp':'private-answer','model':worker.MODELS[selected],'voice':self.voice_name,'provider':selected}
        async def close(self):self.closed=True
    monkeypatch.setattr(worker,'VoiceCall',Call)
    rpc=worker.Rpc();rpc.send=lambda _:None
    async def callback(name,args):
        if name=='status':statuses.append(args)
        return {}
    rpc.callback=callback
    params={'lease':'owned','session':'selected','clientId':'client','apiKey':'synthetic','sdp':'v=0','provider':provider,
            'settings':{'preferredModel':'gpt-live-1','voice':'quartz','fallbackModel':fallback,'fallbackVoice':'cedar','interruptions':False}}
    try:
        if expected==2:
            result=await rpc.dispatch('connect',params)
            assert result['model']=='gpt-realtime-2.1' and result['voice']=='cedar'
            assert result['preferredModel']=='gpt-live-1' and result['fallbackReason']
            assert attempts==[('live','quartz',False),('realtime','cedar',False)]
            assert admissions==[True]
            assert 'private-answer' not in str(statuses)
        else:
            with pytest.raises(worker.ProviderError):await rpc.dispatch('connect',params)
            assert len(attempts)==1 and not admissions and not rpc.owners
    finally:
        for owner in rpc.owners.values():await owner.call.close();await owner.http.close()


@pytest.mark.parametrize('failure',['admission','fallback-rejection','fallback-unknown','fallback-allocated'])
async def test_fallback_stops_at_new_fence_or_second_failure(monkeypatch,failure):
    attempts=[]
    class Call:
        def __init__(self,*args):self.id='';self.closed=False;self.tasks=set();self.pump=self.observer=None
        async def require_admission(self):
            if failure=='admission':raise worker.VoiceError('Intake held')
        async def create(self,sdp,provider):
            attempts.append((provider,self.voice_name))
            if len(attempts)==1:raise worker.ProviderError(404)
            if failure=='fallback-rejection':raise worker.ProviderError(400,'unsupported_model')
            if failure=='fallback-allocated':self.id='allocated'
            raise RuntimeError('private transport detail')
        async def close(self):self.closed=True
    monkeypatch.setattr(worker,'VoiceCall',Call)
    rpc=worker.Rpc();sent=[];rpc.send=sent.append
    await rpc.handle({'id':1,'method':'connect','params':{'lease':'owned','session':'selected','clientId':'client','apiKey':'synthetic','sdp':'v=0',
        'settings':{'preferredModel':'gpt-live-1','fallbackModel':'gpt-realtime-2.1','voice':'quartz'}}})
    error=next(row['error'] for row in sent if row.get('id')==1)
    assert len(attempts)==(1 if failure=='admission' else 2)
    if len(attempts)==2:assert attempts[1]==('realtime','marin')
    if failure in ('admission','fallback-rejection'):assert error['data']['executed'] is False
    else:assert 'data' not in error
    assert 'private transport detail' not in str(error)
    assert not rpc.owners and not any(rpc.work().values())
