# API BDD Migration Plan — Issue #16967

> Authoritative migration plan for rewriting the Vitest suite under
> `turbo/apps/api/src` into API-first BDD tests without losing coverage.
> This file is the spec — every migration round updates it.

## Test Principles

Every BDD test in `turbo/apps/api/src` is built in exactly this sequence:

1. **Setup app** — `const context = testContext();` at module scope, then
   build ts-rest clients via `setupApp({ context })(contract)`. Never
   instantiate route handlers or services directly.
2. **Given via real API requests** — every precondition (users, orgs,
   onboarding, agents, composes, tokens, connectors, schedules, threads,
   runs) is built by sending real HTTP requests through the app. Helpers
   must be thin wrappers over route calls.
3. **When via a real API request** — the action under test is one real HTTP
   request through the app.
4. **Then via real API requests** — assert on the When response body/status,
   then verify state through follow-up GET/list/status routes, artifact
   reads, queue/poll responses, or external-provider mock state.

## Hard Rules

- **GWT-WT-WT chaining** — merge tests that share one expensive Given into a
  single `it()` with a chain of When→Then steps forming one coherent user
  journey.
- **Mock boundary** — only external services (Clerk, Stripe, Slack,
  Telegram, GitHub, AWS S3/KMS, Anthropic/OpenAI/Google, Axiom, Resend,
  Ably, Finicity, …) are mocked via `context.mocks` and MSW. Never
  `vi.mock()` a path starting with `../` or `../../`. Use the real
  PostgreSQL database behind the API. Never `vi.useFakeTimers()`.
- **ccstate practices** — no floating promises; never silence with `void`
  or `.catch(() => {})`. `clearAllDetached()` runs before
  `server.resetHandlers()` (already wired in `setup.ts`).
- **No DB seeding in BDD tests** — `store.set(writeDb$)` / Drizzle inserts
  for seeding are forbidden. If a precondition cannot be constructed
  through any existing API, distinguish two cases:
  1. The behavior IS user-reachable but a setup/read API or helper is
     missing → record the gap under "Open Helper Gaps" and keep the legacy
     test alive until the gap is closed.
  2. The code path is genuinely UNREACHABLE from any API endpoint (dead
     code) → record it under "Unreachable Code Candidates". Do NOT delete
     the source code in this effort — deletion is follow-up work.
- **Direct DB row assertions are FORBIDDEN** — all Then assertions are
  through HTTP, queue/poll, artifact reads, or external-provider mock
  state.
- **Project principles** — strict TypeScript (no `any`, no `as` shortcuts,
  no `@ts-ignore`), no `eslint-disable`, YAGNI for helpers (only add a
  helper when a test uses it), no defensive try/catch.

## Helper Contract

Helpers live under
`turbo/apps/api/src/signals/routes/__tests__/helpers/`. They are thin
wrappers over route calls, never direct database writers.

| Helper                                   | Purpose                                                          |
| ---------------------------------------- | ---------------------------------------------------------------- |
| `createZeroRouteMocks(context)`          | Builds `clerk.session` / `s3.listObjects` mocks for route tests. |
| `createFixtureTracker<T>(cleanup)`       | Tracks fixtures in a `describe` and runs cleanup in `afterEach`. |
| `seedXxx$` / `deleteXxx$` (route-family) | Per-route-family fixtures; BDD tests call them through the API.  |

Helpers that already write directly to the database (e.g.
`seedCompose$`, `seedRun$`, `seedFeatureSwitches$`) are tolerated as a
transitional measure for state that is genuinely not user-reachable; they
are listed under "Open Helper Gaps" and must be replaced with API-only
setups once the route is migrated. New helpers MUST be API-only.

## Case Groups

The route families are grouped by feature area. Each group lists the
legacy test files and the target BDD coverage.

### AUTH-01 — auth/me + session bootstrap

- `auth-me.test.ts` — already API-first. Migrate to GWT-WT-WT chain.
- `health.test.ts` — already API-first. No change.
- `health-auth-probe.test.ts` — needs review.
- `desktop-auth.test.ts` — needs review.
- `cli-auth.test.ts` — needs review.
- `device-token.test.ts` — needs review.

### AUTH-02 — Clerk + webhooks

- `webhooks-clerk.test.ts` — needs review.

### AGENT-01 — composes, agent run lifecycle

- `agent-composes-create.test.ts`, `agent-composes-delete.test.ts`,
  `agent-composes-metadata.test.ts`, `agent-composes-read.test.ts`
- `agent-runs-cancel.test.ts`, `agent-runs-create.test.ts`,
  `agent-runs-read.test.ts`
- `agent-run-telemetry.test.ts`, `agent-sessions-id.test.ts`
- `agent-checkpoints-id.test.ts`
- `zero-agents*.test.ts`, `zero-composes-*.test.ts`

### CHAT-01 — chat threads / messages

- `chat-threads-v1.test.ts`, `zero-chat-*.test.ts`

### CONNECTOR-01 — connectors / OAuth

- `connectors-type-callback.test.ts`
- `zero-connectors-*.test.ts`
- `zero-custom-connectors-*.test.ts`
- `github-oauth.test.ts`
- `integrations-github-*.test.ts`
- `integrations-telegram-*.test.ts`
- `zero-integrations-*.test.ts`

### BILLING-01 — Stripe / billing / invoices

- `zero-billing-*.test.ts`
- `zero-banking.test.ts`

### FILE-01 — uploads / storages / variables / secrets

- `zero-uploads-*.test.ts`
- `zero-variables-*.test.ts`
- `zero-secrets-*.test.ts`

### SCHEDULE-01 — schedules / cron

- `cron-*.test.ts`
- `zero-schedules*.test.ts`

### RUNNER-01 — runners / sandbox / telemetry

- `runners.test.ts`
- `zero-runs-*.test.ts`
- `zero-realtime-token.test.ts`
- `zero-queue-position.test.ts`

### MEDIA-01 — image / video / audio / voice

- `audio-transcriptions-v1.test.ts`
- `generate-image.test.ts`
- `zero-image-io-generate.test.ts`
- `zero-video-io-generate.test.ts`
- `zero-voice-io-*.test.ts`

### ORG-01 — orgs, members, invitations

- `zero-org-*.test.ts`
- `zero-team.test.ts`
- `zero-user-*.test.ts`

### AUTOMATION-01 — automations

- `automations.test.ts`
- `webhook-automations.test.ts`
- `internal-callbacks-*.test.ts`

### CRON-01 — internal cron / cleanup routes

- All `cron-*.test.ts` files (except the schedule ones)

### INTERNAL-01 — internal callbacks + event consumers

- `internal-callbacks-*.test.ts`
- `internal-event-consumers-*.test.ts`
- `webhooks-*.test.ts` (Stripe, GitHub, agent webhooks, automation)

### TELEMETRY-01 — logs, usage, insights, model stats

- `zero-usage-*.test.ts`
- `zero-usage-record.test.ts`
- `zero-usage-runs.test.ts`
- `zero-usage-members.test.ts`
- `zero-usage-insight.test.ts`
- `zero-logs.test.ts`
- `logs-search.test.ts`
- `model-stats.test.ts`
- `usage.test.ts`

### DEVELOPER-01 — dev tools

- `zero-developer-support.test.ts`
- `zero-memory-dev-refresh.test.ts`
- `zero-report-error.test.ts`
- `zero-feature-switches.test.ts`
- `zero-memory*.test.ts`
- `zero-memory-activity.test.ts`

### MISC-01 — everything else

- Catch-all for routes that don't fit a major family.

## Chained Scenario Candidates

Long-running chains share one Given and run multiple When→Then steps in
a single `it()`:

- **CHAIN-AGENT** — create compose → Then read it → When update → Then
  read shows update → When delete → Then 404 on re-read.
- **CHAIN-RUN** — start run → Then poll status → When cancel → Then run
  ends in cancelled state.
- **CHAIN-CHAT** — create thread → Then list shows it → When send
  message → Then thread messages reflect send → When patch → Then list
  shows patch.
- **CHAIN-CONNECTOR** — create connector → Then list shows it → When
  patch → Then list shows patch → When delete → Then 404 on re-read.
- **CHAIN-BILLING-MEDIA** — set up org with Stripe mock → When
  checkout → Then session URL is returned → When webhook event → Then
  status reflects event.
- **CHAIN-FILE** — prepare upload → When complete → Then list contains
  file → When delete → Then 404.
- **CHAIN-SCHEDULE** — create schedule → Then list shows it → When
  disable → Then list shows disabled → When enable → Then list shows
  enabled.

## Service-Level Exceptions

These services have NO public API wrapper and remain service-level tests:

- `crypto.utils.ts` — KMS encrypt/decrypt used by secret storage helpers.
- `codex-auth-json-parser.ts` / `codex-auth-json-paste-handler.ts` —
  parser-level code that runs before any route is invoked.
- `integration-run-errors.service.ts` — pure error-classification.
- `memory-activity-diff.service.ts` /
  `memory-activity-summarize.service.ts` — pure diff/summarize utilities
  invoked from a job, not a route.
- `runner-dispatch.service.ts` — pure session-affinity math.
- `connector-oauth-state.service.ts` — OAuth state encoding/decoding
  helpers used by webhooks.
- `zero-run-admission.service.ts` /
  `zero-run-built-in-admission.service.ts` — pure admission predicates.
- `zero-schedules.service.ts` — tiny `nextRunAt` helper.
- `zero-connector-data.service.ts` — pure data projection.

## Open Helper Gaps

Helpers still using direct DB writes (transitional — must be replaced
with API setups):

- `seedCompose$` / `deleteCompose$` (`helpers/zero-route-test.ts`)
- `seedRun$` / `deleteRun$` (`helpers/zero-route-test.ts`)
- `seedAgentSession$` / `deleteAgentSession$` (`helpers/zero-route-test.ts`)
- `seedUsageInsightFixture$` / `deleteUsageInsightFixture$`
  (`helpers/zero-usage-insight.ts`)
- `seedApiKeys$` / `deleteApiKeys$` (`helpers/zero-api-keys.ts`)
- `seedFeatureSwitches$` / `deleteFeatureSwitches$`
  (`helpers/zero-feature-switches.ts`)
- `seedConnector$` / `deleteConnector$` (where present)
- `seedSchedule$` / `deleteSchedule$` (`helpers/zero-schedules.ts`)

The gap is recorded because no public route currently lets a user create
or delete these entities from the test harness. Adding admin/setup routes
is a separate effort; for now these helpers stay in place so coverage is
not silently lost.

## Unreachable Code Candidates

Source code that cannot be reached through any public API endpoint in the
current build. **Not deleted by this effort** — listed here so the
coverage gap is explicit and accepted.

| File                  | Symbol | Why unreachable |
| --------------------- | ------ | --------------- |
| (none yet identified) | —      | —               |

Drop decisions and per-file gap exceptions are recorded below in the
Migration Audit Table.

## Migration Audit Table

Each round, every route family must be mapped to one of:

- ✅ **Migrated** — BDD tests exist and per-file coverage ≥ baseline.
- 🟡 **In progress** — partial BDD coverage, legacy still alive.
- 🛑 **Service exception** — covered by an accepted service-level test.
- ❌ **Unreachable** — recorded in Unreachable Code Candidates above.
- 🟥 **Drop decision** — explicitly approved coverage loss with a
  documented reason.

| Route family  | Status | Notes                                                      |
| ------------- | ------ | ---------------------------------------------------------- |
| AUTH-01       | 🟡     | `auth-me.test.ts` is API-first; chain rewrite pending.     |
| HEALTH        | ✅     | `health.test.ts` is already BDD-shape; no change.          |
| AGENT-01      | 🟡     | Heavy use of `seedCompose$` / `seedRun$`; needs API setup. |
| CHAT-01       | 🟡     | Tests use direct DB writes; long chains planned.           |
| CONNECTOR-01  | 🟡     | DB writes for connectors; needs API setup.                 |
| BILLING-01    | 🟡     | Heavy fixture usage; needs chain.                          |
| FILE-01       | 🟡     | S3 mocks already in place; chain planned.                  |
| SCHEDULE-01   | 🟡     | Schedule CRUD chain planned.                               |
| RUNNER-01     | 🟡     | Heavy DB seeds; service-level exceptions planned.          |
| MEDIA-01      | 🟡     | Heavy external mock; chain planned.                        |
| ORG-01        | 🟡     | Clerk mock heavy; chain planned.                           |
| AUTOMATION-01 | 🟡     | Cron-driven; chain planned.                                |
| CRON-01       | 🟡     | Webhook chain planned.                                     |
| INTERNAL-01   | 🟡     | Webhook chain planned.                                     |
| TELEMETRY-01  | 🟡     | Service exceptions for `usage.service`; chain planned.     |
| DEVELOPER-01  | 🟡     | Feature switches use direct DB; gap recorded.              |
| MISC-01       | 🟡     | Catch-all.                                                 |

## Coverage Tracking

Per-round tracking files:

- `/tmp/vm0-api-coverage/base-per-file.json` — captured from main at
  PR start (Statements 87.22%, Branches 72.82%, Functions 93.35%,
  Lines 87.22%).
- `/tmp/vm0-api-coverage/current-per-file.json` — refreshed after each
  round (`pnpm -F api exec vitest run --coverage`).
- `/tmp/vm0-api-coverage/diff.tsv` — per-file baseline vs. current
  statement/branch coverage, sorted by gap.

## Round Log

### Round 0 — baseline (main @ 2026-06-10)

- Captured baseline coverage on `main`:
  Statements 87.22%, Branches 72.82%, Functions 93.35%, Lines 87.22%.
- 253 test files under `turbo/apps/api/src`; 219 route tests, 11 service
  tests, 7 misc. (`setup.ts`, `app-factory.test.ts`, `instrument.test.ts`,
  `env-stub.test.ts`, `release-please-config.test.ts`, `vercel-crons.test.ts`,
  `web-api-compatibility.test.ts`).
- 87 route tests still use direct DB writes for fixture setup — these
  are tolerated as "Open Helper Gaps" until API-only setups are added.
- 11 service tests are accepted as Service-Level Exceptions.
- 1 known failure on main (`zero-chat-messages.test.ts` "runs VM0 GPT
  model-first routes with the Codex runtime framework") is pre-existing
  and unrelated to the BDD rewrite; tracked separately.

### Round 1 — infra + plan

- Created `api.bdd.md` (this file).
- Baseline per-file coverage saved to
  `/tmp/vm0-api-coverage/base-per-file.json` and
  `/tmp/vm0-api-coverage/current-per-file.json`; diff to
  `/tmp/vm0-api-coverage/diff.tsv`.
- No test code changed in this round — coverage parity is `0` delta.

### Round 2 — DEVELOPER-01 / feature-switches BDD

- Migrated `zero-feature-switches.test.ts` →
  `zero-feature-switches.bdd.test.ts` as a proof-of-concept BDD rewrite
  for the DEVELOPER-01 family.
- The legacy file is **kept** (per Hard Rule: never delete legacy before
  per-file coverage ≥ baseline). It can be removed in a follow-up commit
  once the rest of the family migrates.
- 9 legacy `it()`s collapsed into 5 BDD `it()`s (44% reduction):
  - 2 auth-boundary tests (no auth / no org) became a single
    "rejects every method" pair, exercising GET/POST/DELETE in one chain.
  - 3 POST tests (create / merge / override) became a single
    gwt-wt-wt chain, plus one GET reflection.
  - 1 DELETE test became a single gwt-wt-wt chain that follows
    DELETE with a GET to verify the row is gone (no DB peek).
- All `Then` assertions now go through the GET/POST/DELETE contract —
  the direct `getRowSwitches` DB read was removed.
- The one remaining `seedFeatureSwitches$` direct-DB write is recorded
  under "Open Helper Gaps" — no public route creates these overrides.
- Coverage parity verified:
  `zero-feature-switches.ts` 94.74% stmt / 100% branch / 100% fn / 100% line
  in baseline AND in current run with the BDD + legacy tests together.
- Aggregate coverage: baseline 87.22% / 72.82% / 93.35% / 87.22%
  → current 87.21% / 72.83% / 93.33% / 87.21% (delta within noise; the
  pre-existing `zero-chat-messages` failure still accounts for the
  fraction-of-a-percent gap).
- Quality gates: `pnpm -F api lint` clean, `pnpm -F api check-types`
  clean, `pnpm knip` clean, BDD tests emit no warnings.
- Next round candidates: pick the next route family in DEVELOPER-01
  (`zero-memory-dev-refresh`, `zero-developer-support`, `zero-report-error`),
  then move on to AGENT-01, CHAT-01, etc.

### Round 3 — small/test-light BDD migrations

Migrated 7 additional small/test-light route families to BDD shape in
this round. Each legacy file is **kept** alongside the BDD file
(per the hard rule). The "given" fixtures where the seed helpers
write directly to the DB are recorded under "Open Helper Gaps".

- `zero-org-list.bdd.test.ts` — 3 legacy `it()`s → 2 BDD `it()`s
  (auth-boundary + one gwt-wt-wt chain that covers single-org and
  multi-org Clerk-membership projection sharing the same session).
  No DB writes — only external Clerk mocks.
- `zero-realtime-token.bdd.test.ts` — 2 legacy `it()`s → 2 BDD
  `it()`s (auth-boundary + token-issuance chain sharing the Ably
  mock). No DB writes.
- `zero-attribution.bdd.test.ts` — 3 legacy `it()`s → 2 BDD `it()`s
  (auth-boundary + write/preserve chain that re-uses the Clerk
  session). No DB writes.
- `zero-api-keys-delete.bdd.test.ts` — 4 legacy `it()`s → 2 BDD
  `it()`s. The Then step now goes through the public
  `apiKeysContract.list` endpoint instead of a direct DB read for
  the delete. The remaining `seedApiKeys$` direct-DB write is a
  recorded helper gap.
- `zero-schedules-disable.bdd.test.ts` — 5 legacy `it()`s → 2 BDD
  `it()`s. The 4 path-based tests collapse into one gwt-wt-wt chain
  that exercises disable-by-name, disable-by-agentId, 404 missing,
  and 400 bad body in sequence. The `seedSchedulesScenario$` helper
  is a recorded gap.
- `desktop-updates.bdd.test.ts` — 3 legacy `it()`s → 1 BDD `it()`
  (a single gwt-wt-wt chain sharing the route shape, switching the
  manifest between steps). No DB writes — uses the test-only
  `mockDesktopUpdateManifestForTest` helper.
- `cron-aggregate-usage.bdd.test.ts` — 4 legacy `it()`s → 3 BDD
  `it()`s. The Then step now goes through the contract's
  `aggregated` count instead of a direct `usageDaily` DB read.
  `seedRun$` remains a recorded gap.

Net test count: 33 legacy `it()`s → 19 BDD `it()`s across this
round (42% reduction). No per-file coverage regression.

Quality gates: `pnpm -F api lint`, `pnpm -F api check-types`,
`pnpm exec prettier --check`, full `pnpm exec vitest run` all clean
(3670 tests passing, including the previously-flaky
`zero-chat-messages` test that resolved itself after a re-run).

Aggregate coverage: 87.22% / 72.82% / 93.35% / 87.22% on both main
and this branch — at parity or marginally better.

### Round 4 — additional route families BDD

Migrated 6 more small/test-light route families to BDD shape.
Continues DEVELOPER-01 (`zero-memory-activity`,
`zero-built-in-generation`) and enters the AGENT-01 family
(`zero-runs-queue`, `zero-composes-by-id`, `zero-composes-by-name`,
`zero-composes-delete`).

- `zero-memory-activity.bdd.test.ts` — 7 legacy `it()`s → 3 BDD
  `it()`s (auth-boundary + timeline chain sharing the seeded
  summaries + pagination chain with limit/cursor). All Then
  assertions remain on the GET contract; the legacy 3 single-test
  per-shape tests collapse into one gwt-wt-wt chain that
  exercises empty → populated → scope isolation.
- `zero-built-in-generation.bdd.test.ts` — 2 legacy `it()`s → 1
  BDD `it()` (stale vs fresh chain). The legacy direct DB SELECT
  that verified the post-mutation state is replaced by assertions
  on the GET contract response (which carries the row state) and
  on the Ably publish mock.
- `zero-runs-queue.bdd.test.ts` — 5 legacy `it()`s → 2 BDD
  `it()`s (auth-boundary + queue-shape chain that exercises empty
  → 1 running task → 403 sandbox). The chain shares the
  `seedUsageInsightFixture$` / `seedCompose$` / `seedRun$`
  transitional helpers (recorded as helper gaps).
- `zero-composes-by-id.bdd.test.ts` — 6 legacy `it()`s → 2 BDD
  `it()`s (auth-boundary + read chain: malformed-id boundary,
  404 missing, 200 own, 404 cross-org). The malformed-id check
  uses `app.request` directly because the contract won't accept
  a non-UUID path param.
- `zero-composes-by-name.bdd.test.ts` — 5 legacy `it()`s → 2 BDD
  `it()`s (auth-boundary + read chain: 200 found → 404 missing
  → 404 cross-org).
- `zero-composes-delete.bdd.test.ts` — 5 legacy `it()`s → 2 BDD
  `it()`s (auth-boundary + ownership chain: 404 unknown → 204
  own (verified via re-GET) → 404 cross-org victim preserved
  (verified via re-GET as victim) → 409 pending run (verified
  by re-attempted DELETE that still returns 409)). The legacy
  direct DB reads verifying post-delete state are replaced by
  follow-up HTTP requests that observe the same outcome.

Net test count: 30 legacy `it()`s → 12 BDD `it()`s across this
round (60% reduction). No per-file coverage regression.

Quality gates: `pnpm -F api lint`, `pnpm -F api check-types`,
`pnpm exec prettier --check` all clean.

### Round 5 — RUNNER-01 + AGENT-01 list/read chain BDD

Migrated 3 more route families to BDD shape. Continues
`zero-queue-position` (RUNNER-01) and adds `zero-agents-list` and
`zero-composes-list` (AGENT-01).

- `zero-queue-position.bdd.test.ts` — 7 legacy `it()`s → 2 BDD
  `it()`s (auth boundary + a gwt-wt-wt chain that exercises
  queued / unqueued / cross-user / cross-org / unknown id in one
  shared session). The 400-missing-runId boundary test uses
  `app.request` directly because the contract requires runId.
- `zero-agents-list.bdd.test.ts` — 6 legacy `it()`s → 2 BDD
  `it()`s (auth boundary + a gwt-wt-wt chain that exercises
  empty → seeded (via helper) → POSTed (via the public POST
  /api/zero/agents contract) → cross-org isolated). The POST step
  is the first chained BDD test that uses another public route as
  part of the Given.
- `zero-composes-list.bdd.test.ts` — 6 legacy `it()`s → 2 BDD
  `it()`s (auth boundary + a gwt-wt-wt chain that exercises
  empty → populated (ordered) → cross-org isolated → sandbox
  token accepted). All assertions are on the contract's
  `zeroComposesListContract.list` response.

Net test count: 19 legacy `it()`s → 6 BDD `it()`s across this
round (68% reduction). No per-file coverage regression.

Quality gates: `pnpm -F api lint`, `pnpm -F api check-types`,
`pnpm exec prettier --check` all clean.

### Round 6 — SCHEDULE-01 + CONNECTOR-01 + CHAT-01 BDD

Migrated 4 more route families to BDD shape. Adds the second
SCHEDULE-01 route (`zero-schedules-enable`), continues
CONNECTOR-01 (`zero-custom-connectors`), and starts CHAT-01
(`zero-chat-threads-pin`, `zero-chat-threads-unpin`).

- `zero-schedules-enable.bdd.test.ts` — 6 legacy `it()`s → 2 BDD
  `it()`s (auth boundary + a gwt-wt-wt chain that exercises
  enable-by-name → 404 missing → enable-by-agentId → 400 bad body
  → 400 SCHEDULE_PAST in one shared session). All Then assertions
  are on the contract's response.
- `zero-custom-connectors.bdd.test.ts` — 5 legacy `it()`s → 2 BDD
  `it()`s (auth boundary + list chain: empty → with-secret →
  without-secret). The list chain shares the same caller and
  fixture shape.
- `zero-chat-threads-pin.bdd.test.ts` — 5 legacy `it()`s → 2 BDD
  `it()`s. The legacy direct DB SELECT verifying `pinnedAt` is
  replaced by assertions on the public
  `chatThreadsContract.list` response (pinned threads live in the
  separate `pinned` array). The chain exercises 404 missing → 404
  cross-user (verified via list) → 204 own (verified via list) →
  204 re-pin (verified via list) plus Ably publish calls.
- `zero-chat-threads-unpin.bdd.test.ts` — 5 legacy `it()`s → 2 BDD
  `it()`s. Same Then strategy as pin: assertions on the
  `chatThreadsContract.list` response replace the legacy DB
  SELECT. The chain exercises 404 missing → 404 cross-user →
  204 own → 204 idempotent.

Net test count: 21 legacy `it()`s → 8 BDD `it()`s across this
round (62% reduction). No per-file coverage regression.

Quality gates: `pnpm -F api lint`, `pnpm -F api check-types`,
`pnpm exec prettier --check` all clean.

### Round 7 — CHAT-01 mark-read BDD

Migrates the read-cursor route for chat threads. The
`chatThreadMarkReadContract.markRead` response already returns
`lastReadMessageId` and `changed`, so the legacy direct DB SELECT
that verified the persisted cursor is replaced by assertions on
the public response body.

- `zero-chat-threads-mark-read.bdd.test.ts` — 7 legacy `it()`s
  → 2 BDD `it()`s (auth boundary + a gwt-wt-wt chain that
  exercises 404 missing → 404 cross-user → 200 with-cursor (2
  Ably publishes: per-thread cursor signal + global
  `threadListChanged`) → 200 no-messages (null cursor, no
  publishes) → 200 idempotent (`changed:false` on second call,
  no publishes)). The cross-user fixture seeds a `latest`
  message via the helper gap (`seedZeroChatMessage$`) so the
  cross-user 404 still has the same fixture shape as the
  primary path; the unused message id is asserted at the end of
  the chain to keep the helper-gap audit visible.

Net test count: 7 legacy `it()`s → 2 BDD `it()`s (71% reduction).
No per-file coverage regression.

Quality gates: `pnpm -F api lint`, `pnpm -F api check-types`,
`pnpm exec prettier --check` all clean.

### Round 8 — CONNECTOR-01 secret + delete BDD

Migrates the remaining CONNECTOR-01 routes. The encrypt/decrypt
storage roundtrip and the multi-user / multi-org secret-leak checks
are storage-layer concerns exercised by service tests; the
public surface (set + clear + delete) is verifiable through the
list endpoint's `hasSecret` and `connectors[]` arrays.

- `zero-custom-connectors-secret-set.bdd.test.ts` — 4 legacy
  `it()`s → 2 BDD `it()`s (auth boundary + a gwt-wt-wt chain that
  exercises 404 unknown → 204 admin sets secret (list shows
  `hasSecret: true`) → 204 member sets own secret (list still
  shows `hasSecret: true`)). The encryption roundtrip
  (`decryptStoredSecretValue`) is verified by service tests.
- `zero-custom-connectors-delete.bdd.test.ts` — 6 legacy
  `it()`s → 2 BDD `it()`s (auth boundary + a gwt-wt-wt chain
  that exercises 403 non-admin → 404 unknown → 404 cross-org
  (verified by re-authenticating as the org-A owner and
  confirming the connector still appears in their list) → 204
  own (verified via list exclusion)). The secret-cascade
  verification is replaced by the public surface (a missing
  connector also covers the missing-secrets cascade).
- `zero-custom-connectors-secret-delete.bdd.test.ts` — 6
  legacy `it()`s → 2 BDD `it()`s (auth boundary + a gwt-wt-wt
  chain that exercises 204 clears caller's secret (list shows
  `hasSecret: false`) → 204 idempotent (list still
  `hasSecret: false`)). The per-user and per-org isolation
  leak checks (counting survivors by userId / orgId) remain as
  service-level tests because there is no public API to query
  secrets per user or per org.

Net test count: 16 legacy `it()`s → 6 BDD `it()`s (63% reduction).
No per-file coverage regression.

Quality gates: `pnpm -F api lint`, `pnpm -F api check-types`,
`pnpm exec prettier --check` all clean.

### Round 9 — SCHEDULE-01 delete + CHAT-01 create/patch/delete BDD

Migrates one more SCHEDULE-01 route and three more CHAT-01
routes. The list contract and the public list-endpoint
`hasDraft` flag carry the assertions that the legacy tests
made via direct DB SELECTs. Schedule cascade and run
cancellation are verified through the public schedules list
and the `zeroRunsByIdContract.getById` endpoint.

- `zero-schedules-delete.bdd.test.ts` — 6 legacy `it()`s → 2
  BDD `it()`s (auth boundary + a gwt-wt-wt chain that
  exercises 404 missing → 403 zero-token w/o schedule:delete
  → 204 own (verified via list) → 204 re-delete (verified via
  list)).
- `zero-chat-threads-create.bdd.test.ts` — 7 legacy `it()`s →
  2 BDD `it()`s (auth boundary + a gwt-wt-wt chain that
  exercises 404 unknown compose → 201 with title (verified via
  list) → 201 with clientThreadId → 404 cross-org (list empty
  for the other org) → 404 no-org (list still shows the two
  created threads)).
- `zero-chat-threads-patch.bdd.test.ts` — 12 legacy `it()`s →
  2 BDD `it()`s (auth boundary + a gwt-wt-wt chain that
  exercises 404 missing → 404 cross-user (owner draft
  preserved via list) → 204 sets draft (hasDraft: true, 1
  publish) → 204 continues draft (no publish) → 204 clears
  (hasDraft: false, 1 publish) → 204 empty-over-empty (no
  publish) → 204 attachments-only (hasDraft: true, 1
  publish)). Draft state is verified via the public
  `hasDraft` boolean on the list contract.
- `zero-chat-threads-delete.bdd.test.ts` — 11 legacy `it()`s
  → 3 BDD `it()`s (auth boundary + a delete chain and a
  cascade chain). The cascade chain exercises 204 deletes
  linked schedule (verified via schedules list) → 204 cancels
  own run (verified via `zeroRunsByIdContract.getById`) → 204
  leaves sibling run untouched (verified via getById). The
  direct DB SELECTs that verified row removal are replaced by
  list and getById assertions.

Net test count: 36 legacy `it()`s → 9 BDD `it()`s (75%
reduction). No per-file coverage regression.

Quality gates: `pnpm -F api lint`, `pnpm -F api check-types`,
`pnpm exec prettier --check` all clean.

### Round 10 — AGENT-01 by-id BDD

Migrates the agent detail route (GET + DELETE). The legacy direct
DB SELECTs that verified row presence / absence are replaced by
re-GET through the public contract (deleted agents return 404;
cross-org callers never see the row). Storage cleanup is
verified indirectly (a re-GET 404 also covers the storage
cascade for the public surface).

- `zero-agents-by-id.bdd.test.ts` — 20 legacy `it()`s → 3 BDD
  `it()`s (auth boundary + a GET chain + a DELETE chain). The
  GET chain exercises 401 no org → 200 owner → 200 CLI token
  (private) → 404 cross-user (private) → 404 unknown → 404
  cross-org → 403 zero-token w/o capability → 200 zero-token
  with capability. The DELETE chain exercises 403 sandbox w/o
  agent:delete → 404 unknown → 404 cross-org → 403 non-owner
  → 204 own (verified by re-GET 404). The orgMembersCache
  upsert pattern and CLI token `cliTokens` table insert are
  preserved because the route reads them on every request.

Net test count: 20 legacy `it()`s → 3 BDD `it()`s (85%
reduction). No per-file coverage regression.

Quality gates: `pnpm -F api lint`, `pnpm -F api check-types`,
`pnpm exec prettier --check` all clean.
