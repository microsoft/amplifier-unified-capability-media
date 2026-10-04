import pytest
from amplifier_unified_media import worker

@pytest.mark.asyncio
@pytest.mark.parametrize('status,identified',[(401,False),(403,False),(404,False),(429,False),(401,True)])
async def test_provider_refusal_execution_proof(monkeypatch,status,identified):
    class Call:
        def __init__(self,*args):
            self.id='';self.closed=False;self.tasks=set();self.pump=None;self.observer=None
        async def create(self,*args):
            if identified:self.id='known-call'
            raise worker.ProviderError(status,'fixture','private-provider-text')
        async def close(self):self.closed=True
    monkeypatch.setattr(worker,'VoiceCall',Call)
    rpc=worker.Rpc();sent=[];rpc.send=sent.append
    await rpc.handle({'id':1,'method':'connect','params':{'lease':'owned','session':'selected','clientId':'client','apiKey':'synthetic-secret','sdp':'v=0','provider':'live'}})
    reply=next(row for row in sent if row.get('id')==1)
    assert reply['error']['data']=={'source':'voice-provider','status':status,**({} if identified else {'executed':False})}
    assert 'synthetic-secret' not in str(sent)
    assert not rpc.owners

@pytest.mark.asyncio
async def test_transport_loss_has_no_execution_proof(monkeypatch):
    class Call:
        def __init__(self,*args):self.id='';self.closed=False;self.tasks=set();self.pump=None;self.observer=None
        async def create(self,*args):raise RuntimeError('synthetic-secret')
        async def close(self):self.closed=True
    monkeypatch.setattr(worker,'VoiceCall',Call)
    rpc=worker.Rpc();sent=[];rpc.send=sent.append
    await rpc.handle({'id':1,'method':'connect','params':{'lease':'owned','session':'selected','clientId':'client','apiKey':'synthetic-secret','sdp':'v=0','provider':'live'}})
    reply=next(row for row in sent if row.get('id')==1)
    assert 'data' not in reply['error']
    assert 'synthetic-secret' not in str(sent)
