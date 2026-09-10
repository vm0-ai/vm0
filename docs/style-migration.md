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
Playwright storage state; it never archives that state. The shared theme cookie,
system color scheme, and controlled preference responses agree before each page
load.

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
21 preference states whenever changing the shared ToggleButton.

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

## Shared toggle button follow-up

The three migrated consumers (Appearance, Send mode and Agent profile Tone)
share a persistent selected-state contract through `ToggleButton`, retaining
its native element, controlled `selected` prop, inline/tile layouts and existing
activation and focus behavior. Both `Button` and `ToggleButton` render through
the internal `ButtonBase`, sharing the Base UI primitive, refs, native-title
handling and optional tooltip. Tooltips remain off by default and require an accessible label when enabled. Group selection
and arrow-key behavior remain owned by the existing callers.

Before implementation, freeze the 33 Tone and 21 preference states against
unchanged main code on the PR preview and require an unchanged-code replay.
After implementation, replay those frozen cases and verify tooltip activation,
disabled controls and existing Button trigger composition through focused
component tests. Record commit-bound before/after evidence with the PR.

[PR #32958](https://github.com/vm0-ai/vm0/pull/32958) starts from main after
the Tone migration merged. Its [BEFORE and unchanged-code replay archive](https://a.okou.io/c8j22q6j4i.zip)
pins App/API build `0b5a1934a9d4279f84ae1a83127ab7f7e4c1997b` and records
54 states with zero changed pixels. The archive also preserves failed calibration
attempts. Generate the Agent fixture from the same TEST account used by the
browser: its owner identity controls whether visibility settings render. Tone
also freezes that Agent's empty user-connectors and permission-grants GET
responses, so preview database resets cannot invalidate ancillary reads.
Geometry assertions run against the same settled paint that is archived.

The [initial AFTER archive](https://a.okou.io/2ylnq5pvv1.zip) and
[quick comparison](https://a.okou.io/eirvvzcyr7.png) record all 54 states with
zero changed pixels and identical control observations on App/API build
`7da162302e3de54931c8c9c66e49f4c1d3211960`, from source
`92f0e94405a15b7c5f94fdd05660ab698a22f7af`. Real API Save, reload, Discard
and restoration of the original tone passed. The 15 shared UI tests, 27 page
tests, relevant types/lint/Knip checks and all source-head CI gates passed.
The legacy inventory remains 94 tokens, 534 declarations, 309 production uses
and two injections.

The shared `ButtonBase` rendering follow-up was replayed against the same frozen
BEFORE evidence. Its [AFTER archive](https://a.okou.io/iuba6g9yb2.zip) and
[comparison image](https://a.okou.io/dua9x3cxng.png) record all 54 states passing
with zero changed pixels and identical control observations on App/API build
`775b8ba760699a5f60fc9d9add8673d70b6211ab`, from source
`ff6300001b95407e5db1421e589c1d2ebab5888d`. The runner, fixtures, cases and
rounding limits are unchanged. The same 42 focused tests and affected static
checks passed again; real API Save, reload, Discard and restoration passed on
this build. Both artifacts were anonymously downloaded and hash-verified.

The initial AFTER archive retains its first invocation: two initial Light frames
captured the sidebar promo before it appeared, while control observations and
all other states matched. After confirming the live promo had loaded, a new
invocation with identical source, runner, cases, fixture and limits passed.
No expected image, mask or threshold changed. This is bounded Chromium
acceptance; explicit sidebar readiness remains necessary before using the
runner as an unattended gate.

## Tone preview surfaces

The `tone-preview-surfaces` batch covers the user sample bubble and its enclosing
preview border in Agent profile settings. It replaces two legacy consumption
sites with existing gray, foreground and surface-border utilities. The assistant
bubble retains its separate Markdown and native Desktop selection contract;
the shared legacy border definition remains while other consumers use it.

`pnpm style:migration:tone-preview` uses `tone-preview-cases.json` and requires
private storage state, an owned synthetic Agent fixture (`--agent-fixture`) and
the TEST account's frozen feature-switch response (`--feature-fixture`). The
`--sidebar-fixture` freezes its admin organization and free-tier billing status;
desktop captures wait for the resulting Get Pro card after navigation and reload.
Both browser requests and embedded App bootstrap responses use those fixtures.
The 33 states cover four tones, hover, keyboard activation/focus, Discard,
pending Save, successful Save and reload in desktop Light/Dark and narrow DPR 2.
Real API persistence is checked separately; no Agent run is needed.

The `tone-surface-rgba8-v1` observation protocol adds exact geometry and computed
styles for the `tone-preview` and `tone-preview-user-message` semantic slots.
Only the user bubble's background color is compared as the browser's exact
8-bit sRGB canvas readback, including its alpha byte. Serialized alpha must also
match exactly. Its raw computed CSS is
also archived: Tailwind's `color-mix` and legacy `rgba` serialize differently.
This records equivalence for the pinned 8-bit screenshot environment, not
floating-point color or cross-browser equivalence. Other styles remain literal
comparisons and the full-page `channel-rounding-v1` limits remain unchanged.
Freeze and upload the unchanged BEFORE/A/A pair before replacing business
classes, then replay the same runner, cases and fixtures on the PR deployment.

[PR #33133](https://github.com/vm0-ai/vm0/pull/33133) froze its
[BEFORE and unchanged-code replay](https://a.okou.io/0ey5ajo2g7.zip) before
replacing either business class. All 33 states have zero raw changed pixels
on unmigrated App/API build `047e880cc958225a79c2ebceb961718a0916d5c9`.
The archive retains setup failures and the first replay's outer exit anomaly;
the confirming replay completed normally with the same frozen protocol.

The [AFTER archive](https://a.okou.io/uc3wow1q46.zip) and
[comparison image](https://a.okou.io/seho80x6gx.png) record all 33 states with
zero raw changed pixels and identical surface/control observations on App/API
build `1a665b1d0b25311c4c98471c206212a64be79c0d`, from implementation source
`a9ae349966e02c2db99aad68378a24b9cac31f8a`. Both artifacts were anonymously
downloaded and hash-verified. Actual TEST API Save, reload, Discard and original
tone restoration passed, as did all 18 existing Profile tests and the relevant
static checks. The branch removes one token, two declarations and two legacy
consumption sites. The batch remains implemented until the complete current-head
CI and acceptance gates pass; inspect the PR for live CI status.

## Monochrome icon filter batch

The independent `monochrome-icon-filter` batch covers only `ProviderIcon`,
`ConnectorIcon`, and their final `okou-icon-mono` declaration. Run
`pnpm exec tsx playwright/style-migration/run-icon-mono.ts` from `e2e` using
`--app-url`, `--api-url`, `--expected-build`, `--api-build`, `--source-sha`,
`--storage-state`, `--executable-path`, `--out`, and optional `--baseline`.
`icon-mono-cases.json` and `icon-mono-fixtures.json` are frozen alongside the
runner before business-style changes. API bootstrap scripts and browser requests
receive the same deterministic responses. Credentials remain outside evidence.

Twenty states cover the real Models settings dialog, its portaled model
options, personal provider marks, and the Connector page in Light/Dark desktop
and narrow touch/DPR 2 Chromium. Monochrome, colorful, missing-metadata and failed
image fixtures are distinct. Missing catalog display metadata is intentional
fault injection for the existing defensive fallback. Synthetic HTTPS icon
requests are fulfilled locally; no provider authorization or Agent run occurs.
Automatic signup attribution is fulfilled without writing to the API.

Healthy images use the unchanged shared `capture.ts`. Its mandatory image decode
cannot accept an intentionally broken image. Only failed-image states use the
batch's capture function: it verifies the failed image is complete, hidden and
undecodable, decodes all other images, waits for fonts and finite animations,
pauses infinite animations at zero, and requires three identical full-page
frames. It changes no DOM or styles. Both paths use the unchanged `images.ts`
rounding limits and retain every raw changed pixel without masks. This is bounded
Chromium evidence; it does not certify native, WebKit or normal-motion behavior.

Icon-mono calibration found narrow Dark DPR 2 raster differences confined to the
unrelated dotted price underlines (96/96/16 pixels, maximum channel delta 4).
Those captures remain rejected under the original limits. Before each capture,
the independent runner now requests a complete repaint by changing the viewport
width by one pixel and restoring the exact case dimensions, without changing
DOM or CSS. A fresh before/A/A pair passed all 20 states with zero changed
pixels. The interruption of the earlier A/A returned SIGTERM with an unconfirmed
cause; per-capture append-only records now preserve measurements before final
manifest creation. This calibration does not claim unattended reproducibility.

The [frozen BEFORE and unchanged A/A archive](https://a.okou.io/aeguxfgxpx.zip)
was uploaded and anonymously hash-verified before business edits. It pins source
`52557ce17da42acce602164a838381039d4407f6` and App/API build
`ad820032f6237598b8abed4c46e31979d7007ae2`, after integrating main
`29dfab14531307e67d16322d5fa3972df9c42a99`. All 20 states pass with zero
changed pixels and identical icon observations. Both original business files,
the CSS entry point and legacy baseline were byte-identical to that main.

Both consumers now use the existing `dark:invert` utility. The dark variant also
supports a theme attribute on the element itself, but neither image accepts
that attribute or caller filter classes; the current consumers and portaled
options use the same dark ancestor as the removed selector. Provider
classification, connector inversion flags, scale, fallback DOM and error events
remain unchanged. Only this token, one CSS declaration and two production uses
are pruned. No token or shared component changes are needed.

The [AFTER archive](https://a.okou.io/gywva3k9z6.zip) and
[comparison image](https://a.okou.io/vfjoaz2ylx.png) record all 20 states
passing with zero changed pixels and identical icon observations on App/API
build `29156a9e945af833fdef2bffe024be4c617d4496`, source
`318f791155657f6efb477a25f8023fd394f87fb1`. Both downloads were anonymously
hash-verified. The complete style check, affected App types/ESLint/Knip,
E2E types, formatting and four selected existing page tests passed. The legacy
inventory is now 93 tokens, 533 declarations, 307 production uses and two
injections. The implementation pipeline retains a separate `/sign-in`
navigation timeout during CLI TEST credential provisioning, before test
execution. The batch remains `implemented` while final-head CI is assessed;
these screenshots establish bounded Chromium acceptance.

The [evidence-only head replay](https://a.okou.io/okin45nt2v.zip) pins source
`6d4d25d653e49be29d900cd6e73b208d5c1fbc1b` and App/API build
`a7aae2beca69ca7c0075bf79af4b9cccaf4f006b`, including main
`724dc63d33064e66f8a41e0bef6ad54e345ef94a`. All 20 states again pass with
zero changed pixels and equal observations; that source's complete Turbo CI
passes. Actual Models and Connector pages loaded with the independent TEST
account. The archive records actual feature switches separately: the fixture
sets `modelPickerMenu=true` to exercise portaled icons; the live TEST response
has it false. Both keep `modelPickerFlyout=false` and `_realAgentInPreview=false`.
No live switch was changed. Earlier manual portal navigation attempts are
explicitly unaccepted diagnostics, distinct from the four passing frozen portal
states. The archive was anonymously downloaded and hash-verified.
