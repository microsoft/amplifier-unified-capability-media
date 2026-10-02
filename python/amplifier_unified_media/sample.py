import array, asyncio, base64, io, sys, wave
import aiohttp
SAMPLE="Hello! I'm ready to help."

def wav_audio(pcm):
    if len(pcm) < 4800:
        raise ValueError('The voice provider returned no usable audio. Try again.')
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(24000)
        output.writeframes(pcm[:len(pcm)//2*2])
    return base64.b64encode(buffer.getvalue()).decode()


async def render_sample(manager, model, voice):
    """Bound provider time, message size, audio length and silence-clock lifetime."""
    live = model == 'gpt-live-1'
    url = 'wss://api.openai.com/v1/live/sessions' if live else 'wss://api.openai.com/v1/realtime?model='+model
    if manager.http is None:
        manager.http = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30))
    async with manager.http.ws_connect(url, headers=manager.headers, max_msg_size=2*1024*1024,
                                       timeout=aiohttp.ClientWSTimeout(ws_close=2)) as socket:
        instruction = 'Speak now in English. Say only: "'+SAMPLE+'". Then remain silent. Do not delegate.'
        if live:
            await socket.send_json({'type':'session.start', 'session':{
                'model':model, 'instructions':'You are demonstrating a voice. Never delegate.',
                'audio':{'format':{'type':'audio/pcm','rate':24000},'output':{'voice':voice}},
                'delegation':{'type':'client'},'store':False}})
        else:
            await socket.send_json({'type':'session.update', 'session':{
                'type':'realtime','model':model,'output_modalities':['audio'],
                'audio':{'input':{'turn_detection':None},'output':{'voice':voice,'format':{'type':'audio/pcm','rate':24000}}},
                'tools':[],'tool_choice':'none'}})
        clock = None
        audio = bytearray()
        started = False
        speech_seen = False
        trailing_silence = 0
        async def silence():
            chunk = base64.b64encode(bytes(4800)).decode()  # 100 ms, paced in real time.
            while True:
                await socket.send_json({'type':'session.input_audio.append','audio':chunk})
                await asyncio.sleep(.1)
        try:
            async with asyncio.timeout(24):
                while len(audio) < 6*48000:
                    event = await socket.receive_json(timeout=15)
                    kind = event.get('type')
                    if kind == 'error':
                        raise ValueError('The voice provider could not create this sample. Check model access and your API key.')
                    if not started and kind == ('session.started' if live else 'session.updated'):
                        started = True
                        if live:
                            clock = asyncio.create_task(silence())
                            await socket.send_json({'type':'session.instructions.append','event_id':'voice_sample','delegation_id':None,'content':instruction})
                        else:
                            await socket.send_json({'type':'response.create','response':{'instructions':instruction,'max_output_tokens':200}})
                    if kind == ('session.output_audio.delta' if live else 'response.output_audio.delta'):
                        chunk = base64.b64decode(event.get('delta',''), validate=True)
                        if live:
                            samples = array.array('h', chunk[:len(chunk)//2*2])
                            if sys.byteorder != 'little': samples.byteswap()
                            speaking = any(abs(value) > 500 for value in samples)
                            if speaking:
                                speech_seen = True
                                trailing_silence = 0
                            elif speech_seen:
                                trailing_silence += len(chunk)
                            else:
                                # Retain 100 ms of lead-in, not the startup silence.
                                audio[:] = (audio + chunk)[-4800:]
                                continue
                        audio.extend(chunk)
                        if live and len(audio) >= 48000 and trailing_silence >= 28800:
                            # End after 600 ms of silence instead of a fixed
                            # ten-second wait for continuous Live audio.
                            audio[:] = audio[:len(audio)-trailing_silence+5760]
                            break
                    if kind == 'response.done' and not live:
                        if event.get('response',{}).get('status') not in {None,'completed'}:
                            raise ValueError('The voice sample did not finish. Check your API account and try again.')
                        break
                    if kind in {'session.closed','session.delegation.created'}:
                        break
        finally:
            if clock:
                clock.cancel()
                await asyncio.gather(clock, return_exceptions=True)
            if live and started and not socket.closed:
                await socket.send_json({'type':'session.close'})
                try:
                    async with asyncio.timeout(2):
                        while (await socket.receive_json()).get('type') != 'session.closed': pass
                except (TimeoutError, aiohttp.ClientError, TypeError):
                    pass
        if live and not speech_seen:
            raise ValueError('No speech was returned for this preview.')
        return wav_audio(audio[:6*48000])

