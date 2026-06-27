# Type-check memory experiments

Date: 2026-06-27
Base branch: `main`
Latest validation base commit: `ba104205214ef487ef0488ad0c92c38352bf2eaa`
Original experiment base commit: `7b14b934a4ea535d43bfa55f485af1e5a6687ef0`

## Constraints

- Do not reduce type strictness.
- Do not replace precise application types with broad stubs.
- Keep `tsc --noEmit` as the correctness gate for every affected package.
- Clean `.tsbuildinfo` before comparable cold runs because `api` and
  `@vm0/app` enable incremental checking.
- Measure full process-tree peak RSS with `node scripts/measure-memory.mjs`.

## Baselines

- `@vm0/api-contracts` on latest `origin/main`
  (`ba104205214ef487ef0488ad0c92c38352bf2eaa`): passed, peak RSS
  `1688.5 MiB`, duration `48.2s`.
- `@vm0/app` on latest `origin/main`
  (`ba104205214ef487ef0488ad0c92c38352bf2eaa`): passed, peak RSS
  `2217.1 MiB`, duration `56.6s`.
- `api` on latest `origin/main`
  (`ba104205214ef487ef0488ad0c92c38352bf2eaa`): failed with V8 heap OOM,
  peak RSS `2267.9 MiB`, duration `61.2s`.
- Current experiment branch after the retained app/type-splitting changes:
  `@vm0/api-contracts` passed at `1678.9 MiB`, `@vm0/app` passed at
  `2223.5 MiB`, and full `api` still OOMed at `2274.4 MiB`.

## Static diagnostics

- Relative import SCC scan found one large `api` cycle centered on
  `signals/route.ts`. Splitting `RouteEntry` into `signals/route-entry.ts`
  removes the route leaf -> registry type-only edge and is required for useful
  route leaf chunking.
- A fresh lockfile package-entry scan on `7b14b93` found `214` package names
  with multiple versions. Notable type-graph candidates include `type-fest`,
  Clerk shared packages, Sentry bundler packages, Babel helpers, and
  `commander`. This is real fragmentation, but declaration-boundary
  experiments below show it is not the dominant source of the `api` OOM.
- Declaration-boundary experiments show dependency fragmentation is not the
  dominant `api` peak source; the largest pressure is inside `apps/api/src`.

## Experiments

### 1. Disable incremental builder for `api`

Command: `pnpm -F api exec tsc --noEmit --incremental false`

- Result: failed with V8 heap OOM, peak `2280.7 MiB`, duration `53.2s`.
- Conclusion: not useful for cold peak memory.

### 2. Split API route entry types

Change: move `RouteEntry` and `SignalRouteHandler` re-export into
`apps/api/src/signals/route-entry.ts`; keep `signals/route.ts` public exports
intact; update route leaves to import `RouteEntry` from the pure type file.

- Result on full `api`: still OOM in earlier same-commit run, peak
  `2286.6 MiB`.
- Result for route leaf chunking: enables chunks to avoid pulling the whole
  route registry through type-only imports.
- Conclusion: useful structural cleanup, but not sufficient alone.

### 3. Split API production/test strict checks

Change: production and test entrypoints are checked by separate strict programs.

- Production check: failed OOM, peak `2264.1 MiB`.
- Test-entry check: failed OOM, peak `2271.9 MiB`.
- Conclusion: splitting tests from production is not enough by itself.

### 4. Consume `@vm0/api-contracts` declarations in API

Change: generate `.d.ts` for `@vm0/api-contracts` and map `api` to those
declarations during checking.

- Result: failed OOM, peak `2286.5 MiB`.
- Conclusion: contract package source is not the main `api` peak driver.

### 5. Consume all workspace dependency declarations in API

Change: generate `.d.ts` for `@vm0/api-contracts`, `@vm0/connectors`,
`@vm0/core`, and `@vm0/db`; map `api` to declarations for all four.

- Result: failed OOM, peak `2274.3 MiB`.
- Conclusion: workspace declaration boundaries alone do not materially reduce
  `api`; the dominant graph is in `apps/api/src`.

### 6. Move automation page structural types to a pure type file

Command: `pnpm -F @vm0/app check-types`

- Change: move `CombinedEntry` to `automation-utils.ts`; signals import
  `AutomationEntry` and `CombinedEntry` from the pure utility module.
- Result: passed, peak `2185.8 MiB`, duration `51.9s`.
- Delta vs fresh app baseline: `-2.9 MiB`.
- Conclusion: safe to keep, small but real app-side reduction.

### 7. Move chat thread signal interfaces to a pure type file

Command: `pnpm -F @vm0/app check-types`

- Change: move `ChatThreadSignals`, `LoadHistoryResult`, `ActiveGoalState`, and
  `SendMessageOptions` to `chat-thread-signals.ts`; keep re-exports from
  `create-chat-thread.ts`.
- Result: passed, peak `2183.2 MiB`, duration `58.0s`.
- Delta vs fresh app baseline: `-5.5 MiB`.
- Conclusion: safe to keep, small app-side reduction and cleaner type imports.

### 8. API production check without `vitest/globals`

Command:
`pnpm -F api exec tsc -p tsconfig.production-no-vitest.json --noEmit`

- Result before route-entry split: failed OOM, peak `2248.6 MiB`.
- Result after route-entry split: failed OOM, peak `2259.0 MiB`.
- Conclusion: `vitest/globals` is not the main `api` memory driver.

### 9. API route leaf chunks

Commands:

- `pnpm -F api exec tsc -p tsconfig.routes-nonzero.json --noEmit`
- `pnpm -F api exec tsc -p tsconfig.routes-zero-a-g.json --noEmit`
- `pnpm -F api exec tsc -p tsconfig.routes-zero-h-r.json --noEmit`
- `pnpm -F api exec tsc -p tsconfig.routes-zero-s-z.json --noEmit`

Results:

- `routes-nonzero`: passed, peak `2159.4 MiB`.
- `routes-zero-a-g`: passed, peak `2057.9 MiB`.
- `routes-zero-h-r`: passed, peak `2031.2 MiB`.
- `routes-zero-s-z`: passed, peak `1808.6 MiB`.

Conclusion: route leaf chunking is effective, but it only covers route leaves
and their imported dependencies. It does not replace the full `api` check until
registry/core/test coverage is also split.

### 10. Finer nonzero route leaf chunks

Commands:

- `pnpm -F api exec tsc -p tsconfig.routes-nonzero-agent-cron.json --noEmit`
- `pnpm -F api exec tsc -p tsconfig.routes-nonzero-webhooks-test.json --noEmit`
- `pnpm -F api exec tsc -p tsconfig.routes-nonzero-misc.json --noEmit`

Results:

- `nonzero-agent-cron`: passed, peak `1766.9 MiB`.
- `nonzero-webhooks-test`: passed, peak `1993.4 MiB`.
- `nonzero-misc`: passed, peak `1898.3 MiB`.
- With existing zero chunks, the route leaf max becomes `2057.9 MiB`.

Conclusion: finer route leaf chunks reduce the route-leaf maximum by about
`101.5 MiB` versus the broad nonzero chunk, and by about `215 MiB` versus the
full `api` OOM baseline.

### 11. Route registry group files

Change: split `signals/route.ts` into six contiguous route group files, keeping
registration order unchanged and typing each group as `readonly RouteEntry[]`.

- Command:
  `pnpm -F api exec tsc -p tsconfig.production-no-vitest.json --noEmit`
- Result: failed OOM, peak `2253.7 MiB`.
- Conclusion: not worth keeping; the experiment was reverted.

### 12. API tests-only after route-entry split

Command: `pnpm -F api exec tsc -p tsconfig.tests-only.json --noEmit`

- Result: failed OOM, peak `2251.1 MiB`.
- Conclusion: tests pull the full app/route graph through `setupApp` and
  `createApp`. Test splitting or explicit per-test route arrays are required
  before a split `api` check can be a full replacement.

### 13. Split route-free test context helpers

Change: move `testContext` and `accept` from `src/__tests__/test-helpers.ts`
to `src/__tests__/test-context.ts`; keep re-exports from `test-helpers.ts`.
Mechanically update 54 files that do not use `setupApp` to import from
`test-context`.

Important measurement note: files-based child tsconfigs inherited the parent
`include: ["src/**/*", "custom-eslint/**/*"]` until the experiment configs were
changed to use exact `include` lists. The corrected results below use exact
child `include` entries.

- Command:
  `pnpm -F api exec tsc -p tsconfig.tests-no-setup-app.json --noEmit`
- Result: failed OOM, peak `2252.4 MiB`.
- Conclusion: simply moving direct `testContext` imports is not enough because
  43 of the 54 files still reach `test-helpers.ts` transitively through BDD
  helpers.

### 14. Split app creation for explicit-route tests

Change: move the Hono construction logic into `app-factory-core.ts` as
`createAppWithRoutes`; keep `app-factory.ts` and its default `ROUTES` behavior
intact by delegating to the core factory. Migrate `callback-route.test.ts` to
use `createAppWithRoutes` and `RouteEntry` from `route-entry.ts`.

- Corrected single-file command:
  `pnpm -F api exec tsc -p tsconfig.tests-callback-route.json --noEmit`
- Result: passed, peak `919.7 MiB`, duration `18.3s`.
- Conclusion: explicit-route tests can avoid the full route registry if they use
  the core factory; this is a safe pattern to roll through other tests.

### 15. Pure-context test entry chunk

Command:
`pnpm -F api exec tsc -p tsconfig.tests-pure-context-entries.json --noEmit`

- Scope: 7 real test entry files that do not transitively import `test-helpers`,
  `app-factory`, or `signals/route.ts`.
- Result: passed, peak `1897.9 MiB`, duration `30.7s`.
- Conclusion: test-side chunking is viable once route-free helpers and explicit
  route app creation are separated. Remaining BDD/setupApp tests still need
  route-specific helper migration.

### 16. Route-free contract test app helper and core BDD route slices

Change: add `src/__tests__/test-app.ts` with `setupAppWithRoutes`, backed by
`createAppWithRoutes` and explicit `readonly RouteEntry[]`. Keep the existing
`test-helpers.ts` public `setupApp` API as a thin wrapper over full `ROUTES`.
Migrate the core `api-bdd.ts` helper to use exact route slices for auth,
onboarding, org, and agent contracts.

Commands:

- `pnpm -F api exec tsc -p tsconfig.tests-callback-route.json --noEmit`
- `pnpm -F api exec tsc -p tsconfig.tests-pure-context-entries.json --noEmit`
- `pnpm -F api exec tsc -p tsconfig.tests-no-setup-app.json --noEmit`

Results:

- `callback-route`: passed, peak `1026.0 MiB`, duration `8.5s`.
- `pure-context` expanded from 7 to 12 roots: passed, peak `1963.2 MiB`,
  duration `42.8s`.
- `tests-no-setup-app` 54-root chunk: still OOM, peak `2238.3 MiB`.

Conclusion: this is a safe strictness-preserving pattern. It increases
route-free test coverage without weakening response validation or contract
typing. The remaining OOM is now concentrated in 42 roots that still reach
`app-factory.ts` / `signals/route.ts` through other BDD helpers.

### 17. Direct route test entry slices

Change: migrate direct route tests that imported `app-factory.ts` to
`createAppWithRoutes` with real production route arrays. This keeps real route
handlers, real contract typing, response validation, and strict `tsc`; it only
avoids registering the full API route table for tests that exercise one route
or a small route set.

Files migrated in this experiment:

- `legacy-file.test.ts`
- `test-slack-mock.test.ts`
- `test-slack-state.test.ts`
- `test-telegram-dispatch-probe.test.ts`
- `test-telegram-mock.test.ts`
- `test-telegram-state.test.ts`
- `zero-built-in-generation.test.ts`
- `zero-connectors-oauth-start.test.ts`
- `zero-email.test.ts`
- `zero-image-io-generate.test.ts`
- `zero-slack-browser-connect.test.ts`
- `zero-slack-oauth.test.ts`
- `zero-video-io-generate.test.ts`
- `zero-voice-io-post.test.ts`
- `zero-web-download.test.ts`

Commands:

- `pnpm -F api exec tsc -p tsconfig.tests-pure-context-entries.json --noEmit`
- `pnpm -F api exec tsc -p tsconfig.tests-no-setup-app.json --noEmit`

Results:

- Intermediate 14-root pure-context chunk: passed, peak `1916.4 MiB`.
- Intermediate 25-root pure-context chunk: passed, peak `2031.7 MiB`.
- Final 27-root pure-context chunk: passed, peak `2035.0 MiB`.
- Full 54-root `tests-no-setup-app` chunk: still OOM, peak `2247.1 MiB`.

Static result: the `tests-no-setup-app` roots split from `12 clean / 42 dirty`
after experiment 16 to `27 clean / 27 dirty` after this experiment. All direct
`app-factory.ts` imports in that set are gone; the remaining dirty roots are
through BDD helper modules, primarily `api-bdd-webhooks.ts`,
`api-bdd-runs-automations.ts`, `api-bdd-github.ts`, `api-bdd-misc.ts`,
`api-bdd-connectors.ts`, `api-bdd-storages.ts`, `api-bdd-chat-files.ts`, and
`api-bdd-user-config.ts`.

Conclusion: this is the strongest safe API-side improvement so far. It creates
a strict 27-entry test chunk that stays around `2035 MiB`, about `223 MiB`
below the raw latest-main full `api` OOM peak. It is not sufficient to make the
54-root test chunk pass because remaining BDD helpers still pull default
`setupApp` / full route registry edges.

### 18. Email route slice migration

Change: migrate `zero-email.test.ts` from raw `createApp` to
`createAppWithRoutes` using `zeroEmailCallbackRoutes` and
`zeroEmailInboundRoutes`.

- Command:
  `pnpm -F api exec tsc -p tsconfig.tests-pure-context-entries.json --noEmit`
- Result: passed, peak `2052.4 MiB`, duration `45.7s`.
- Scope: pure-context chunk expanded from 26 to 27 roots.
- Conclusion: the email test no longer imports the full route registry; the
  added route slice has a small, controlled peak increase.

### 19. Inline runner route helpers in Slack dispatch probe test

Change: remove `test-slack-dispatch-probe.test.ts`'s dependency on the broad
`api-bdd-runs-automations` helper. Add two local strict contract clients for
`runnersHeartbeatContract` and `runnersJobClaimContract`, both backed by
`runnersRoutes`.

Commands:

- `pnpm -F api exec tsc -p tsconfig.tests-pure-context-entries.json --noEmit`
- `pnpm -F api exec tsc -p tsconfig.tests-no-setup-app.json --noEmit`

Results:

- `pure-context` expanded from 27 to 28 roots: passed, peak `2067.7 MiB`,
  duration `49.9s`.
- `tests-no-setup-app` 54-root chunk: still OOM, peak `2247.8 MiB`.

Conclusion: the direct/non-BDD test entrypoints are now mostly route-sliced.
The remaining OOM is concentrated in 26 roots that reach full `ROUTES` through
BDD helpers.

### 20. User config BDD helper route slice

Change: migrate `api-bdd-user-config.ts` and its shared
`api-bdd-auth-org.ts` dependency from default `setupApp` / `createApp` to
`setupAppWithRoutes` / `createAppWithRoutes` backed by real route arrays for
auth, onboarding, org, agent, compose, custom connector, secret, variable,
preference, and API-key routes. The test still uses real handlers and strict
contract clients.

Commands:

- `pnpm -F api exec tsc -p tsconfig.tests-pure-context-entries.json --noEmit`
- `pnpm -F api exec tsc -p tsconfig.tests-no-setup-app.json --noEmit`

Results:

- `pure-context` expanded from 28 to 29 roots: passed, peak `2129.8 MiB`,
  duration `41.3s`.
- `tests-no-setup-app` 54-root chunk: still OOM, peak `2248.2 MiB`.

Static result: the `tests-no-setup-app` split improved from
`28 clean / 26 dirty` to `29 clean / 25 dirty`. The remaining dirty roots are
still concentrated in BDD helper modules, especially `api-bdd-webhooks.ts`,
`api-bdd-runs-automations.ts`, `api-bdd-github.ts`, `api-bdd-misc.ts`,
`api-bdd-connectors.ts`, `api-bdd-storages.ts`, and `api-bdd-chat-files.ts`.

Conclusion: this is safe to keep, but it is a wider route slice than the
direct-route tests. It increases the passing pure-context chunk by one root and
about `62 MiB` versus the 28-root run, while the full 54-root test chunk remains
blocked by the remaining BDD helpers.

### 21. Storage, compose, and runs-automation BDD helper route slices

Change: migrate `api-bdd-storages.ts`, `api-bdd-composes.ts`, and
`api-bdd-runs-automations.ts` from default `setupApp` / `createApp` to strict
`setupAppWithRoutes` / `createAppWithRoutes` backed by explicit real route
arrays. Also split pure helper code out of broad BDD helpers:
`storageTextFile` now lives in `api-bdd-storage-files.ts`, and
`mockClerkMembership` now lives in `api-bdd-clerk.ts` while the previous
GitHub helper export is preserved.

Commands:

- `pnpm -F api exec tsc -p tsconfig.tests-pure-context-entries.json --noEmit`
- `node scripts/measure-memory.mjs --label api-tests-pure-context-32-roots-runs-automation-slice --json .memory-results/latest.jsonl -- pnpm -F api exec tsc -p tsconfig.tests-pure-context-entries.json --noEmit`
- `node scripts/measure-memory.mjs --label api-tests-no-setup-app-54-roots-runs-automation-slice --json .memory-results/latest.jsonl -- pnpm -F api exec tsc -p tsconfig.tests-no-setup-app.json --noEmit`

Results:

- Static split improved from `29 clean / 25 dirty` to `32 clean / 22 dirty`.
  Newly clean roots: `auth-org-agents.bdd.test.ts`, `composes.bdd.test.ts`,
  and `storages.bdd.test.ts`.
- `pure-context` expanded from 29 to 32 roots: passed, peak `2192.6 MiB`,
  duration `42.9s`.
- `tests-no-setup-app` 54-root chunk: still OOM, peak `2249.4 MiB`.

Conclusion: the helper migration is safe and useful because three more BDD
entrypoints no longer pull the full route registry. The 32-root chunk is
already close to the default V8 heap limit, so the next implementation step
should not be "keep adding roots to one chunk"; it should wire several strict
chunks into `api` check-types. The full 54-root chunk remains blocked by the
remaining broad helpers (`api-bdd-chat-files.ts`, `api-bdd-billing-media.ts`,
`api-bdd-misc.ts`, `api-bdd-integrations.ts`, `api-bdd-webhooks.ts`,
`api-bdd-connectors.ts`, and `api-bdd-auth-device.ts`).

### 22. Chat-files, email, and firewall BDD helper route slices

Change: migrate `api-bdd-chat-files.ts` from default `setupApp` to
`setupAppWithRoutes` backed by explicit real route arrays for chat threads,
chat messages, v1 chat, compose creation/read, uploads, host, memory, and
storage routes. Split the pure hosted-file helper into
`api-bdd-host-files.ts` while preserving the existing `api-bdd-chat-files.ts`
export. Also migrate the smaller `api-bdd-email.ts` and
`api-bdd-firewall.ts` helpers to explicit real route arrays.

Commands:

- `pnpm -F api exec tsc -p tsconfig.tests-pure-context-entries.json --noEmit`
- `node scripts/measure-memory.mjs --label api-tests-pure-context-34-roots-chat-files-slice --json .memory-results/latest.jsonl -- pnpm -F api exec tsc -p tsconfig.tests-pure-context-entries.json --noEmit`
- `node scripts/measure-memory.mjs --label api-tests-no-setup-app-54-roots-email-firewall-slice --json .memory-results/latest.jsonl -- pnpm -F api exec tsc -p tsconfig.tests-no-setup-app.json --noEmit`

Results:

- Static split improved from `32 clean / 22 dirty` to `34 clean / 20 dirty`.
  Newly clean roots: `automations.bdd.test.ts` and `chat-files.bdd.test.ts`.
- `pure-context` expanded from 32 to 34 roots: passed, peak `2233.9 MiB`,
  duration `48.4s`.
- `tests-no-setup-app` 54-root chunk after email/firewall slicing: still OOM,
  peak `2244.2 MiB`.

Conclusion: the chat-files migration is safe but confirms the 34-root chunk is
now at the edge of the default V8 heap. Email/firewall slicing lowers the
54-root OOM peak slightly, but those entrypoints are still blocked by broader
helpers (`api-bdd-webhooks.ts`, `api-bdd-connectors.ts`, and related
integration helpers). Further work should keep migrating helpers, but the
shipping `api` check-types path should use multiple strict chunks instead of
one larger test chunk.

### 23. Broad misc BDD helper route slice

Change tested: migrate `api-bdd-misc.ts` from default `setupApp` / `createApp`
to `setupAppWithRoutes` / `createAppWithRoutes` backed by explicit real route
arrays for email unsubscribe, user export, logs, personal/org model providers,
model policies, org logo, push subscriptions, user preferences, and workflows.
Also add `misc-routes.bdd.test.ts` to the pure-context chunk.

Commands:

- `node scripts/measure-memory.mjs --label api-tests-pure-context-35-roots-misc-slice --json .memory-results/latest.jsonl -- pnpm -F api exec tsc -p tsconfig.tests-pure-context-entries.json --noEmit`
- `node scripts/measure-memory.mjs --label api-tests-no-setup-app-54-roots-misc-slice --json .memory-results/latest.jsonl -- pnpm -F api exec tsc -p tsconfig.tests-no-setup-app.json --noEmit`

Results:

- Static split would improve from `34 clean / 20 dirty` to
  `35 clean / 19 dirty`; newly clean root: `misc-routes.bdd.test.ts`.
- `pure-context` expanded from 34 to 35 roots: passed, peak `2239.0 MiB`,
  duration `57.4s`.
- `tests-no-setup-app` 54-root chunk still OOMed, peak `2275.6 MiB`.

Conclusion: do not keep this broad migration as-is. It preserves type
strictness, but it imports a wide route slice into helper consumers that still
also reach the full route registry through other dirty helpers, which worsens
the current 54-root OOM peak by about `31 MiB` versus the prior `2244.2 MiB`.
The better follow-up is to split `api-bdd-misc.ts` into narrower helper modules
or migrate its consumers in smaller groups so dirty roots do not simultaneously
load both the full app and a broad explicit route slice.

### 24. Direct raw app route slices

Change tested: replace the two remaining direct `createApp` raw requests in
`billing-usage-media.bdd.test.ts` and `computer-use.bdd.test.ts` with
`createAppWithRoutes` backed by exact real route arrays.

Commands:

- `node scripts/measure-memory.mjs --label api-tests-no-setup-app-54-roots-direct-raw-route-slices --json .memory-results/latest.jsonl -- pnpm -F api exec tsc -p tsconfig.tests-no-setup-app.json --noEmit`
- `node scripts/measure-memory.mjs --label api-tests-direct-raw-route-slices --json .memory-results/latest.jsonl -- pnpm -F api exec tsc -p tsconfig.tests-direct-raw-route-slices.json --noEmit`

Results:

- Static split stayed at `34 clean / 20 dirty`; both roots still reached broad
  helper modules.
- Exact two-root slice still OOMed, peak `2238.5 MiB`.
- The 54-root chunk still OOMed, peak `2241.7 MiB`.

Conclusion: do not keep this as an isolated change. It preserves type
strictness and removes two direct app-factory imports, but it does not release
any root because both files still import broad helpers. The small 54-root peak
change is not useful without splitting those helpers first.

### 25. Host/maps BDD helper route slice

Change: migrate `api-bdd-host-maps.ts` from default `setupApp` to
`setupAppWithRoutes` backed by explicit real `zeroHostRoutes` and
`zeroMapsRoutes`. Split the `host-maps.bdd.test.ts` billing/maps dependency
away from broad `api-bdd-billing-media.ts` into a narrow
`api-bdd-maps-billing.ts` helper that covers only onboarding, billing status,
and maps routes. Add `tsconfig.tests-host-maps-slice.json` as a separate strict
test chunk instead of expanding the already-near-limit 34-root pure-context
chunk.

Commands:

- `node scripts/measure-memory.mjs --label api-tests-host-maps-slice --json .memory-results/latest.jsonl -- pnpm -F api exec tsc -p tsconfig.tests-host-maps-slice.json --noEmit`
- `node scripts/measure-memory.mjs --label api-tests-no-setup-app-54-roots-host-maps-slice --json .memory-results/latest.jsonl -- pnpm -F api exec tsc -p tsconfig.tests-no-setup-app.json --noEmit`

Results:

- Static split improved from `34 clean / 20 dirty` to
  `35 clean / 19 dirty`; newly clean root: `host-maps.bdd.test.ts`.
- `host-maps` standalone strict slice passed, peak `1894.2 MiB`, duration
  `40.1s`.
- `tests-no-setup-app` 54-root chunk still OOMed, but peak dropped to
  `2237.2 MiB`.

Conclusion: keep this change. It is a narrow, strictness-preserving helper
split that avoids both the broad billing/media helper and the full route
registry for a large host/maps BDD root. It also confirms the shipping path
should add more separate strict test chunks rather than growing the 34-root
pure-context chunk.

### 26. GitHub issue mock helper split for callback service tests

Change: split the GitHub issue API/env mocks used by
`agent-run-callback.service.test.ts` into a pure
`api-bdd-github-mocks.ts` helper. Keep the route BDD helper
`api-bdd-github.ts` unchanged for existing public exports, but point the
service test at the pure helper so it no longer imports the full GitHub route
BDD graph.

Commands:

- `node scripts/measure-memory.mjs --label api-tests-agent-run-callback-service-slice --json .memory-results/latest.jsonl -- pnpm -F api exec tsc -p tsconfig.tests-agent-run-callback-service-slice.json --noEmit`
- `node scripts/measure-memory.mjs --label api-tests-no-setup-app-54-roots-github-mocks-slice --json .memory-results/latest.jsonl -- pnpm -F api exec tsc -p tsconfig.tests-no-setup-app.json --noEmit`

Results:

- Static split improved from `35 clean / 19 dirty` to
  `36 clean / 18 dirty`; newly clean root:
  `agent-run-callback.service.test.ts`.
- `agent-run-callback.service` standalone strict slice passed, peak
  `1651.1 MiB`, duration `28.4s`.
- `tests-no-setup-app` 54-root chunk still OOMed, peak `2238.0 MiB`.

Conclusion: keep this change. It is a strictness-preserving pure helper split
with a healthy standalone chunk. The 54-root peak is effectively neutral versus
the previous `2237.2 MiB` run, but the full route graph now covers one fewer
service test root.

### 27. Computer-use BDD route slice

Change tested: migrate `computer-use.bdd.test.ts` away from its direct
`createApp` raw request and pure Clerk membership import, then migrate
`api-bdd-computer-use.ts` from default `setupApp` to `setupAppWithRoutes`
backed by explicit real `zeroComputerUseRoutes` and
`cronComputerUseScreenshotCleanupRoutes`.

Commands:

- `node scripts/measure-memory.mjs --label api-tests-computer-use-slice --json .memory-results/latest.jsonl -- pnpm -F api exec tsc -p tsconfig.tests-computer-use-slice.json --noEmit`
- `node scripts/measure-memory.mjs --label api-tests-no-setup-app-54-roots-computer-use-slice --json .memory-results/latest.jsonl -- pnpm -F api exec tsc -p tsconfig.tests-no-setup-app.json --noEmit`

Results:

- Static split would improve from `36 clean / 18 dirty` to
  `37 clean / 17 dirty`; newly clean root: `computer-use.bdd.test.ts`.
- `computer-use` standalone strict slice passed, peak `1516.7 MiB`, duration
  `20.5s`.
- `tests-no-setup-app` 54-root chunk still OOMed, peak worsened to
  `2280.4 MiB`.

Conclusion: do not keep this migration as an isolated change. The standalone
slice is healthy, but adding the computer-use route slice while the same
54-root program still imports many dirty helpers increases the monolithic OOM
peak. Revisit this after wiring a real sequential test-check runner that
excludes migrated roots from the remaining dirty chunk.

### 28. Org-team Slack-only helper slice

Change tested: move the one `org-team.bdd.test.ts` Slack cleanup scenario from
the broad `api-bdd-integrations.ts` helper to a new Slack-only helper backed by
real `zeroSlackOauthRoutes` and `zeroSlackConnectRoutes`.

Commands:

- `node scripts/measure-memory.mjs --label api-tests-org-team-slice --json .memory-results/latest.jsonl -- pnpm -F api exec tsc -p tsconfig.tests-org-team-slice.json --noEmit`
- `node scripts/measure-memory.mjs --label api-tests-no-setup-app-org-slack-split --json .memory-results/latest.jsonl -- pnpm -F api exec tsc -p tsconfig.tests-no-setup-app.json --noEmit`

Results:

- Static split would make `org-team.bdd.test.ts` stop touching the full app
  test helper graph.
- `org-team` standalone strict slice passed, peak `1866.1 MiB`, duration
  `38.8s`.
- `tests-no-setup-app` chunk still OOMed, peak worsened to `2269.4 MiB`
  versus the current branch's previous `2238.0 MiB`-class runs.

Conclusion: do not keep this migration as an isolated change. It creates a
valid strict slice, but the route-sliced Slack oauth/connect graph increases
the current monolithic API test program's peak while that same program still
contains the broad dirty helper set. Revisit only after the migrated root is
excluded from the remaining dirty chunk by a sequential runner.

### 29. Sequential runner feasibility: dirty test roots

Change tested: do not change code; generate temporary exact-root tsconfigs for
the remaining dirty BDD roots to see whether an `api` `check-types` runner can
replace the monolithic test program with strict sequential chunks.

Commands:

- `node scripts/measure-memory.mjs --label api-tests-dirty-18-roots --json .memory-results/latest.jsonl -- pnpm -F api exec tsc -p tsconfig.tmp-tests-dirty-roots.json --noEmit`
- `node scripts/measure-memory.mjs --label api-tests-dirty-a-9-roots --json .memory-results/latest.jsonl -- pnpm -F api exec tsc -p tsconfig.tmp-tests-dirty-a.json --noEmit`

Results:

- Remaining dirty roots after retained helper splits: `18`.
- The 18-root dirty chunk still OOMed, peak `2294.6 MiB`, duration `90.9s`.
- A 9-root half containing auth-device, billing/media, connectors, computer-use,
  and GitHub integration tests also OOMed, peak `2278.0 MiB`, duration `68.6s`.

Conclusion: do not ship a runner that simply separates clean tests from dirty
tests. The remaining dirty roots still share broad helpers that pull the full
route registry. A safe runner must either check those roots in much smaller
helper-family chunks or first continue the helper route-slicing work so the
dirty roots no longer import both explicit route slices and the full app graph.

### 30. Sequential runner feasibility: production entry graph

Change tested: do not change code, except for one reverted registry-shape
experiment. Check whether production can be covered by exact-file chunks and
whether changing `ROUTES` from a giant spread array to a typed route-group
array lowers peak memory.

Commands:

- `node scripts/measure-memory.mjs --label api-production-core-no-routes --json .memory-results/latest.jsonl -- pnpm -F api exec tsc -p tsconfig.tmp-production-core-no-routes.json --noEmit`
- `node scripts/measure-memory.mjs --label api-production-core-chunk-1-50-files --json .memory-results/latest.jsonl -- pnpm -F api exec tsc -p tsconfig.tmp-production-core-1.json --noEmit`
- `node scripts/measure-memory.mjs --label api-production-registry-flat-groups --json .memory-results/latest.jsonl -- pnpm -F api exec tsc -p tsconfig.production-no-vitest.json --noEmit`
- `node scripts/measure-memory.mjs --label api-production-app-entry --json .memory-results/latest.jsonl -- pnpm -F api exec tsc -p tsconfig.tmp-production-app-entry.json --noEmit`

Results:

- Production excluding `src/signals/routes/**/*.ts` still OOMed, peak
  `2274.9 MiB`.
- The first 50-file exact production chunk also OOMed, peak `2265.8 MiB`,
  because it included `app-factory.ts`, `index.ts`, and `server.ts`.
- Rewriting `ROUTES` as `flattenRouteGroups([healthRoutes, authMeRoutes, ...])`
  instead of one giant spread array was reverted: production still OOMed, peak
  `2271.8 MiB`.
- A minimal production app-entry chunk containing only `src/index.ts`,
  `src/server.ts`, and `src/app-factory.ts` still OOMed, peak `2273.9 MiB`.

Conclusion: production-side peak is dominated by the `app-factory.ts` to
`signals/route.ts` full registry edge. Exact-file chunking is not enough while
those three app-entry files import the complete registry in one program, and a
route-group `flat()` wrapper does not materially reduce TypeScript's memory.
The next no-strictness-loss production option is a deeper registry boundary:
keep every route leaf strictly checked in route chunks, then make the app-entry
program validate only the registry's `RouteEntry` boundary without rechecking
every route leaf in the same TypeScript program. That needs a carefully audited
implementation because a naive stub would lose type coverage.

### 31. Rebase onto latest main and refresh key measurements

Change: rebase the experiment branch onto latest `origin/main`
`ba104205214ef487ef0488ad0c92c38352bf2eaa`, then rerun the key package
baselines and the retained API test chunks with the same process-tree RSS
measurement.

Latest-main commands:

- `node /tmp/vm0-measure-memory.mjs --label latest-main-api-contracts-check-types --json .memory-results/latest.jsonl -- pnpm -F @vm0/api-contracts check-types`
- `node /tmp/vm0-measure-memory.mjs --label latest-main-app-check-types --json .memory-results/latest.jsonl -- pnpm -F @vm0/app check-types`
- `node /tmp/vm0-measure-memory.mjs --label latest-main-api-check-types --json .memory-results/latest.jsonl -- pnpm -F api check-types`

Rebased-branch commands:

- `node scripts/measure-memory.mjs --label rebased-api-contracts-check-types --json .memory-results/latest.jsonl -- pnpm -F @vm0/api-contracts check-types`
- `node scripts/measure-memory.mjs --label rebased-app-check-types --json .memory-results/latest.jsonl -- pnpm -F @vm0/app check-types`
- `node scripts/measure-memory.mjs --label rebased-api-check-types --json .memory-results/latest.jsonl -- pnpm -F api check-types`
- `node scripts/measure-memory.mjs --label rebased-api-tests-host-maps-slice --json .memory-results/latest.jsonl -- pnpm -F api exec tsc -p tsconfig.tests-host-maps-slice.json --noEmit`
- `node scripts/measure-memory.mjs --label rebased-api-tests-agent-run-callback-service-slice --json .memory-results/latest.jsonl -- pnpm -F api exec tsc -p tsconfig.tests-agent-run-callback-service-slice.json --noEmit`

Results:

- Latest main `@vm0/api-contracts`: passed, peak `1688.5 MiB`.
- Rebased branch `@vm0/api-contracts`: passed, peak `1678.9 MiB`.
- Latest main `@vm0/app`: passed, peak `2217.1 MiB`.
- Rebased branch `@vm0/app`: passed, peak `2223.5 MiB`.
- Latest main `api`: OOM, peak `2267.9 MiB`.
- Rebased branch `api`: OOM, peak `2274.4 MiB`.
- Rebased branch `host-maps` strict slice: passed, peak `1860.1 MiB`.
- Rebased branch `agent-run-callback.service` strict slice: passed, peak
  `1664.5 MiB`.

Conclusion: the retained API test slices survive the latest-main rebase and
remain comfortably below the full `api` OOM peak. The latest main changes moved
the app and contract peaks upward, so the branch's small app-side savings are
no longer visible in the aggregate package peak. The remaining high-value API
work is still the full registry edge and broad dirty BDD helper graph, not
dependency version fragmentation or contract package checking.

### 32. Auth-device helper route slice

Change tested: migrate `api-bdd-auth-device.ts` from default `setupApp` /
`createApp` to `setupAppWithRoutes` / `createAppWithRoutes` backed by real
auth, CLI auth, CLI auth test, desktop auth, device token, realtime token,
compose, agent/user-connector, billing status, Codex/Claude device-auth, and
model-provider routes. Add a strict two-root test slice covering
`auth-device.bdd.test.ts` and `cli-auth.bdd.test.ts`.

Command:

- `node scripts/measure-memory.mjs --label api-tests-auth-device-slice --json .memory-results/latest.jsonl -- pnpm -F api exec tsc -p tsconfig.tests-auth-device-slice.json --noEmit`

Results:

- Static analysis showed the two roots still reached the full app graph through
  other broad helper imports: `api-bdd-misc.ts` and `api-bdd-connectors.ts`.
- The two-root strict slice OOMed, peak `2274.6 MiB`, duration `96.9s`.

Conclusion: do not keep this migration as an isolated change. The helper's own
route clients can be made strict and explicit, but the consuming tests still
import broader dirty helpers, so the program loads both explicit route slices
and the full route registry. Revisit only after splitting `api-bdd-misc.ts` and
`api-bdd-connectors.ts` into narrower consumer-specific helpers.

### 33. Auth-device route slice plus narrow support helper

Change: keep the strict route-sliced `api-bdd-auth-device.ts` client from
experiment 32, and remove the remaining broad helper imports from
`auth-device.bdd.test.ts` and `cli-auth.bdd.test.ts`. Add
`api-bdd-auth-device-support.ts`, a consumer-specific helper backed by real
connector, feature-switch, model-provider, personal-model-provider, and
user-preference route arrays.

Commands:

- Static import closure check for `auth-device.bdd.test.ts` and
  `cli-auth.bdd.test.ts`.
- `node scripts/measure-memory.mjs --label api-tests-auth-device-route-support-slice --json .memory-results/latest.jsonl -- pnpm -F api exec tsc -p tsconfig.tests-auth-device-slice.json --noEmit`
- `node scripts/measure-memory.mjs --label api-tests-no-setup-app-54-roots-auth-device-route-support-slice --json .memory-results/latest.jsonl -- pnpm -F api exec tsc -p tsconfig.tests-no-setup-app.json --noEmit`

Results:

- Static local closure for each of the two roots dropped from `496` files with
  `app-factory.ts` / `src/__tests__/test-helpers.ts` offenders to `94` files
  with no full-app offenders.
- The two-root strict slice passed, peak `1811.0 MiB`, duration `42.8s`.
  Compared with experiment 32's isolated helper migration, this changes the
  same slice from `2274.6 MiB` OOM to a passing strict program.
- The 54-root `tests-no-setup-app` aggregate still OOMed, peak `2291.9 MiB`.
  This is worse than the current retained `2238 MiB`-class aggregate runs
  because remaining dirty roots still import broad helpers/full registry while
  this aggregate also loads the new explicit auth-device route slice.

Conclusion: keep the narrow helper split as a strictness-preserving building
block, but do not add these roots to an already near-limit aggregate test
chunk. The shipping `api` check-types design needs sequential strict chunks
that exclude migrated roots from the remaining dirty program. Under that
runner shape, this experiment contributes a healthy standalone auth-device
chunk with a peak far below the full `api` OOM.

## Current conclusions

- `@vm0/app`: keep the pure type module splits from experiments 6 and 7. They
  preserve public exports and type strictness. On latest `origin/main`, app
  measured `2217.1 MiB`; on the rebased branch it measured `2223.5 MiB`.
- `@vm0/api-contracts`: latest-main cold peak is `1688.5 MiB`; the rebased
  branch measured `1678.9 MiB`. This package is not the main problem.
- `api`: dependency dedupe/declaration boundaries and route registry reshaping
  did not solve the OOM. The effective direction is strict sequential chunks,
  and the strongest measured chunks are route leaves (`2057.9 MiB` max),
  explicit-route tests (`1026.0 MiB` for callback-route), route-free
  pure-context tests (`2233.9 MiB` for 34 roots), and the host/maps BDD chunk
  (`1860.1 MiB` after rebase) plus callback-service chunk (`1664.5 MiB` after
  rebase) plus the auth-device chunk (`1811.0 MiB`). Full `api` still OOMs at
  `2267.9 MiB` on latest main and `2274.4 MiB` on the rebased branch.
- A package-local sequential `api` `check-types` runner is not ready to ship as
  a simple clean/dirty split: the remaining dirty 18-root test chunk OOMs at
  `2294.6 MiB`, a representative dirty 9-root chunk OOMs at `2278.0 MiB`, and
  the minimal production app-entry chunk (`index.ts`, `server.ts`,
  `app-factory.ts`) OOMs at `2273.9 MiB` because it expands the full route
  registry.
- Direct route test entries are worth keeping: they eliminate every direct
  `app-factory.ts` edge in `tsconfig.tests-no-setup-app.json` without reducing
  strictness.
- Next API work should migrate remaining BDD/setup helpers from default
  `setupApp` to explicit route arrays and `createAppWithRoutes` where possible,
  but avoid broad helper migrations that are still imported by dirty roots.
  Good next candidates are narrower consumer-specific slices in
  `api-bdd-billing-media.ts`,
  `api-bdd-integrations.ts` / `api-bdd-webhooks.ts`,
  and `api-bdd-connectors.ts`; for `api-bdd-misc.ts`, split it into narrower
  modules first. After that, wire route/test/core chunks through a
  package-local `check-types` runner so `api` no longer relies on one
  monolithic `tsc` program.
