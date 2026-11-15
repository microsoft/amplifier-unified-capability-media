# Media integration

Use this guide when embedding the media provider in a host. For the first setup,
see the [README](../README.md). The [media contract](../contracts/media.v1.md)
defines ownership; exported implementation remains in [src/index.js](../src/index.js).

## Required callbacks

`createMediaCapability` requires a private `directory` and these callbacks:

| Callback | Responsibility |
| --- | --- |
| `inspectSession(sessionURI)` | Return bounded title, activity, messages and worker context for the selected authorized session. |
| `delegate({session,clientId,commandId,text,attachments?})` | Submit through ordinary host admission and wait for identified completion. Preserve busy and unknown results; never replay a prior command. |
| `recordTranscript({session,callId,itemId,role,text,append,commandId})` | Call the negotiated native writer. Only `recorded: true` establishes native durability. |

For actual voice calls, provide `settings` and `resolveCredential`. `settings`
returns sanitized availability/configuration metadata, never secrets. Only an
explicit connection or preview resolves a credential. Key presence does not
establish account/model availability. Keep private credentials and provider
responses out of public capability state.

Optional callbacks include usage recording, selected-session subscription,
configuration, capture recording and foreground-observation support. Read the
[factory signature](../src/index.js) for the supported options. Missing callbacks
must not be treated as successful external operations.

## Host registration and HTTP

Register `manifest`, `read`, `action` and `resourceProvider` with the host.
Mount `handleMedia(req,res,{account,origin})` before static routing at `/media/*`,
or use `handleFetch(request,{account})` with a Fetch server.

- Derive account and client identity from authenticated context, not body fields.
- The gateway enforces same-origin requests and request limits.
- `media.attach` creates a memory-only identity/session lease; it does not acquire devices.
- The media plane validates `X-Amplifier-Media-Lease`; do not put credentials in URLs.
- Keep requests within 750 KB. Captured images must be complete PNGs no larger
  than 500 KB or 1,280 pixels.

Audio travels over WebRTC. AHP carries selected settings and bounded native-durable
transcript rows, not audio streams or full history. Authenticate immutable frame
resource reads before routing them to the provider.

## Worker and shutdown

Install the optional Python voice transport with `uv sync --extra openai` and
provide that environment's Python executable. Deployment bindings use
`pythonMode: "installed"`; the worker loads its installed module in isolated mode.
The separate `package-source` mode is for packaged-source development and is not
an automatic fallback.

Call `await media.close()` when the host shuts down. Device tracks, mute and
playback remain client-owned. Explicit screen permission is temporary and scoped
to the client/session. Revocation invalidates pending capture; restart does not
replay capture or grant permission. Native observation requires `enableNative`
and does not authorize desktop control.

## Unknown outcomes and transcript delivery

A rejected provider preflight differs from transport loss after a call could
have started. Keep unknown call lifetimes and command receipts; do not replace an
uncertain call with a fresh command. A wait or disconnected browser is not proof
that provider work ended.

The transcript spool is not native history. Only the exact native known-busy
result (`busy`, `retryable`, `executed: false`) can remain pending for the
provider's selected-session flush. Transport uncertainty is not retried. See
[transcript delivery](../src/transcripts.js) and [public failure handling](../src/voice-errors.js).

## Pre-retirement admission abort

Distribution update/recovery integrates with the existing quiescence participant.
A pre-retirement abort releases only the original held admission after the owning
distribution proves no retirement began; it does not restore state, end provider
calls, clear uncertainty or authorize replay. Once retirement starts, use the
owning lifecycle's completion/recovery path instead.

The abort proof must come from the authenticated supervisor and contain exactly
`{kind: "distribution-admission-abort", verified: true, purpose:
"distribution-update", receiptId, commandId, fenceId, instanceId, dataScope}`.
It requires the retained original attempt and complete idle-work accounting.
Missing rows or an empty replacement worker are not evidence of non-acquisition.
A lost provider-call acknowledgement remains an unverified lifetime after restart;
automatic quiescence is refused until authoritative reconciliation exists.

Use the exact context, receipt and release methods in
[quiescence](../src/quiescence.js) and [service lifecycle](../src/service-lifecycle.js).
Do not infer release authority from a timeout or generic error message.
