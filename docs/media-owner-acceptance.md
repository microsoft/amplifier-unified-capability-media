# Media owner acceptance, 2026-10-03

Baseline: `c2a5a3e63825e8ef22c41a8ab38b56a9323bcfb3` from current remote main.
The owned branch repairs media lease preservation and shutdown within existing
CB6/CB7, MA1/MA2 and durable-history promises. No upstream AHP/ACP schema, native
storage authority, extension version or public callback signature changes.

The public fixtures reproduce:

- Apply new defaults after a confirmed hangup; established calls and previews
  exclude preference writes. Actual Python worker selection consumes supplied
  defaults and never claims automatic fallback.
- Capture an explicitly granted synthetic frame, revoke or replace its grant,
  then delegate. No old frame is attached. Other clients/conversations cannot
  retrieve the capture result or seize its next-frame selection.
- Detach while the provider reports final text. Exact final text stays in the
  native-delivery spool, while new delegated input is refused.
- Revoke during delayed validation/native capture. Actual work remains busy until
  completion and a late frame is discarded.
- Start shutdown during delegation, native capture, passive worker read or fence
  acquisition. A second owner remains excluded until the original promise settles;
  new effects are refused. Repeated close shares the original outcome.
- Confirm hangup and close. No second hangup fabricates an unknown provider lifetime.
- Use the sealed installed native Core/Foundation writer: exact Unicode transcript
  fragments, known-busy retained command and provider-final text survive media and
  host replacement, preserve canonical bytes before explicit delivery, and never
  submit a model prompt. Media's bounded projection is not native resume authority.

`README.md` gives the complete media lifetime census and reproduction entrypoint.
`scripts/qualify-installed.py` preserves archive digests, installed paths, source
byte comparisons and relocated test logs in the supplied owned output directory.
The coordinator's native input receipt owns its configured-source/registry scope;
this owner's receipt does not broaden it to native Core source-main acceptance.

Physical devices, authenticated audio/providers, browser gestures, external
provider-lifetime reconciliation, process supervisor replacement and deployed
adoption remain explicit unverified boundaries. Automatic fallback remains
`stored-only`. There is no new camera, recording or device permission feature.

## Call lifetime and offline voice parity successor

The successor based on merged `8d85b1811a80480f25a997fbeea52614f87308af`
repairs a falsifier of M3/M7: a fresh command on one lease could replace its
unverified provider marker after unknown connect or sideband error. Concurrent
startups could also both pass preflight before either received a provider identity.
The per-lease reservation and retained-marker check refuse both before a new
provider effect. Exact old command receipts still precede fresh preflight.

[Lifetime tests](../test/voice-lifetime.test.mjs) cover both failures, concurrent
startup, known provider refusal, maintenance exclusion and confirmed hangup.
[Transport tests](../test/test_voice_transport.py) run actual RPC and VoiceCall
code with only HTTP/WebSocket replaced offline: both protocols receive saved
voices, future realtime calls receive changed interruption defaults, 404 does
not cause fallback, and speech interruption/hangup preserve accepted delegation
and final Unicode transcript callbacks. Live's interruption preference remains
stored; its existing transport has no equivalent interruption field.

The installed-native preservation fixture also copies its three retained voice
rows through the actual host/native fork path, cold mounts the copied conversation
through Core/Foundation, verifies exact voice metadata/text, preserves the source
canonical bytes and forbids model completions. This does not qualify browser UI
or physical audio. Independent package receipts name the exact peer versions.

Affected-class inventory: both configured media protocols and the legacy Unified
web VoiceManager use a single selected transport attempt. The retained module
catalog also lists `microsoft/amplifier-voice` and
`robotdad/amplifier-app-voice`; these are separate products, not configured
dependencies. Their installed runtime behavior is outside this qualification.
The guard belongs to this media owner's lease/maintenance storage, rather than
those products or native session ownership. No automatic fallback is introduced.
