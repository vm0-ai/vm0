# Incremental App style migration

[Issue #32402](https://github.com/vm0-ai/vm0/issues/32402) owns the overall
progress. `turbo/style-migration-manifest.json` owns the reviewed migration
families, batch consumers, case links, and evidence references. The
[style guide](styles.md) remains normative; this manifest grants no exceptions.

## Inventory and batch selection

From `turbo`, run `pnpm style:migration:inventory > inventory.json`. The report
records the source commit, baseline hash, CSS declarations, injections, and
class references in production, tests, and deployed E2E helpers. Family entries
remain when their consumers drain, so the plan is durable without freezing
live counters into the repository. `pnpm lint:style` rejects unmapped tokens,
missing batch cases or files, and acceptance states without commit-bound HTTPS
evidence records. It also retains the existing shrink-only source policy.

The report is not a full reachability or ownership proof. Pure attribute/type
selectors, component inline properties, and exact third-party consumer ownership
remain enforcement follow-ups. Legitimate external classes are explicitly
assigned to the external-contract audit; they cannot be relabeled as business
exceptions. A green inventory check is not visual acceptance.

Start each batch from current main. Prefer one contract, one to three pages,
and five to fifteen consumption sites. Preserve effective cascade behavior,
native elements, events, refs, focus order, and scroll containers. Introduce a
shared variant with its first real consumers. Keep a legacy definition unchanged
until its last consumer is gone, then remove unused definitions and variables
and run `pnpm lint:style:prune`. Record unrelated design defects separately.

## Initial repeatable cases

`e2e/playwright/style-migration/cases.json` covers the real settings preference
dialog in desktop Light/Dark and narrow DPR 2 Chromium with touch/mobile
emulation. Each case exercises
appearance, hover, keyboard focus, send mode, delayed saving, successful saving,
and Escape dismissal. Authentication uses an isolated TEST account prepared
through the existing preview onboarding flow after both deployment jobs finish
(redeployment can reset the preview database). The runner uses its private
Playwright storage state; it never archives that state. Theme cookie,
localStorage, system color scheme and controlled preference responses agree
before each page load.

Only the exact API origin's user-preferences endpoint is replaced with explicit
deterministic responses. This verifies rendered states and client interaction,
not server preference persistence. Add the existing deployed/integration
preference tests when a migration changes that behavior. Both sides use the
same TEST account/fixture shape, feature switches, API version, fonts, locale,
and browser. Record those prerequisites with the evidence. No real Agent runs
or paid operations are needed.

From `e2e`, capture a baseline against the App/API aliases reported by the
deployment jobs. The bare Cloudflare Worker version URL cannot resolve the
correct API hostname. Pin the expected App SHA; every capture checks it, so an
alias advancing to another build invalidates the run. Provide
`VERCEL_AUTOMATION_BYPASS_SECRET` privately when needed; the runner scopes its
bypass header to the exact API origin and never records it.

```bash
pnpm style:migration \
  --app-url "$STYLE_BASE_APP_ORIGIN" \
  --api-url "$STYLE_TEST_API_ORIGIN" \
  --expected-build "$STYLE_BASE_DEPLOYED_SHA" \
  --source-sha "$STYLE_BASE_SOURCE_SHA" \
  --storage-state "$STYLE_PRIVATE_AUTH_FILE" \
  --out "$STYLE_BASELINE_DIR"
```

Replay the same command against that build into a new output directory, adding
`--baseline "$STYLE_BASELINE_DIR"`. Require this unchanged-code A/A check to
pass before freezing the baseline and changing business styles. Then repeat
against the final PR deployment, with its actual build/source SHAs, and the same
`--baseline`. `--executable-path` optionally selects a managed Chromium binary.

The runner checks the actual App build metadata at every capture, exact browser version, frozen
case and runner hashes, baseline image hashes, full-page pixels, and control semantics,
geometry and effective styles. It requires three identical painted frames.
Finite animations settle; infinite screenshot animations pause at phase zero.
`channel-rounding-v1` freezes a maximum of eight changed opaque pixels per
full-page image, with at most one 8-bit level per RGB channel. Unchanged-code
calibration observed 2–5 such rounding differences at rounded edges across
browser processes. Larger color changes, denser differences, alpha changes,
dimensions and any control observation difference still fail. Every raw changed
pixel remains visible in the diff and counted separately in the manifest.
There are no masks. This is a bounded visual noise budget, not byte identity.
Chromium uses fixed sRGB/software rendering arguments and disables partial
raster; image decoding completes before capture. Those arguments and the
dependency lock are part of the runner hash. Normal-motion,
WebKit and native PWA/Desktop cases must be added before migrating their
contracts; the initial cases do not certify those surfaces.

Output directories must not already exist. A failure preserves its manifest
and captured images; neither retries nor after replays overwrite prior evidence.
Do not rerun a failing case until a concrete hypothesis explains the change.
When baseline code itself is unstable, fix the fixture or create a separately
reviewed protocol version before implementation; never widen limits for an
implementation that has already failed.

## Pilot evidence and remaining reproducibility work

[PR #32843](https://github.com/vm0-ai/vm0/pull/32843) independently migrates the
two settings choice consumers from main. The manifest links its immutable
before and after archives. All 21 final states passed the frozen protocol with
identical control observations; light images had two one-level rounding pixels,
and dark/narrow images had no changed pixels. The source head is `a4a1c66` and
the actual tested App merge is `beee416`; full SHAs and deployment identities
are in the archive. The required source-head CI gates passed.

The after archive also retains an earlier attempt where the Light theme
precondition timed out before any light capture, while the other 14 states
passed. The next invocation used identical source, runner, cases, storage-state
input and limits. Its initialization failure trigger remains unconfirmed.
Investigate that finding before using this runner as an unattended gate;
`verified` records the successful bounded acceptance, not flake-free automation
or completion of the issue-wide migration.

## Evidence and merge gate

Before changing styles, upload the frozen baseline archive to Okou file storage
and record its returned URL and SHA-256 in the PR. After each replay, upload a
new archive containing before/after/diff PNGs and `manifest.json`. Upload key
comparison images to the same PR with `okou github upload-file`; verify reviewer
access. Record the same canonical URLs in the issue and manifest. Do not put
authentication state, cookies, tokens, bypass URLs, or live account data in an
archive. GitHub Actions reports are a secondary copy with their own retention.

Mark a batch verified only when every mapped case passes, relevant integration
tests and current-head CI pass, and evidence identifies the final code and
deployment. Before merge, inspect main changes to relevant source, tokens,
dependencies, build configuration and fixtures. Refresh affected evidence;
reuse other evidence only with recorded source identity. The protected merge
candidate runs the required checks. Overlap with another PR is not an ordering
blocker.

After merge, regenerate inventory from main, record the merge SHA and remaining
debt, and select the next independent batch. Keep blocked batches and failed
evidence visible. The issue closes only after a fresh main audit proves zero
first-party selectors, zero legacy business/test dependencies and unapproved
injections, with validated environment/adapter contracts and relevant visual,
interaction and native-platform evidence.

## Agent profile Tone batch

`tone-cases.json` is a separate case source registered through the manifest's
`caseFiles` array. Run `pnpm style:migration:tone` from `e2e` with the same
App/API, build, source, authentication, output and optional baseline arguments
as the preferences runner, plus:

```bash
--agent-fixture "$STYLE_SYNTHETIC_AGENT_JSON" \
--aria-mode legacy
```

The fixture is metadata from an isolated TEST account's Agent, with an empty
string description and initial `professional` sound. It contains no credentials.
The route substitutes its `agentId` into `/agents/:agentId?tab=profile`. Freeze
this fixture with the baseline; its hash is checked on every replay. Only the
exact API origin's preferences, onboarding status, agent list and that agent's
metadata endpoints have controlled responses. Onboarding status pins the
synthetic Agent's default role because every preview API redeploy resets its
database and creates a different default Agent ID. The stateful metadata response supports a delayed
PATCH and a later GET. This checks client saving and reloading; independently
verify real API persistence on the preview with these routes unmodified.

Narrow captures center the complete Tone section and require both the choices
and sample to be in the viewport, with the sample above the pending-edit bar.
Each viewport checks all four tone labels, hints and sample replies; selected
and inactive hover; keyboard focus and Space activation; Discard; pending Save;
successful Save; and reload. Capture every state against unchanged code and
require an A/A replay before editing business styles. Reuse the existing
rounding limits, with no masks, and retain failed calibration attempts.

The legacy native buttons have no `aria-pressed`. The shared choice control
intentionally adds that accessibility state. Use `--aria-mode legacy` for the
baseline and A/A, and `--aria-mode pressed` for the migrated UI. The runner
asserts and records the four attributes separately in each capture; all other
button semantics, geometry and computed styles must match exactly. The mode
change does not permit any pixel or layout difference. Re-run the original
21 preference states whenever changing the shared ChoiceButton.

The Tone calibration initially queried the wrong Save label; that attempt is
retained. A subsequent unchanged-code comparison exposed clipped-edge raster
variation outside the choices (with identical control observations). Both
runners now share the same capture helper and disable Chromium partial raster.
The acceptance archive preserves the earlier failures and separately identifies
the new unchanged-build pairs; no pixel threshold was widened. These paired
checks demonstrate bounded reproducibility, not an unattended cross-browser gate.

The first deployed migration exposed a fixture prerequisite: API redeployment
recreates the default Agent with a different ID. Before attempting its visual
comparison, the business migration was reverted, onboarding status was pinned
alongside the already-controlled Agent metadata, and new BEFORE/A/A evidence
was captured against the unmigrated UI. The old archives remain available. This
changes the explicitly recorded external fixture boundary, not pixel limits or
the expected rendered behavior. Actual onboarding and persistence remain live
checks outside the screenshot fixture.

The App Worker may embed successful API responses in inert bootstrap scripts
inside the initial HTML. The runner applies the same controlled fixtures to
those external responses before rendering; otherwise real preferences or Agent
metadata can bypass browser request interception. Bootstrap handling is included
in the frozen runner hash. Failed baseline attempts retain page evidence and
must never be accepted by a replay.

### Agent Tone acceptance record (#32873)

The [canonical BEFORE and A/A archive](https://a.okou.io/cwffgb0gk5.zip)
records unmigrated build `8207962cbb710165210f6c8a1282d77adda7ae0d`.
The [AFTER and raw-diff archive](https://a.okou.io/66hlqknk2r.zip) records
build `6b567009e0b93e2b1e0b562af0d7100474413b86`, from source
`8b8c003cab1645a4a8b933f37e5e731185033f0f`.
All 33 Tone and 21 preference states have zero changed pixels and identical
control observations apart from the intentional, separately checked pressed
state. The same limits also held after retaining main's card-surface migration.
Real API Save, reload and Discard passed; the TEST account's original tone was
restored. The manifest contains immutable URLs, hashes and build commits,
including a [quick comparison image](https://a.okou.io/rrdnuv8uyy.png).
The corresponding source passed 27 focused page tests, App/UI/E2E types,
formatting, and the [PR CI pipeline](https://github.com/vm0-ai/vm0/actions/runs/34328666624).
This is bounded Chromium acceptance; the earlier native and motion exclusions
remain in force.
