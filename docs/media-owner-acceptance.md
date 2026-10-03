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
