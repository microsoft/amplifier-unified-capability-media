# Media capability contract — v1

Status: local consolidation for review of inherited approved direction and existing
public media promises. It grants no new cross-owner authority and does not
self-ratify novel scope. Version 1 identifies this document, not an AHP/ACP wire
version, schema fork or package release. Parent: [local vision](../VISION.md).

The approved family references are anchored to distribution source `625af2f2832fafc8152f6078061d626f160362a4`
for review evidence, not standing deployment pins:

- [HP1–6](https://github.com/microsoft/amplifier-unified/blob/625af2f2832fafc8152f6078061d626f160362a4/contracts/host-protocol.v1.md): upstream AHP, scoped resources, recovery, independent execution and honest admission.
- [AP1–5](https://github.com/microsoft/amplifier-unified/blob/625af2f2832fafc8152f6078061d626f160362a4/contracts/agent-protocol.v1.md): ACP execution, native composition/authority and lifecycle meaning.
- [WS1, WS3–5](https://github.com/microsoft/amplifier-unified/blob/625af2f2832fafc8152f6078061d626f160362a4/contracts/working-set.v1.md): durable records, selected detail, resident bounds and dependency updates.
- [CB1–7](https://github.com/microsoft/amplifier-unified/blob/625af2f2832fafc8152f6078061d626f160362a4/contracts/component-boundaries.v1.md): independent components, one rule owner, isolated work and actual maintenance coverage.
- [CS1–9](https://github.com/microsoft/amplifier-unified/blob/625af2f2832fafc8152f6078061d626f160362a4/contracts/client-state.v1.md): target identity, private views, exact recovery, configuration scope, native authority and explicit devices.
- [CX3, CX4, CX6–7](https://github.com/microsoft/amplifier-unified/blob/625af2f2832fafc8152f6078061d626f160362a4/contracts/client-experience.v1.md): consistent controls, visible ownership, progress and capability limits.
- [CD1–6](https://github.com/microsoft/amplifier-unified/blob/625af2f2832fafc8152f6078061d626f160362a4/contracts/client-development.v1.md): shared meaning, declared impact, compatible versions and specific acceptance.
- [MA1–8, MA11](https://github.com/microsoft/amplifier-unified/blob/625af2f2832fafc8152f6078061d626f160362a4/contracts/maintenance.v1.md): complete lifetimes, retained exact proof, passive reads and preservation-first inspection.

Upstream [AHP](https://github.com/microsoft/agent-host-protocol) and
[ACP](https://github.com/agentclientprotocol/agent-client-protocol) own standard
protocol/schema semantics. The family [protocol-fit record](https://github.com/microsoft/amplifier-unified/blob/625af2f2832fafc8152f6078061d626f160362a4/docs/architecture/protocol-fit.md)
records their relationship. Media consumes the host's negotiated optional
capability/resource seam; this document does not redefine standard actions,
replication or cancellation. Package versions and negotiated wire versions are
separate facts.

## Public promises and falsifiers

The M identifiers below are local traceability labels, not new wire operations.
The [README](../README.md) remains the concrete factory/callback and HTTP interface
reference; [preferences schemas](../src/preferences.js), the runtime manifest in
[src/index.js](../src/index.js), and owning upstream schemas remain authoritative
for their fields. Consumers must not infer an unadvertised extension from prose.

| Promise, inherited basis | Boundary and falsifier | Existing acceptance checks |
| --- | --- | --- |
| **M1: Explicit authenticated client/session leases.** HP4–5, CS1/2/8, CB2/3. | Gateway authenticates and authorizes; media binds the lease to account/client/session. Client presence is separate from authentication. Broken if another account or selected conversation borrows a lease, or a shared update acquires devices. | [media tests](https://github.com/microsoft/amplifier-unified-capability-media/blob/68674d50396c719dd49e29491a3fbfb1c6e2962f/test/media.test.mjs): parallel clients, account/session refusals and detach; [lifecycle](https://github.com/microsoft/amplifier-unified-capability-media/blob/68674d50396c719dd49e29491a3fbfb1c6e2962f/test/lifecycle-acceptance.test.mjs): originating frame scope. Device gestures remain separate. |
| **M2: Durable transcript delivery through the native writer.** AP2/3, WS1, CS7. | Only native `recorded:true` confirms history. Media retains delivery intents and a selected bounded projection. Broken if its spool becomes resume authority, final admitted text disappears on detach, or transcript recording submits a prompt. | [transcript queue](https://github.com/microsoft/amplifier-unified-capability-media/blob/68674d50396c719dd49e29491a3fbfb1c6e2962f/test/transcripts.test.mjs), [final text/lifecycle](https://github.com/microsoft/amplifier-unified-capability-media/blob/68674d50396c719dd49e29491a3fbfb1c6e2962f/test/lifecycle-acceptance.test.mjs), [installed Core/Foundation persistence](https://github.com/microsoft/amplifier-unified-capability-media/blob/68674d50396c719dd49e29491a3fbfb1c6e2962f/test/native-transcript-acceptance.test.mjs). |
| **M3: Recover exact intent without repeating uncertain work.** HP3/6, CS4, CD3/5. | Preserve original IDs/content and known refusal versus unknown. Only the exact known-busy native nonexecution permits transcript retry. Broken if response loss causes another call, prompt, capture or configuration write. | [unknown connect](https://github.com/microsoft/amplifier-unified-capability-media/blob/68674d50396c719dd49e29491a3fbfb1c6e2962f/test/media.test.mjs), [transcript restart](https://github.com/microsoft/amplifier-unified-capability-media/blob/68674d50396c719dd49e29491a3fbfb1c6e2962f/test/transcripts.test.mjs), [preference receipt/restart](https://github.com/microsoft/amplifier-unified-capability-media/blob/68674d50396c719dd49e29491a3fbfb1c6e2962f/test/voice-preferences.test.mjs), [native restart](https://github.com/microsoft/amplifier-unified-capability-media/blob/68674d50396c719dd49e29491a3fbfb1c6e2962f/test/native-transcript-acceptance.test.mjs). |
| **M4: Explicit current capture permission and immutable resources.** CS8, CX4/7, WS1. | Grants are transient/client/session-bound; capture is an explicit fresh bounded frame. Revoke/replace/detach removes future selection. Broken if stale, expired or another client's grant supplies an image, or permission revocation deletes retained history. | [capture validation](https://github.com/microsoft/amplifier-unified-capability-media/blob/68674d50396c719dd49e29491a3fbfb1c6e2962f/test/media.test.mjs), [revocation and late validation](https://github.com/microsoft/amplifier-unified-capability-media/blob/68674d50396c719dd49e29491a3fbfb1c6e2962f/test/lifecycle-acceptance.test.mjs), [helper cancellation](https://github.com/microsoft/amplifier-unified-capability-media/blob/68674d50396c719dd49e29491a3fbfb1c6e2962f/test/test_native_foreground.py). Fixtures are not physical capture acceptance. |
| **M5: Honest passive settings and future-call defaults.** CS5/6/9, CX6/7, HP5. | Native owns credentials/settings; reads resolve no credential and start no worker. Active calls/previews/startup exclude shared default changes. Broken if a save claims mounted call changes or stored fallback claims a second transport attempt. | [preferences](https://github.com/microsoft/amplifier-unified-capability-media/blob/68674d50396c719dd49e29491a3fbfb1c6e2962f/test/voice-preferences.test.mjs), [future defaults](https://github.com/microsoft/amplifier-unified-capability-media/blob/68674d50396c719dd49e29491a3fbfb1c6e2962f/test/lifecycle-acceptance.test.mjs), [actual worker selection fixture](https://github.com/microsoft/amplifier-unified-capability-media/blob/68674d50396c719dd49e29491a3fbfb1c6e2962f/test/test_voice_defaults.py). F02.04 browser/audio gap remains. |
| **M6: Hangup preserves accepted backend work.** HP4, AP4, CS1/7, CX3. | Media end closes media transport; host admission/execution and native authority remain their owners. Broken if hangup cancels accepted delegation, duplicate end repeats a confirmed provider effect, or detached callbacks lose final text. | [voice lifecycle](https://github.com/microsoft/amplifier-unified-capability-media/blob/68674d50396c719dd49e29491a3fbfb1c6e2962f/test/test_voice.py), [delegation after hangup](https://github.com/microsoft/amplifier-unified-capability-media/blob/68674d50396c719dd49e29491a3fbfb1c6e2962f/test/quiescence.test.mjs), [final text and repeated end](https://github.com/microsoft/amplifier-unified-capability-media/blob/68674d50396c719dd49e29491a3fbfb1c6e2962f/test/lifecycle-acceptance.test.mjs). Standard ACP cancellation is a distinct host operation. |
| **M7: Complete held lifecycle proof before maintenance.** CB7, MA1–6, CS7/9. | Compose real Node/Python callbacks, transports, helper processes, pending delivery and capture with the actual participant. Keep the lifetime lock until admitted callbacks and transitions settle. Broken if timeout/empty view proves idle, unknown provider lifetime is assumed ended, or restart/retry changes release proof. | [quiescence](https://github.com/microsoft/amplifier-unified-capability-media/blob/68674d50396c719dd49e29491a3fbfb1c6e2962f/test/quiescence.test.mjs), [Python census](https://github.com/microsoft/amplifier-unified-capability-media/blob/68674d50396c719dd49e29491a3fbfb1c6e2962f/test/test_quiescence.py), [release proof](https://github.com/microsoft/amplifier-unified-capability-media/blob/68674d50396c719dd49e29491a3fbfb1c6e2962f/test/release-proof.test.mjs), [service stop](https://github.com/microsoft/amplifier-unified-capability-media/blob/68674d50396c719dd49e29491a3fbfb1c6e2962f/test/service-stop.test.mjs), [shutdown](https://github.com/microsoft/amplifier-unified-capability-media/blob/68674d50396c719dd49e29491a3fbfb1c6e2962f/test/lifecycle-acceptance.test.mjs), [retention](https://github.com/microsoft/amplifier-unified-capability-media/blob/68674d50396c719dd49e29491a3fbfb1c6e2962f/test/retention.test.mjs), [managed references](https://github.com/microsoft/amplifier-unified-capability-media/blob/68674d50396c719dd49e29491a3fbfb1c6e2962f/test/managed-files.test.mjs). These inspect/hold; they do not grant deletion or platform stop. |
| **M8: Selected bounded work and optional isolation.** HP2/5, WS3–5, CS3/9, CB1/2. | Read selected projections; invalidate only dependencies; keep capability absence explicit and ordinary host chat independent. Broken if a tiny transcript/default update reloads all histories or media absence prevents standard chat. | [bounded scoped drain](https://github.com/microsoft/amplifier-unified-capability-media/blob/68674d50396c719dd49e29491a3fbfb1c6e2962f/test/transcripts.test.mjs), [lazy optional preferences](https://github.com/microsoft/amplifier-unified-capability-media/blob/68674d50396c719dd49e29491a3fbfb1c6e2962f/test/voice-preferences.test.mjs), [bounded transport](https://github.com/microsoft/amplifier-unified-capability-media/blob/68674d50396c719dd49e29491a3fbfb1c6e2962f/test/worker.test.mjs). Whole-system working-set and ordinary-peer absence acceptance belong to host/distribution integration. |

## Consumer obligations

These restate existing interface ownership rather than granting new permissions:

- Host/gateway: supply trusted account/client identity, authorize sessions/resources,
  enforce origin/request limits and pass bounded selected context. Delegate ordinary
  work through the chosen host/ACP authority; do not import a competing runtime.
- Native adapter/configuration owner: supply authoritative nonsecret availability
  and exact durable transcript/default receipts. Keep native writer exclusion and
  full Core/Foundation composition; a mounted runtime is not inferred from a save.
- Client: request its lease and explicit device/source permission; keep drafts,
  selection, playback and tracks local. Bind results to their original target and
  identity; show unavailable/unknown truthfully and never replay capture on reconnect.
- Compositor/supervisor: register every configured ingress, callback and store with
  its actual lifetime participant, including independent native administration.
  Await complete callback lifetime; detached background effects are not covered by
  an already-resolved promise. Authenticate exact release/service evidence. A
  media-only hold does not prove complete installation or backup coverage.
- Release/integration owner: name exact source/package/peer revisions, archive
  hashes, skipped scenarios and loaded-worker evidence. Use CD impact review for
  changed meaning; unsupported client/device/provider work is not retired by omission.

## Acceptance and remaining gaps

[Acceptance notes](../docs/media-owner-acceptance.md) identify implementation
`68674d50396c719dd49e29491a3fbfb1c6e2962f`. Its source and independent installed
checks each passed 50 Node / 32 Python with supplied native peers and no skips.
Hosted Node 22/24 each passed 48 with two explicit missing-native-peer skips;
Python passed 32. These counts refer to those exact runs, not this documentation
successor or universal compatibility. [The independent qualification script](https://github.com/microsoft/amplifier-unified-capability-media/blob/68674d50396c719dd49e29491a3fbfb1c6e2962f/scripts/qualify-installed.py)
produces owned archive/byte-equality receipts; do not relabel old artifacts with a
new documentation revision. The existing [qualification snapshot](https://github.com/microsoft/amplifier-unified-capability-media/blob/68674d50396c719dd49e29491a3fbfb1c6e2962f/QUALIFICATION.json)
retains its earlier 2026-10-02 revision and is not current complete acceptance.

Physical mic/camera/speaker, native screen permission, real-provider account/audio,
F02.04 browser gestures, prior-provider-lifetime reconciliation, whole configured
service replacement and deployed adoption are unqualified. Automatic fallback
is unsupported (`stored-only`). These are gaps/limits separate from the desired
promises. Novel cross-owner behavior requires an explicit reviewed proposal;
this packet proposes none and grants no recording/capture/provider scenario.
