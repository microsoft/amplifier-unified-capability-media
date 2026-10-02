# Amplifier Unified media capability

Independent media owner for the Unified host. It does not import the host, Core,
Foundation, AppService, or client source. Browser audio goes directly over WebRTC;
only scoped signalling crosses the authenticated HTTP media plane. The optional
Python worker preserves the existing GPT-Live and GPT-Realtime sideband protocol,
transcript deduplication, generation correlation and hangup-with-work-continuing
semantics. It has no global app-state subscription.

`createMediaCapability` takes durable private `directory`, `inspectSession`,
`delegate`, `recordTranscript`, and optional `recordUsage`, `subscribeSession`,
`resolveCredential`, `settings`, `configure`, `recordCapture`, `clientPresent`,
`nativeStatus`, `nativeCapture`, `enableNative`, `onChanged`, `python` callbacks.

- `inspectSession(sessionURI)` returns bounded title/activity/messages/workers.
- `subscribeSession(sessionURI, onBoundedContext)` returns an unsubscribe or promise.
- `delegate({session,clientId,commandId,text,attachments?})` admits ordinary host
  input and waits for its identified completion. It must return busy/unknown
  honestly and must not replay a prior command. Attachments use standard AHP
  embeddedResource typed image data from one fresh explicitly captured frame.
- `recordTranscript({session,callId,itemId,role,text,append,commandId})` invokes the
  negotiated native writer. Only `recorded:true` is native durability. The exact
  native `busy/retryable/executed:false` result stays pending; transport uncertainty
  stays unknown and is never automatically retried. `flushTranscripts(session)`
  retries only that exact known-busy outcome on a selected session update, including after restart. Unattempted adjacent deltas coalesce for 100 ms in a durable SQLite intent spool; content freezes before the first native attempt. Indexed queries drain at most 64 entries for one session and never scan historical files. This spool is not native transcript authority.
- `recordCapture(metadata)` optionally records a passive historical image reference
  using native capability; media owns immutable validated PNG bytes and metadata.
- Credentials are supplied through `resolveCredential(session)` only when needed;
  no credential, SDP or audio payload is retained in capability state or receipts.

Compose `manifest`, `read`, `action`, `resourceProvider` into the host registry.
Call actions with trusted `{account,clientId}`. `media.attach` allocates a
memory-only token bound to that identity and session; it does not acquire devices.
Mount `handleMedia(req,res,{account,origin})` before gateway static routing at
`/media/*`. A Fetch adapter `handleFetch(request,{account})` supports other servers.
The provider validates the `X-Amplifier-Media-Lease` header; query-string credentials
and arbitrary client-id headers are not used. Account comes only from the gateway.
The gateway must enforce same-origin requests and request limits. Provider body
limit is 750 KB, and image validation requires complete PNG <=500 KB/1280 pixels.

AHP voice resources contain settings and at most 50 native-durable transcript
rows for one selected conversation. There are no client drafts, device settings,
media streams or full history snapshots. Shared updates do not seize client UI.
Resource watches invalidate only this selected topic. Immutable frame URIs carry
session and content hash; the host authenticates access before routing resourceRead.

Client mute, playback, wake locks and selected device tracks stay client-owned.
Screen permission is explicit, memory-only, client/session-bound and lasts at most
15 minutes; detach/revoke invalidates pending requests. There is no background
capture, replay after restart or implicit permission prompt. Native foreground
observation is opt-in with `enableNative:true`; it uses the existing bounded fixed
helper and optional computer-use library. It grants no desktop control. There is
no new camera feature.

Install the Python transport separately: `uv sync --extra openai` (optional native
library must be installed in that same interpreter). Pass the resulting Python
path to the factory. Node-only fixture peers need no Python dependencies.

Verification: `npm test`; `uv run --extra test python -m pytest -q`. All tests use
fixtures. Source/fixture checks do not establish real-account audio, physical
microphone/screen permission, latency or OS-native observation acceptance.

Sources: extracted Unified voice.py, voice_settings.py sample rendering,
voice_diagnostics.py, voice_options.*, voice_visual_image.py and native_foreground*
from the approved integration worktree on 2026-10-02. The affected catalog also
lists microsoft/amplifier-voice and robotdad/amplifier-app-voice / provider-openai-
realtime; these separate products are not configured runtime dependencies here.
OpenAI protocol checked against the official server-side-controls documentation:
https://developers.openai.com/api/docs/guides/voice-server-controls
