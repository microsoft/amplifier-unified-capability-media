# Amplifier Unified media vision

This repository makes voice and explicitly selected visual input available as an
optional capability of Amplifier Unified. People can speak into the same durable
conversation they use in other clients, retain accepted text and captured
artifacts, and end a call without losing admitted agent work.

This is a local application of the approved [family vision](https://github.com/microsoft/amplifier-unified/blob/625af2f2832fafc8152f6078061d626f160362a4/docs/architecture/VISION.md)
and [repository ownership map](https://github.com/microsoft/amplifier-unified/blob/625af2f2832fafc8152f6078061d626f160362a4/docs/architecture/repositories.md),
not a new ratification or a statement of complete acceptance. The local
[media contract v1](contracts/media.v1.md) maps inherited direction and existing
public interfaces to falsifiers, consumers and checks.

## Desired outcomes

- A client explicitly starts or ends its own call; another viewer does not acquire
  its microphone, playback state or screen permission.
- Accepted spoken text reaches the native conversation writer exactly as delivered.
  Reconnect and process replacement preserve known and unknown outcomes without
  recreating work. Media's delivery spool never becomes a second resume authority.
- A captured frame reaches work only through its originating client's explicit,
  current source grant. Revocation stops future use without deleting retained
  history or artifacts.
- Voice defaults have an honest saved/future-call boundary. A settings read needs
  no secret or worker startup; unsupported behavior is explained explicitly.
- End, detach and shutdown account for actual provider transports, capture helpers,
  callbacks and accepted delegation. An update cannot infer idleness from an empty
  view or discard work after a timeout.
- Selected reads and small updates stay bounded. Historical existence does not
  initialize agents or serialize every conversation.

## Ownership and scope

Media owns scoped signalling, voice transport lifecycle, transcript delivery
intents, explicit capture grants, immutable validated frames and its maintenance
participant. The host owns authentication, authorization, AHP subscriptions and
ordinary agent admission; the native ACP adapter owns credentials/configuration
and canonical native history through full Core/Foundation. Clients own device
permission, tracks, mute/playback, private drafts, selection and presentation.
Distribution owns component composition, complete maintenance coverage, release
and deployment. These boundaries follow CB, HP/AP and CS; their exact clauses are
linked in the contract.

This packet proposes no new scope. Automatic fallback, background recording,
new camera features, desktop control, cross-host permission replication, a second
history writer and private replacements for AHP/ACP are outside the existing
media implementation. A future proposal needs its owner, consumer impact and
approval before changing these boundaries. Existing fallback is a stored preference;
this limitation does not qualify it as automatic fallback.

## Evidence boundary

The [implementation acceptance note](docs/media-owner-acceptance.md) and existing
executable checks establish named fixture and installed-native scenarios. They do
not establish physical devices, authenticated provider/audio use, browser control
journeys, service-manager replacement or live deployment. Those remain explicit
acceptance work; an unqualified promise is not retired or weakened to fit a test.
