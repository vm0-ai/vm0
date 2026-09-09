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
Chromium uses fixed sRGB/software rendering arguments; those arguments and the
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
