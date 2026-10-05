"""Actual worker selection logic with a no-network call fixture, never audio acceptance."""
import pytest
from amplifier_unified_media import worker


@pytest.mark.parametrize('preferred,expected', [('gpt-live-1','live'),('gpt-realtime-2.1','realtime')])
async def test_future_auto_call_uses_supplied_confirmed_defaults(monkeypatch,preferred,expected):
    attempts=[]
    class Call:
        def __init__(self,owner,session):
            self.owner=owner;self.closed=False;self.tasks=set();self.pump=None;self.observer=None
        async def create(self,sdp,provider):
            attempts.append((provider,self.voice_name,self.interruptions));return {'id':'fixture','sdp':'fixture-answer'}
        async def close(self):self.closed=True;return {'closed':True,'finalized':True}
    monkeypatch.setattr(worker,'VoiceCall',Call)
    rpc=worker.Rpc();rpc.send=lambda _:None
    async def callback(name,args):return {}
    rpc.callback=callback
    try:
        result=await rpc.dispatch('connect',{'lease':'fixture','session':'owned','clientId':'client','apiKey':'fixture-only','sdp':'v=0','settings':{'preferredModel':preferred,'fallbackModel':'gpt-live-1','voice':'cedar','interruptions':False}})
        assert result['id']=='fixture'
        assert attempts==[(expected,'cedar',False)]
    finally:
        for owner in rpc.owners.values():await owner.http.close()


async def test_failed_preferred_call_does_not_claim_or_attempt_automatic_fallback(monkeypatch):
    attempts=[]
    class Call:
        def __init__(self,owner,session):self.closed=False;self.tasks=set();self.pump=None;self.observer=None
        async def create(self,sdp,provider):attempts.append(provider);raise worker.VoiceError('Fixture preferred model refused')
        async def close(self):self.closed=True;return {'closed':True,'finalized':True}
    monkeypatch.setattr(worker,'VoiceCall',Call)
    rpc=worker.Rpc();rpc.send=lambda _:None
    with pytest.raises(worker.VoiceError,match='preferred model refused'):
        await rpc.dispatch('connect',{'lease':'fixture','session':'owned','clientId':'client','apiKey':'fixture-only','sdp':'v=0','settings':{'preferredModel':'gpt-live-1','fallbackModel':'gpt-realtime-2.1','voice':'marin'}})
    assert attempts==['live']
    assert not rpc.owners
    assert not any(rpc.work().values())
