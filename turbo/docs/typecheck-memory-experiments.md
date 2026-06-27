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

## Current conclusions

- `@vm0/app`: keep the pure type module splits from experiments 6 and 7. They
  preserve public exports and type strictness, reduce peak by `5.5 MiB` in the
  combined measured state, and improve import boundaries.
- `@vm0/api-contracts`: current cold peak is `1686.4 MiB`; not the main problem.
- `api`: dependency dedupe/declaration boundaries and route registry reshaping
  did not solve the OOM. The effective direction is strict sequential chunks,
  but full correctness still requires solving registry/core/test coverage.
- Next API work should target test helpers first: replace default `setupApp`
  usage with explicit route arrays where possible, so tests can be chunked
  without importing the whole `ROUTES` registry. After that, wire route/test/core
  chunks through a package-local `check-types` runner.
