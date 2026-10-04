"""Private worker evidence is process-local; the Node gate owns durability."""
import pytest
from amplifier_unified_media.worker import Rpc

CONTEXT=dict(fenceId='owned-fence',commandId='owned-command',purpose='distribution-update',instanceId='owned-instance',dataScope='owned-scope')
ARGS=dict(ownerId='media',context=CONTEXT)
PROOF=dict(kind='distribution-admission-abort',verified=True,purpose='distribution-update',receiptId='supervisor-proof',**{k:CONTEXT[k] for k in ('commandId','fenceId','instanceId','dataScope')})

@pytest.mark.asyncio
async def test_exact_abort_retry_does_not_execute_effects_or_reacquire():
    rpc=Rpc();assert (await rpc.dispatch('quiescence.acquire',ARGS))['held']
    result=await rpc.dispatch('quiescence.abortAdmission',{**ARGS,'proof':PROOF})
    assert result['status']=='released' and rpc.fence is None
    assert await rpc.dispatch('quiescence.abortAdmission',{**ARGS,'proof':dict(reversed(list(PROOF.items())))})==result
    assert rpc.effects==0
    with pytest.raises(ValueError,match='cannot reacquire'):await rpc.dispatch('quiescence.acquire',ARGS)
    with pytest.raises(ValueError,match='retained proof'):await rpc.dispatch('quiescence.abortAdmission',{**ARGS,'proof':{**PROOF,'receiptId':'changed'}})

@pytest.mark.asyncio
async def test_original_busy_refusal_is_required_and_pending_effect_must_settle():
    rpc=Rpc();rpc.effects=1
    assert (await rpc.dispatch('quiescence.acquire',ARGS))['held'] is False
    with pytest.raises(ValueError,match='pending'):await rpc.dispatch('quiescence.abortAdmission',{**ARGS,'proof':PROOF})
    rpc.effects=0
    assert (await rpc.dispatch('quiescence.abortAdmission',{**ARGS,'proof':PROOF}))['status']=='not-acquired'

@pytest.mark.asyncio
async def test_process_replacement_or_missing_fence_is_not_nonacquisition_proof():
    rpc=Rpc()
    with pytest.raises(ValueError,match='attempt unavailable'):await rpc.dispatch('quiescence.abortAdmission',{**ARGS,'proof':PROOF})
    await rpc.dispatch('quiescence.acquire',ARGS);rpc.fence=None
    with pytest.raises(ValueError,match='authoritatively accounted'):await rpc.dispatch('quiescence.abortAdmission',{**ARGS,'proof':PROOF})
    replacement=Rpc()
    with pytest.raises(ValueError,match='attempt unavailable'):await replacement.dispatch('quiescence.abortAdmission',{**ARGS,'proof':PROOF})

@pytest.mark.asyncio
@pytest.mark.parametrize('key',['ownerId','commandId','fenceId','instanceId','dataScope'])
async def test_stale_owner_or_context_keeps_held_gate(key):
    rpc=Rpc();await rpc.dispatch('quiescence.acquire',ARGS)
    args={**ARGS,'proof':PROOF}
    if key=='ownerId':args[key]='other'
    else:
        args['context']={**CONTEXT,key:'other'};args['proof']={**PROOF,key:'other'}
    with pytest.raises(ValueError):await rpc.dispatch('quiescence.abortAdmission',args)
    assert rpc.fence is not None

@pytest.mark.asyncio
@pytest.mark.parametrize('proof',[{'kind':'admission-refused'},{**PROOF,'kind':'distribution-release'},{**PROOF,'extra':True},{**PROOF,'verified':1}])
async def test_generic_or_malformed_proof_cannot_authorize_abort(proof):
    rpc=Rpc();await rpc.dispatch('quiescence.acquire',ARGS)
    with pytest.raises(ValueError,match='abort proof'):await rpc.dispatch('quiescence.abortAdmission',{**ARGS,'proof':proof})
    assert rpc.fence is not None

@pytest.mark.asyncio
async def test_completed_generic_release_is_not_reclassified_as_admission_abort():
    rpc=Rpc();await rpc.dispatch('quiescence.acquire',ARGS)
    await rpc.dispatch('quiescence.release',{**ARGS,'outcome':'unchanged','proof':{'kind':'admission-refused'}})
    with pytest.raises(ValueError,match='authoritatively accounted'):await rpc.dispatch('quiescence.abortAdmission',{**ARGS,'proof':PROOF})
