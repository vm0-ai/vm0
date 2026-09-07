# Same-identity signed upgrade and rollback

This is a user-owned procedure, not release/promotion authority. Actual results
remain `pending-user` in [ACCEPTANCE-RESULTS.md](ACCEPTANCE-RESULTS.md). Use
[ACCEPTANCE.md](ACCEPTANCE.md) to obtain and inspect exact artifacts first.

## Identity and candidate gate

Record the currently installed, proposed and recoverable previous app's exact
source, version, ZIP/DMG hash, bundle ID, signing authority/Team, outer designated
requirement, nested CUA signatures, update line/channel and CUA support. Verify
seals, Gatekeeper and stapling for each artifact before replacing anything.
Expected signing config is not observed signing evidence. Matching bundle ID
alone is insufficient: a different Team or ad-hoc signature changes TCC identity.

Production `ai.okou.desktop` and Dev `ai.okou.desktop.dev` are distinct. A Dev
preview beside production can test its own UI/driver behavior but cannot prove
production upgrade, rollback, retained login or TCC continuity. An ad-hoc CI app
must not replace an installed Developer ID app to claim those results.

Only already normally distributed, proven-source signed artifacts are eligible.
A signed build that predates the implementation is a possible previous/rollback
baseline, not the new CUA acceptance candidate. The released 0.47.0 at
`e9bb9b9ff41565b238445069f057b850507fa3cf` lacks the selector; do not confuse it
with the slice-4 0.47.0 PR package. If no signed candidate contains the final
implementation, stop this signed procedure at `pending-user`; use the accurately
labeled ad-hoc preview for inspection. Do not obtain credentials, re-sign,
notarize, merge release-please, promote, approve deployment or publish a release.

## Before replacement

1. Preserve the exact previous app/archive in a recoverable local location and
   verify its hash/signature. Record installation location, update line/channel
   and current version. Confirm a normal approved installation/restore flow is
   available before proceeding.
2. Record experiment opt-in/requested driver, actual driver/generation/version,
   Start versus manual Stop intent, current auth/Developer gate, pending work and
   cleanup. Privately record installation identity and unrelated preference
   owners (keep-awake and filesystem/MCP configuration) for comparison.
3. Preserve relevant local preferences using the user's approved local backup
   mechanism while the app is stopped. `desktop-preferences.json` resides in
   this identity's userData (`~/Library/Application Support/Okou` or `Okou Dev`).
   It can contain local paths; do not paste/upload it, dump Keychain/auth tokens,
   clone a login into CI or erase userData. A generic Electron profile flag does
   not override bootstrap's identity-owned userData.
4. Resolve an active recording explicitly through UI: stop/save it or defer the
   update. Note the real plugin session and host status. Use manual Stop, let
   claimed work and completion drain, and wait for observed native child exit
   and cleanup. Unknown action completion remains unknown and must not be replayed.
   Do not kill unrelated processes or discard a cleanup warning to proceed.

## Authorized update

1. Through the normal signed installation/update flow, replace only the matching
   identity after the preceding gate. Preserve local user data. Never disable
   Gatekeeper, broadly reset TCC, alter bundle IDs or ad-hoc re-sign the candidate.
2. Before launching, run read-only inspection on the actual installed replacement
   and compare its outer/nested identity, payload/version and hashes to the exact
   candidate. A download's version label is not enough.
3. Launch normally. Record login/workspace and installation identity continuity;
   local opt-in and requested selection restore only subject to current
   Developer/auth/TCC gates and manual Stop. Loss of authority is visible and
   cannot be replaced with old grants or a synthetic `_debug` value.
4. Check Accessibility/Screen Recording attribution in System Settings and, if
   needed, user-inspected TCC logs. Old grants continuing for the same responsible
   host is a separate observation from `attribution: host` in probe output.
   Grant/revoke/regrant are deliberate user steps, not scripts.
5. When off, ordinary state/setup/tray reads leave CUA dormant. When explicitly
   selected and started, record one actual ready executor/version/generation,
   fresh snapshots and a harmless user-authorized task. Old targets must be
   invalid. Verify plugin configuration and expected session/host behavior after
   app restart; a full update may restart plugins, unlike an ordinary driver switch.
6. Check recording save/playback, Start/Stop/recovery and owned child cleanup on
   subsequent Stop/Quit. Record each result and any deviation independently.

## Authorized rollback

1. Stop/drain and handle recordings as above. Reinspect the preserved matching
   previous app/archive, then restore it through the approved installation flow.
   Keep user data and TCC intact; do not force old preference contents over newer
   data without a reviewed, recoverable need.
2. Verify installed source/version/hash and outer/nested identity, then launch
   normally. A pre-selector app uses its own Okou behavior and cannot provide a
   CUA paired comparison; the retained new preference subtree must not be
   mistaken for active CUA on old code.
3. Check login/installation/unrelated preferences, proper current permission
   attribution, no stale CUA child or targets, no unknown-action replay and no
   overlapping native executor. Take fresh observations before any new task.
4. Observe the updater before calling rollback stable. Current packaged
   production macOS arm64 installs check the stable feed at startup and every
   30 minutes; a downloaded update installs when the existing native/recording
   busy policy permits. Bootstrap owns this even when main fails to load.
   The current interface provides no rollback pin. Do not invent an environment
   backdoor to suppress it. Coordinate any sustained rollback through the normal
   release owner separately; record if the normal updater offers/reinstalls the
   candidate, and do not claim durable rollback persistence.

| Checkpoint                                           | Current signed app | Candidate    | Restored previous app |
| ---------------------------------------------------- | ------------------ | ------------ | --------------------- |
| Exact source/version/hash/identity/channel verified  | pending-user       | pending-user | pending-user          |
| Preferences/auth/installation continuity             | pending-user       | pending-user | pending-user          |
| Host TCC attribution and grant behavior              | pending-user       | pending-user | pending-user          |
| Actual driver/generation; fresh target; one executor | pending-user       | pending-user | pending-user          |
| Plugin/recording behavior; Stop/Quit/cleanup         | pending-user       | pending-user | pending-user          |
| Updater observation/time and stability limits        | pending-user       | pending-user | pending-user          |

## Future coordinated CUA dependency upgrades

No pins change in this slice. A future upgrade must review all three coordinated
inputs: the bare daemon archive, `@trycua/cua-driver` SDK and
`@trycua/cua-driver-darwin-arm64` native package in `artifacts.json`, plus the
Desktop SDK type dependency and workspace lock. Preserve exact source and
upstream archive SHA-256/SHA-512 provenance; inspect the complete `@ubjs`
dependency closure and package-relative native loading layout.

Review the released source/embedding contract, MIT/MPL-2.0 notices and matching
source availability, Electron ABI/macOS minimum/arm64 compatibility, native
signing inventory and all three integrity domains. Re-evaluate nine-command
mapping/refusals, window/snapshot/effect/foreground/deadline contracts, private
child history/telemetry defaults, permission attribution, independent stop/reap,
auth/selection recovery and plugin/recording ownership. Rerun focused real
composition and negative distribution tests, all three actual macOS packaged
lanes and final-head protected gates. Supply new exact artifacts and repeat
signed-host, app/task/performance and same-identity update/rollback acceptance.
An upstream version bump or vendor benchmark never proves preserved behavior.
