# Amplifier Unified media capability

Independent media owner for the Unified host. It does not import the host, Core,
Foundation, AppService, or client source. Browser audio goes directly over WebRTC;
only scoped signalling crosses the authenticated HTTP media plane. The optional
Python worker preserves the existing GPT-Live and GPT-Realtime sideband protocol,
transcript deduplication, generation correlation and hangup-with-work-continuing
semantics. It has no global app-state subscription.

Passive configuration reads use sanitized `settings()` metadata:
`available`, `reason`, `configurable`, and optional
`credentialAccess: "enabled" | "disabled"`. Missing availability is reported
as unavailable. These reads never call `resolveCredential` or start a worker;
credential resolution belongs only to an explicit voice connection or preview.
The settings owner must not include secrets in this public projection.

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

## Held quiescence participant

`createMediaCapability` returns `quiescenceParticipant(ownerId = 'media')` and
`inspectQuiescence()`. Register the actual participant with the host for the voice
capability, media HTTP ingress, and capture/transcript callbacks. The returned
`quiescenceAccess` declares only `voice.configuration` as read-only. The optional
`onMayBeIdle()` callback is a coalesced advisory completion signal; it is never
idle proof and notification failures cannot change an effect result.

`acquire({fenceId, commandId, purpose, instanceId, dataScope})` returns a held lease
or `null` for known busy/uncovered work. Purpose is `recovery` or
`distribution-update`. The owner atomically closes intake in a private durable
SQLite fence, then acquires the existing Python worker's private gate. It never
starts a worker to demonstrate idleness. A separate SQLite lifetime lease excludes
another owner before the journals are opened; the operating system releases that
lease after process death. The durable fence becomes `unknown` on restart.

The gate accounts for complete HTTP/device/configuration effects, delegated host
callbacks, pending transcript deliveries and drains, pending capture requests,
live provider calls, and Python tasks/transport callbacks that continue after
hangup. Attached viewers and idle screen grants are not work. Immutable saved
frames, configuration, receipts, and selected status remain readable. The private
worker's recent release cache is bounded to 256; the Node owner retains the durable
canonical receipt, and evicted worker receipts are never authority to replay work.

The held lease's `release(outcome, proof)` and the participant's
`reconcileRelease({...context, outcome, proof})` require exact host fence identity.
`unknown` retains closed intake. A conclusively refused aggregate admission may
release a still-held lease using `{kind:'admission-refused'}` and `unchanged`.
Otherwise proof must be `{verified:true, fenceId, commandId, outcome,
instanceId, dataScope, receiptId}`, with the unchanged prior instance or a verified
replacement instance for `ready`. These are trusted supervisor callbacks, not
browser-supplied assertions. Private RPC fence operations are not public media
HTTP routes. No uncertain call or transcript is replayed.

A lost provider-call acknowledgement or unconfirmed provider shutdown preserves an
opaque call-lifetime marker across restart. Such a marker reports the explicit
coverage gap `prior-provider-call-lifetime-unverified`, distinct from a historical
unknown command receipt. The owner cannot prove an independent browser/provider
call ended after losing its signalling process, so it refuses automatic quiescence
until an external authoritative provider/client reconciliation is implemented.
This release does not claim generic automatic updates across that unresolved case.

Qualification uses the actual private Python worker and synthetic immutable PNG
validation, plus provider fixtures and a SIGKILL/restart owner test. It does not
establish physical microphone/screen or authenticated provider acceptance.

Release retry proof is immutable: the owner atomically retains the canonical
outcome and entire proof with its released receipt. After acknowledgement loss
or restart, only the identical context, outcome and proof are accepted; changing
the receipt identity, authority scope or outcome is rejected. JSON object key
order is irrelevant. Older released receipts without exact proof evidence are
not inferred or rewritten into verified release evidence.

## Shared voice defaults

The optional `voicePreferences(operation, args, context)` callback enables one
host-scoped `voice-preferences` topic (`amplifier-media://voice-preferences`) and
two ordinary capability actions. The topic's data is
`{voicePreferences: {preferredModel, fallbackModel, voice, interruptions,
preferencesRevision, preferenceFields, models, fallbackBehavior}}`. Model metadata
and voice choices are explicitly bounded and sanitized. Existing `voiceConfiguration`
reads also retain these fields; the host topic is the live shared-defaults watch
so a change does not require enumerating or hydrating session state.

```js
voicePreferences: (operation, args) => nativeAdmin.perform(
  operation, args, {clientId: ''} // trusted host/default workspace resolver
)
```

The configured native launcher must independently enable `adminVoicePreferences`.
Without a callback, this owner advertises no preference action and exposes no
writable fields. Disabled credential access is compatible with non-secret shared
defaults. The credential-only `configure` callback and `/media/voice/configure`
route are unchanged; credential values never enter this topic or command journal.

`voice.preferences.update` uses channel `ahp-root://`, topic `voice-preferences`,
args `{expectedRevision, patch}`, and the ordinary outer `commandId`. It forwards
that exact command ID to native. Draft typing is entirely client-local. The result
contains the exact native-style receipt. Known native `executed:false` refusals,
including stale revisions, return `accepted:false`; unknown outcomes remain
unknown and are never repeated. A complete callback lifetime is counted by media
quiescence. Updates use the existing atomic exclusion of active calls, previews,
concurrent startup and credential changes, and apply only to later calls.

`voice.preferences.receipt {commandId}` is an explicitly declared passive read
usable under a held fence. The durable local intent index binds the original
command to its authenticated account, allowing recovery from another client or
owner restart without exposing other accounts' native receipts. An uncertain
command is inspected through the native owner's exact receipt only; an inspection
never replays it or rewrites product data during quiescence. A repeated update ID
cannot perform a second write. Authenticated agent calls retain their own origin
and need not borrow a browser client identity.

Only confirmed saves invalidate `voice-preferences` at `host` scope. The compositor
must forward that callback to the generic host and register this media participant
plus the independently held native-admin participant. Neither participant replaces
the other's complete lifetime proof. Local receipts live in
`voice-preferences.sqlite`, an independent product store; current selected-native
archives do not include it implicitly.

`fallbackBehavior: "stored-only"` is intentional: the retained transport does not
perform automatic fallback. Saving that legacy field does not claim it does.
Offline fixture and installed ACP qualification establish settings behavior, not
real voice-account, microphone, speaker, or browser acceptance.

## Persistent service stop and resume

The trusted `quiescenceParticipant()` advertises `serviceStop: {version: 1}`.
For `purpose: 'service-stop'`, the host supplies the normal fence context plus
`serviceIdentity: {installationId, dataScope, ownerId, instanceId, releaseDigest}`.
The owner copies and retains the complete identity with its durable intake fence;
restarting a process does not open intake or replay work. The host authenticates
platform evidence. This participant validates its exact binding, not a PID,
caller-provided claim of idleness, or socket presence.

A conclusive release needs `kind: 'service-lifecycle'`, the retained `expected`
identity, the exact `observed` identity, and the ordinary verified fence receipt.
`outcome: 'ready'` requires a distinct instance, `serviceOutcome: 'resumed'`,
`resumeCommandId`, `exitReceiptId`, and `readyReceiptId`. `outcome: 'unchanged'`
requires the same instance, `serviceOutcome: 'stop-refused'`, and
`refusalReceiptId`. The two receipt sets cannot be mixed. A changed release
identity, proof, or outcome refuses; exact completed retries are passive.
Generic update/recovery evidence cannot release a service fence.

`{kind: 'admission-refused'}` is restricted to the original live lease's partial
acquisition rollback. It is not a restart reconciliation mechanism. An unknown
outcome keeps intake closed, and passive inspection/receipt routes stay usable.
No service stop, platform process signaling, authenticated supervisor, or remote
provider safety is implemented by this participant itself.

The Node owner is the durable authority. An already-started private Python worker must explicitly negotiate service-stop support before its gate is acquired. No worker is started just to prove idle. Release evidence is persisted before the worker call, including when its acknowledgement is lost. Active calls, detached delegation, transcript delivery, and uncertain provider lifetimes retain their existing busy/refusal behavior.


## Held retention inspection

The actual quiescence participant advertises `retentionHide: {version: 1}`.
Acquire it with purpose `retention-hide` and the exact coordinator fence context.
The returned live lease exposes
`inspectRetentionReferences({sessions: ["ahp-session:/..."], limit: 101})`.
The family must contain 1–101 distinct explicit session URIs. The result is
`{coverage: "complete" | "partial", protected: [{session, reasons}], omissions}`.
Only the original held lease can inspect; release, uncertainty or replacement
invalidates that authority. Release reconciliation requires the same authenticated
coordinator proof and never retries effects. A pre-effect admission rollback is
allowed only on the original live lease. The purpose grants no mutation rights.

Inspection reads bounded indexed owner metadata while intake remains closed.
It never starts a native worker, scans canonical histories, deletes product records,
or interprets absence of a runtime as absence of deferred work. `complete` describes
this owner's reference coverage, not permission to hide or delete a conversation.
The coordinator must hold every configured owner, check all results, and use the
native history owner's separate preservation-first hide boundary.

Active work blocks acquisition. Retained uncertain owner commands protect their explicitly associated conversations; unscoped uncertainty cannot produce a false absence proof.

## Managed-file disposal protection

`quiescenceParticipant.managedFiles = {version: 1, preservesCanonical: true}` is a separate contract from `retentionHide`. It holds the real owner intake with purpose `managed-files-disposal`, preserving every owner record. The acquired lease exposes:

```ts
inspectManagedFilesReferences({
  sessions: [rootSession, ...descendants], // explicit AHP URIs, at most 101
  limit: 101,
  allocation: {allocationId, executionDirectory, allocationHash, treeHash, entryCount, bytes}
}) // {coverage: 'complete' | 'partial', protected: [{session, reasons}], omissions: [...] }
```

The allocation comes from the trusted host's native-reviewed managed allocation, never a browser path. It is bound with the exact selected family on the first inspection of the live lease; a different review is refused. This read does not grant file deletion. The coordinator must bind release to its exact durable managed-files effect receipt, keep unknown fences held, and refuse partial/protected coverage. Lease inspectors expire before release begins, including unknown release; admission-refused rollback is available only on the original live lease. Restart reconciliation requires the existing exact verified release proof.

Live calls, transports and callbacks prevent acquisition. Pending/unknown transcript intents protect selected conversations; completed frames and transcripts are owned copies outside the execution allocation. A resident media worker must negotiate the distinct managed-files gate before acquisition.

Inspection uses bounded selected metadata or indexed overlap probes, not native transcripts, a global history projection, or worker/model startup. Existing retention-hide and service-stop lifecycles are unchanged. The package tests cover the independently installed owner transport and held/unknown/exact-release behavior; full host/native/browser disposal acceptance remains a composition responsibility.

## Shutdown and client-source acceptance

`disconnect(clientId)` revokes that client's grants and stops its media transport.
Provider-final transcript, usage and status callbacks for its already admitted
lease remain accepted during hangup; new delegated input still requires client
presence. Confirmed hangup is not sent again by shutdown or a repeated public end request. Unknown provider
lifetimes retain the existing explicit refusal marker.

Revoking or replacing a visual grant invalidates its pending capture requests and
its next-frame selection. A delegation rechecks the same unexpired originating
grant after reading the immutable frame bytes. Retained artifacts stay available
through their authorized resource boundary; revocation does not delete history.

`close()` is idempotent and refuses new public effects and new worker input/read
callbacks. Final transcript/status/usage delivery can settle. It waits for the
complete admitted callback and private fence-transition lifetimes before closing
the worker, journals or directory lease. A callback that continues working keeps
shutdown pending; callers must await the complete callback lifetime rather than
spawn unreported background effects. The process supervisor must acquire the
actual configured quiescence participants before replacing a process.

| Owner lifetime | Busy/unknown evidence | End or cancellation boundary |
| --- | --- | --- |
| Connect, preview, configuration, defaults | Complete HTTP/action callback, startup guard; durable connect marker | Await original result; uncertain provider call remains unverified |
| Provider sideband, observer, background voice work | Python owners, call tasks, pump/observer and RPC callbacks | Hangup closes transport and observer; accepted delegation continues |
| Host delegation, usage, session reads/updates | Complete Node callback promise; Python pending callback | Shutdown awaits admitted promise; no command replay |
| Transcript native delivery | Durable indexed pending/unknown intent, active drain | Known `busy/retryable/executed:false` alone permits exact retry; unknown stays fenced |
| Browser capture request | Client/session/grant-bound request with 30-second completion window | Revoke/replace/detach invalidates selection; no device state on disk |
| In-flight visual/native callback or PNG validation | Complete Node effect; Python effect/helper subprocess | Revocation discards a late frame but does not hide running callback |
| Native foreground helper | Bounded stdout, deadline and awaited child lifetime | Cancellation kills and reaps child before returning |
| Private acquire/release | Held durable fence and in-flight transition | Shutdown awaits transition; exact proof/outcome needed for release |

The optional installed acceptance tests use `MEDIA_NATIVE_PYTHON`,
`MEDIA_NATIVE_ADMIN_MODULE` and `MEDIA_NATIVE_HOST_MODULE` pointing to sealed public
native/host packages. The supplied peers run read-only with
`PYTHONDONTWRITEBYTECODE=1`; all test native homes, application homes, provider
fixtures and ports are owned temporary state. No model prompt is submitted.
`native-transcript-acceptance.test.mjs` checks native canonical bytes and media
selected projections after reconnect/restart, including final text after detach.
The known-busy admission in that scenario is an explicit pre-effect fixture.

Run `python scripts/qualify-installed.py --output <owned-output> --python python3`
to pack and install this owner in separate Node/Python consumers, compare every
packaged implementation file with source, and run the relocated suites. Missing
native peers remain visible skips. `test_voice_defaults.py` exercises the actual
worker's model selection with a no-network call fixture: future defaults apply,
and a failed preferred model does not attempt automatic fallback.

These checks do not qualify browser gestures, microphone/camera/speaker, native
screen permission, real audio, provider accounts, OS service stop or deployed
adoption. F02.04's browser/device boundary remains with the client owner.
