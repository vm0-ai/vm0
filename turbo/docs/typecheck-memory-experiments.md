# Type-check memory experiments

Date: 2026-06-27
Base branch: `main`
Base commit: `f97340e2e91de2eb46e75ceb40967b335024673a`

## Constraints

- Do not reduce type strictness.
- Do not replace precise application types with broad stubs.
- Keep `tsc --noEmit` as the correctness gate for every affected package.
- Clean `.tsbuildinfo` before comparable cold runs because `api` and
  `@vm0/app` enable incremental checking.
- Measure full process-tree peak RSS with `node scripts/measure-memory.mjs`.

## Baselines

- `@vm0/api-contracts`: passed, peak RSS `1686.4 MiB`, duration `31.7s`.
- `@vm0/app`: passed, peak RSS `2188.7 MiB`, duration `57.8s`.
- `api`: failed with V8 heap OOM on the latest-main full check. Earlier same
  commit baseline was peak RSS `2273.0 MiB`, duration `56.2s`.

## Static diagnostics

- Relative import SCC scan found one large `api` cycle centered on
  `signals/route.ts`. Splitting `RouteEntry` into `signals/route-entry.ts`
  removes the route leaf -> registry type-only edge and is required for useful
  route leaf chunking.
- A fresh lockfile package-entry scan found `113` package names with multiple
  versions. Notable type-graph candidates include `esbuild` and `type-fest`;
  broader SDK families such as Clerk, Sentry, OpenTelemetry, and Babel should
  still be reviewed with a package-manager-level dedupe report before making
  lockfile changes.
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

## Current conclusions

- `@vm0/app`: keep the pure type module splits from experiments 6 and 7. They
  preserve public exports and type strictness, reduce peak by `5.5 MiB` in the
  combined measured state, and improve import boundaries.
- `@vm0/api-contracts`: current cold peak is `1686.4 MiB`; not the main problem.
- `api`: dependency dedupe/declaration boundaries and route registry reshaping
  did not solve the OOM. The effective direction is strict sequential chunks,
  and the strongest measured chunks are route leaves (`2057.9 MiB` max),
  explicit-route tests (`1026.0 MiB` for callback-route), and route-free
  pure-context tests (`1963.2 MiB` for 12 roots).
- Next API work should migrate BDD/setup helpers from default `setupApp` to
  explicit route arrays and `createAppWithRoutes` where possible. After that,
  wire route/test/core chunks through a package-local `check-types` runner.
