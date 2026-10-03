"""Private worker gate; no microphone, provider, device, or model access."""
import asyncio
import base64
import json
import struct
import sys
import zlib
from types import SimpleNamespace

import pytest
from amplifier_unified_media.worker import Rpc
from amplifier_unified_media.voice import VoiceCall

CONTEXT = dict(fenceId='fixture-fence', commandId='fixture-command', purpose='recovery', instanceId='host-one', dataScope='owned-media')
ARGS = dict(ownerId='media', context=CONTEXT)
PROOF = dict(verified=True, fenceId=CONTEXT['fenceId'], commandId=CONTEXT['commandId'], outcome='unchanged', instanceId='host-one', dataScope='owned-media', receiptId='private-owner-proof')

def png():
    def chunk(kind, body):
        return struct.pack('!I', len(body)) + kind + body + struct.pack('!I', zlib.crc32(kind + body))
    return base64.b64encode(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!IIBBBBB', 1, 1, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b'\0\xff\0\0')) + chunk(b'IEND', b'')).decode()

@pytest.mark.asyncio
async def test_async_effect_must_finish_before_gate_and_notification_is_advisory():
    rpc = Rpc(); sent = []; rpc.send = sent.append
    entered = asyncio.Event(); done = asyncio.Event()
    async def execute(method, args):
        entered.set(); await done.wait(); return {'finished': True}
    rpc.execute = execute
    task = asyncio.create_task(rpc.dispatch('bounded-fixture', {})); await entered.wait()
    refused = await rpc.dispatch('quiescence.acquire', ARGS)
    assert refused['held'] is False and refused['executed'] is False
    done.set(); assert await task == {'finished': True}
    assert sent[-1]['method'] == 'quiescence/mayBeIdle'
    assert (await rpc.dispatch('quiescence.acquire', ARGS))['held']
    with pytest.raises(ValueError, match='intake closed'):
        await rpc.dispatch('connect', {})
    assert (await rpc.dispatch('quiescence.inspect', {}))['intakeClosed']
    with pytest.raises(ValueError, match='proof'):
        await rpc.dispatch('quiescence.release', {**ARGS, 'outcome': 'unchanged', 'proof': {**PROOF, 'commandId': 'wrong'}})
    assert not (await rpc.dispatch('quiescence.release', {**ARGS, 'outcome': 'unknown'}))['released']
    assert (await rpc.dispatch('quiescence.release', {**ARGS, 'outcome': 'unchanged', 'proof': PROOF}))['released']
    with pytest.raises(ValueError, match='cannot reacquire'):
        await rpc.dispatch('quiescence.acquire', ARGS)

@pytest.mark.asyncio
async def test_hangup_does_not_hide_retained_delegation_or_transport_tasks():
    rpc = Rpc(); rpc.send = lambda _: None
    done = asyncio.Event(); task = asyncio.create_task(done.wait())
    class ClosedCall:
        closed = True; tasks = {task}; pump = None; observer = None
    call = ClosedCall(); rpc.calls.add(call)
    refused = await rpc.dispatch('quiescence.acquire', ARGS)
    assert refused['counts']['callTasks'] == 1
    call.tasks = set(); call.pump = task
    assert (await rpc.dispatch('quiescence.acquire', ARGS))['counts']['transportTasks'] == 1
    done.set(); await task
    assert (await rpc.dispatch('quiescence.acquire', ARGS))['held']

@pytest.mark.asyncio
async def test_actual_voice_background_completion_emits_wakeup_after_task_removed():
    changed = asyncio.Event(); call = VoiceCall.__new__(VoiceCall); call.tasks = set()
    call.owner = SimpleNamespace(work_changed=lambda: changed.set())
    done = asyncio.Event(); call.background(done.wait()); assert len(call.tasks) == 1
    done.set(); await changed.wait(); assert not call.tasks

@pytest.mark.asyncio
async def test_context_bounded_and_recent_release_cache_bounded():
    rpc = Rpc(); rpc.send = lambda _: None
    with pytest.raises(ValueError, match='Bounded'):
        await rpc.dispatch('quiescence.acquire', {**ARGS, 'context': {**CONTEXT, 'fenceId': 'x'*201}})
    for n in range(260):
        context = {**CONTEXT, 'fenceId': str(n)}
        await rpc.dispatch('quiescence.acquire', {**ARGS, 'context': context})
        await rpc.dispatch('quiescence.release', {**ARGS, 'context': context, 'outcome': 'unchanged', 'proof': {'kind': 'admission-refused'}})
    assert len(rpc.released) == 256

@pytest.mark.asyncio
async def test_actual_stdio_worker_gate_has_no_device_or_provider_effect():
    child = await asyncio.create_subprocess_exec(sys.executable, '-m', 'amplifier_unified_media.worker', stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    counter = 0; notices = []
    async def request(method, params):
        nonlocal counter
        counter += 1; identity = counter
        child.stdin.write((json.dumps(dict(jsonrpc='2.0', id=identity, method=method, params=params))+'\n').encode()); await child.stdin.drain()
        while True:
            line = await asyncio.wait_for(child.stdout.readline(), 5)
            assert line, (await child.stderr.read()).decode()
            row = json.loads(line)
            if row.get('method'): notices.append(row); continue
            assert row['id'] == identity
            return row
    try:
        assert (await request('image.validate', {'image': png()}))['result'] == {'width': 1, 'height': 1}
        assert (await request('quiescence.acquire', ARGS))['result']['held']
        assert 'intake closed' in (await request('native.capture', {}))['error']['message']
        assert (await request('quiescence.inspect', {}))['result']['intakeClosed']
        assert (await request('quiescence.release', {**ARGS, 'outcome': 'unchanged', 'proof': PROOF}))['result']['released']
        assert (await request('image.validate', {'image': png()}))['result']['width'] == 1
        assert notices and all(row['method'] == 'quiescence/mayBeIdle' for row in notices)
    finally:
        child.stdin.close(); await asyncio.wait_for(child.wait(), 5)
