import pytest
IDENTITY=dict(installationId='installation',dataScope='private',ownerId='platform-owner',instanceId='host-one',releaseDigest='signed-release')
CONTEXT=dict(fenceId='service-fence',commandId='stop',purpose='service-stop',instanceId='host-one',dataScope='private',serviceIdentity=IDENTITY)
def proof(outcome='ready'):
    observed={**IDENTITY,'instanceId':'host-two' if outcome=='ready' else 'host-one'}
    return dict(verified=True,fenceId='service-fence',commandId='stop',outcome=outcome,instanceId=observed['instanceId'],dataScope='private',receiptId='settled',kind='service-lifecycle',serviceOutcome='resumed' if outcome=='ready' else 'stop-refused',expected=dict(IDENTITY),observed=observed,**(dict(resumeCommandId='resume',exitReceiptId='owned-exit',readyReceiptId='ready') if outcome=='ready' else dict(refusalReceiptId='no-effect')))

from amplifier_unified_media.worker import Rpc
ARGS=dict(ownerId='media',context=CONTEXT)
@pytest.mark.asyncio
async def test_worker_advertises_service_support_and_retains_complete_identity():
    worker=Rpc();worker.send=lambda _:None
    assert (await worker.dispatch('quiescence.inspect',{}))['serviceStop']['version']==1
    assert (await worker.dispatch('quiescence.acquire',ARGS))['held']
    assert worker.fence['serviceIdentity']==IDENTITY
    for field in IDENTITY:
        wrong=proof();wrong['expected'][field]='foreign'
        with pytest.raises(ValueError):await worker.dispatch('quiescence.release',{**ARGS,'outcome':'ready','proof':wrong})
    assert (await worker.dispatch('quiescence.release',{**ARGS,'outcome':'ready','proof':proof()}))['released']
    assert (await worker.dispatch('quiescence.release',{**ARGS,'outcome':'ready','proof':proof()}))['duplicate']
    with pytest.raises(ValueError):await worker.dispatch('quiescence.release',{**ARGS,'outcome':'ready','proof':{**proof(),'readyReceiptId':'changed'}})
@pytest.mark.asyncio
async def test_worker_unknown_cannot_gain_a_live_rollback_lease():
    worker=Rpc();worker.send=lambda _:None
    await worker.dispatch('quiescence.acquire',ARGS)
    assert not (await worker.dispatch('quiescence.release',{**ARGS,'outcome':'unknown'}))['released']
    await worker.dispatch('quiescence.acquire',ARGS)
    with pytest.raises(ValueError):await worker.dispatch('quiescence.release',{**ARGS,'outcome':'unchanged','proof':{'kind':'admission-refused'}})
    assert (await worker.dispatch('quiescence.release',{**ARGS,'outcome':'unchanged','proof':proof('unchanged')}))['released']
