# Packaged CUA acceptance handoff

This is the user-owned acceptance protocol for [#32395](https://github.com/vm0-ai/vm0/issues/32395)
and [#32259](https://github.com/vm0-ai/vm0/issues/32259). Okou remains default;
CUA remains an opt-in experiment pinned to 0.23.2. Implementation/CI completion
is not real-Mac acceptance. Copy [ACCEPTANCE-RESULTS.md](ACCEPTANCE-RESULTS.md)
before testing. Leave every unperformed result `pending-user` and every
unmeasured number empty. The [adapter contract](ADAPTER.md) defines supported
and deliberately refused commands; [UPGRADE-ROLLBACK.md](UPGRADE-ROLLBACK.md)
requires matching signed identities.

## Choose an exact candidate

Use the final-head delivery comment on #32395, which supplies the successful
Desktop run, all three actual app artifacts, the verification artifact, exact
IDs/digests/expiry, PR head, CI checkout and eventual merge. A version string
alone is insufficient. In particular, the released `okou-desktop-v0.47.0` at
`e9bb9b9ff41565b238445069f057b850507fa3cf` predates the selector; the slice-4
PR's identically versioned package came from different source.

The retained macOS arm64 candidates are:

| Actions artifact name                       | Configuration                                      | Installed identity                | Signing boundary                                            |
| ------------------------------------------- | -------------------------------------------------- | --------------------------------- | ----------------------------------------------------------- |
| `okou-desktop-macos-arm64-default-unsigned` | Default product, no runtime config                 | `Okou`, `ai.okou.desktop`         | Normally ad-hoc; inspect observed signature                 |
| `okou-desktop-macos-arm64-unsigned`         | Explicit Okou / `https://app.okou.ai`              | `Okou`, `ai.okou.desktop`         | Production configuration is not a production release        |
| `okou-desktop-macos-arm64-preview-unsigned` | This PR's platform preview URL                     | `Okou Dev`, `ai.okou.desktop.dev` | Separate identity; does not test production TCC persistence |
| `okou-desktop-cua-verification`             | `default/`, `production/`, `preview/` JSON reports | Metadata only                     | Each lane has `package.json`, `dormant.json`, `probe.json`  |

The historical artifact name “unsigned” includes Forge's ad-hoc signatures.
`--signed` in the verifier means verifying the seal before allowing native
post-sign bytes; it does not mean Developer ID or notarization. Read observed
outer and four nested signatures, authorities, Team ID, designated requirements,
Gatekeeper and stapling results from `package.json`. A matching Developer ID
candidate may only come from already completed normal distribution. If none
contains this implementation, signed-host/TCC/update acceptance stays pending;
do not sign, promote, release or wait for someone else's release to fill that gap.
Ad-hoc previews remain available for inspection and any user-authorized testing
that macOS normally permits; do not disable Gatekeeper or re-sign to launch them.

GitHub Actions downloads require a GitHub login with repository/Actions access
(and `actions:read` for a fine-grained token). Artifacts expire after 14 days;
use each API `expires_at`, not a date calculated from this document. A run page
can remain accessible after its files expire. The final comment includes exact
browser download links and REST archive URLs. To independently read metadata:

```sh
gh api repos/vm0-ai/vm0/actions/runs/RUN_ID/artifacts --paginate
gh api repos/vm0-ai/vm0/actions/artifacts/ARTIFACT_ID
```

Confirm the successful run's `head_sha` equals the reviewed PR head, and the
report's `CUA_EVIDENCE_PR_HEAD` agrees. For a pull request, Actions normally
checks out a synthetic merge: `inspectionCheckout` and `GITHUB_SHA` identify
that actual build commit; they need not equal the PR head. Verify its parents
include the reviewed head and compare the final protected merge's Desktop tree.
These CI fields bind reports to a build; an arbitrary local inspection does not
establish an installed app's source ancestry. The report's actual bundle hashes
can be compared with the verified candidate.

## Download and inspect without launching

Download the outer Actions artifact archive using its exact link. Preserve it
and verify SHA-256 against the API digest **before** extraction. On macOS:

```sh
shasum -a 256 candidate-actions.zip
ditto -x -k candidate-actions.zip candidate-download
```

Locate the enclosed app ZIP (default `Okou-default-darwin-arm64.zip`, production
`Okou-darwin-arm64.zip`, preview `OkouDev-darwin-arm64-preview.zip`; confirm the
actual name in `package.json`'s `archive`). Verify its SHA-256 against that
report, then use `ditto -x -k` to extract it to a new inspection directory.
`gh run download --name ARTIFACT_NAME` automatically extracts the outer archive;
its resulting app ZIP hash must not be compared to the outer artifact digest.
Do not install or launch either identity as part of inspection.

Use the matching source checkout, Python 3.11+ and macOS command-line tools
(`codesign`, `lipo`, `spctl`, `xcrun stapler`, already installed):

```sh
python3 turbo/apps/desktop/scripts/inspect-cua-package.py \
  --app "candidate-app/Okou Dev.app" \
  --archive "candidate-download/OkouDev-darwin-arm64-preview.zip" \
  > candidate-inspection.json
```

For an already installed app omit `--archive` and name its actual path. This
helper only reads package files and invokes signature/architecture/assessment
commands. It never launches the executable, loads the SDK, signs or staples,
changes accounts/preferences, prompts for TCC, or captures/uploads an image.
It rejects an invalid seal, wrong lock/version/architecture, changed non-native
payload or an archive that differs from the inspected app. It records failed
Gatekeeper/stapling assessments as such; seal validation alone is not notarization.
The ZIP comparison covers logical app files and symlinks; `__MACOSX` metadata is
outside that comparison but still covered by the ZIP's own hash.

Keep integrity domains distinct:

1. Outer Actions artifact ZIP: GitHub artifact `digest`, independently checked
   against downloaded bytes in the final handoff.
2. Inner app ZIP: actual-byte SHA-256 and file/symlink comparison to the inspected
   and subsequently probed app. Any DMG has its own separate hash.
3. Original upstream archives: the five locked SHA-256 values in `artifacts.json`.
4. `payload.json`: staged unsigned inventory/hashes. Non-native files still match
   after signing; the exact packaged lock must match the source lock.
5. Native Mach-O files after signing: observed byte hashes plus nested/outer
   seals. Re-signing changes these hashes; never compare them to upstream bytes.

## Dedicated CI/test launch checks

**Do not run ordinary smoke against your logged-in installed profile.**
`bootstrap.ts` sets the real product userData directory. Ordinary smoke signs
out and initializes normal app services, including the production updater.
Moving the app or passing an arbitrary Electron `--user-data-dir` flag does not
isolate that profile. Use only a disposable CI Mac/OS account with no existing
Okou/Dev login, opted-in preference, plugin session, recording or installed
instance of the tested identity. Do not add a profile/auth/driver override.

The existing macOS CI performs these commands from `turbo` for each lane:

```sh
node apps/desktop/scripts/smoke-test-packaged-app.js
node apps/desktop/scripts/smoke-test-packaged-app.js --cua-probe --signed
```

Before packaging, CI runs the existing distribution/inspection suite directly
with `python3 apps/desktop/scripts/test-cua-distribution.py`. Python owns all
its cases and teardown; the complete suite is not wrapped in one timed Vitest
case. The Desktop TypeScript suite remains a separate CI step.

The first checks the actual trusted preload, forged auth completion rejection,
selection/enable/Start/Stop bridge presence, initial and settled driver state
(off/Okou, no ready CUA, valid generation/version fields) and real SDK dormancy
after IPC reads and passive permission refresh. It does not invent `_debug`,
sign-in, permission grants or ready state.

The second is a **separate embedded lifecycle probe**: sealed payload preflight,
actual SDK/native load and daemon start, exact live version/PID/embedded host
metadata, no-prompt/no-capture permission query, matching-generation exit
observation, successful child exit, stopped host and removed private directory.
The wrapper requires normal Electron exit too. Malformed/duplicate/missing or
wrong-version evidence, cleanup timeout, forced/failed exit and output overrun
fail; a text marker cannot pass. Evidence is limited to one 8 KiB metadata record
and 128 KiB total child output, with raw child output withheld from CI reports.
A reported `host` attribution or permission boolean is not real TCC acceptance.
This probe never selects CUA through the normal command queue or operates an app.

Distribution/IPC/preload/selection/renderer/driver/host/plugin tests exercise real
internal composition and substitute external OS/SDK/network boundaries. Package
negative tests tamper disposable fixtures only and prove preflight rejects them
before executing their app. These are distinct from the three actual macOS lanes
and from all manual rows below. A real package/runtime failure must be repaired;
it cannot be relabeled `pending-user`.

## User-owned paired execution and measurements

Use one exact candidate containing both drivers, one authorized Mac/user/workspace
and fixed disposable test documents. Record macOS build/hardware, application
bundle IDs and versions, displays/scaling/Space/window bounds, foreground policy,
network, power/thermal conditions and concurrent workloads. Pause manual testing
if the candidate updates or its identity changes; reinspect and start a new pair.

Launch/sign in/authorize via normal UI only. Check **Developer Tools** in the
app menu, then select **CUA (Experimental)** in the driver panel below the
hero/setup and existing developer panels. That explicit choice is the opt-in;
showing/hiding tools must not switch or stop drivers. Agents/CLI have no driver
parameter. For every run,
record **actual** backend, controller generation and loaded version from Desktop
state/command diagnostics. A requested CUA preference, expected version or
transport “success” does not prove ready CUA or task completion. Take fresh
`get-app-state` after every switch and after each action; never reuse indexes,
raw IDs or snapshots from a prior generation.

Use existing `okou computer-use --help` and each subcommand's help in the
user-authorized session. Normal commands use the existing authenticated command
queue and result/artifact delivery, which can transmit inputs/screenshots.
The user must explicitly authorize that normal delivery for the disposable test
content before running these tasks; do not describe it as local-only capture.
Additional acceptance screenshots, recordings and raw inputs stay local and do
not enter these JSON reports or the issue. Share only chosen sanitized evidence.
The separate fixed host-probe capture in README writes a local PNG and is not a
queue task or an automatic upload.

For each matrix task restore the same starting content/window. Alternate driver
order by pair (Okou→CUA, then CUA→Okou); preserve both outcomes, including refusals,
errors and unknown effects. Never retry an unknown-completion action automatically.

- Record cold Start latency from the user's Start/selection submission to the
  same generation becoming ready. Use monotonic elapsed time; identify the
  timing tool and reset method. Never include sign-in/TCC grant time silently.
- Record warm end-to-end task latency from command submission to delivered
  completion, plus the visible final-state observation time separately. Desktop
  command-log duration covers its own execution boundary, not queue/network
  latency or the time the UI actually moved. Do not subtract wall clocks on
  different hosts. `lifecycleElapsedMs` is capped time since intent, not a phase
  performance measurement.
- Keep raw per-trial samples. Plan 10 completed paired trials per task for p50;
  report p95 only with at least 40 measured trials per driver under unchanged
  conditions, using sorted sample rank `ceil(0.95*n)`. Report sample counts,
  failures/refusals separately; no imputed zero or pooling cold/warm results.
- Record image bytes from the actual encoded image payload, text bytes as UTF-8
  and units/resize format. Record idle and task CPU/RSS with Activity Monitor or
  a named local sampler, including sampling interval, peak/mean definition,
  Electron/helper/owned-daemon process set and observation duration. Unobserved
  processes or fields stay empty, not zero.
- Record task success and visible final state separately from `effect`, `route`,
  `delivery`, refusal/error category and foreground/cursor disruption. Correct
  documented refusal is `supported-refusal`; it does not prove feature parity.

The Epic stays open until the user reviews the completed matrix and signed-host
upgrade/rollback evidence. This handoff neither executes final acceptance nor
authorizes any release, signing promotion, deployment approval or default change.
