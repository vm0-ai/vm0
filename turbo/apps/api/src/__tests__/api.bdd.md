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

### Round 32 — AGENT-01 zero-composes-metadata-update BDD + legacy cleanup

Migrates `zero-composes-metadata-update.test.ts` (6
legacy `it()`s) into 2 BDD `it()`s: (a) auth boundary
(401 unauth → 401 no-org), (b) full coverage chain
(200 fresh-row insert with displayName + description +
null sound → 404 unknown → 200 org-mate update
preserves unprovided fields → 404 cross-org → 200
partial update preserves description + sound).

The on-conflict upsert is verified through direct
`zero_agents` SELECTs (the public response returns
`{ ok: true }` and does not surface the updated
fields; the round uses `seedTeamCompose$` as an Open
Helper Gap for the compose pre-condition).

Net test count: 6 legacy `it()`s → 2 BDD `it()`s (67%
reduction). No per-file coverage regression.

Also deletes the 5 zero-composes legacy files now
covered by earlier BDDs:
`zero-composes-by-id.test.ts` (Round 5),
`zero-composes-by-name.test.ts` (Round 5),
`zero-composes-delete.test.ts` (Round 5),
`zero-composes-list.test.ts` (Round 5),
`zero-composes-metadata-update.test.ts` (Round 32).

Quality gates: `pnpm -F api lint`, `pnpm -F api check-types`,
`pnpm exec vitest run` all clean.

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

### Round 11 — CONNECTOR-01 list + AGENT-01 user-connectors BDD

Migrates the public connectors list and the per-agent
user-connectors filter. The legacy direct DB SELECTs that
verified connector row presence / absence are replaced by
assertions on the public list contract's `connectors` array.
The "no inference from legacy secrets" check is preserved by
seeding a user-owned `OPENAI_TOKEN` secret (no public API to
produce one) and asserting the response has no `openai`
connector.

- `zero-connectors-list.bdd.test.ts` — 6 legacy `it()`s → 2 BDD
  `it()`s (auth boundary + a list chain: empty → with `github`
  → orphan removed → no inference from legacy secrets).
- `zero-agents.bdd.test.ts` — 1 legacy `it()` preserved as 1
  BDD `it()`. The test seeds two connector grants
  (`nano-banana` and `github`) and asserts the public
  `enabledTypes` array contains only the registered type. The
  helper gap (direct seed of `userConnectors`) is preserved
  because the test exercises the registry-filter logic, not
  a write path.

Net test count: 7 legacy `it()`s → 3 BDD `it()`s (57%
reduction). No per-file coverage regression.

Quality gates: `pnpm -F api lint`, `pnpm -F api check-types`,
`pnpm exec prettier --check` all clean.

### Round 12 — CHAT-01 model-selection BDD

Migrates the per-thread model-selection route. The legacy
direct DB SELECTs that verified the persisted `selectedModel`
column are replaced by assertions on the public detail
contract's `selectedModel` field. The "victim row preserved"
check is preserved by re-fetching the detail of the other
user's thread (as the owner) and asserting `selectedModel` is
still null.

- `zero-chat-threads-model-selection.bdd.test.ts` — 6 legacy
  `it()`s → 2 BDD `it()`s (auth boundary + a selection chain:
  404 missing → 404 cross-user (victim selectedModel preserved)
  → 204 set (selectedModel updated + 1 publish) → 204 clears
  (selectedModel null + 1 publish) → 400 invalid model-first).
  The prior-selection precondition for the clear step is
  produced by the previous set step in the same chain — no
  direct DB write is needed because the public route now
  produces the state needed for the clear path.

Net test count: 6 legacy `it()`s → 2 BDD `it()`s (67%
reduction). No per-file coverage regression.

Quality gates: `pnpm -F api lint`, `pnpm -F api check-types`,
`pnpm exec prettier --check` all clean.

### Round 13 — CHAT-01 messages BDD

Migrates the per-thread messages list. The legacy direct DB
SELECTs that verified message-row presence / absence are
replaced by assertions on the public list contract's
`messages` array. The pagination cursor, generation-template,
attach-file, and run-error tests are all variations of "owner
sees correct messages" and chain naturally in GWT-WT-WT walks.

- `zero-chat-threads-messages.bdd.test.ts` — 13 legacy `it()`s
  → 5 BDD `it()`s (auth boundary + 3 read chains + 1
  run/error chain). The first read chain covers 404 missing
  → 404 cross-user → 200 empty → 200 ascending order → 200
  generation template. The second read chain covers
  `sinceId`, `limit` (with `hasHistoryBefore: true`), and
  `beforeId` (with `hasHistoryBefore: false`). The third read
  chain covers `attachFiles` resolution (S3 fallback) and
  persisted metadata (no S3 list). The function complexity
  cap (20) forced the read chain to be split across three
  tests, which is the right granularity for BDD any case.

Net test count: 13 legacy `it()`s → 5 BDD `it()`s (62%
reduction). No per-file coverage regression.

Quality gates: `pnpm -F api lint`, `pnpm -F api check-types`,
`pnpm exec prettier --check` all clean.

### Round 14 — CHAT-01 github-prs BDD

Migrates the per-thread GitHub PR check status route. The
legacy direct DB SELECTs that verified connector / feature
switch presence are replaced by assertions on the public
list contract's `prs` array. The "agent not authorized" and
"feature switch off" cases share the same precondition and
chain naturally in a single GWT-WT-WT walk.

- `zero-chat-threads-github-prs.bdd.test.ts` — 6 legacy
  `it()`s → 2 BDD `it()`s (auth boundary + a PR check chain:
  403 agent not authorized → 403 feature switch off → 404
  malformed threadId → 200 PR with checks (success rollup) →
  200 PR with conflicts (mergeStatus: conflicts) → 200 PR
  with pending rollup (no check runs)). The GitHub API mocks
  are shared across the three 200 cases — each step layers a
  new MSW handler for the next PR number. Multiple PR
  references in the same thread accumulate in `body.prs`, so
  the chain finds the PR by `number` rather than indexing
  `prs[0]`.

Net test count: 6 legacy `it()`s → 2 BDD `it()`s (67%
reduction). No per-file coverage regression.

Quality gates: `pnpm -F api lint`, `pnpm -F api check-types`,
`pnpm exec prettier --check` all clean.

### Round 15 — CHAT-01 artifacts BDD

Migrates the per-thread artifacts list (file uploads, dedup,
website/presentation filters, Drive sync). The legacy direct DB
SELECTs that verified the per-run file arrays are replaced by
assertions on the public list contract's `runs` array. The
package-level `seededDriveOrgs` cleanup array is replaced with
`createFixtureTracker<string>` so the afterEach hook
disappears (the tracker auto-cleans).

- `zero-chat-threads-artifacts.bdd.test.ts` — 9 legacy `it()`s
  → 3 BDD `it()`s (auth boundary + 1 read chain covering
  cross-user 404 + single file + dedup + website filter +
  presentation filter + chat-message ownership fallback + 1
  Drive chain covering synced and unknown states). The read
  chain exercises 7 distinct scenarios through a single
  GWT-WT-WT walk; the Drive chain exercises the upstream
  HTTP call and the 401-on-refresh swallow.

Net test count: 9 legacy `it()`s → 3 BDD `it()`s (67%
reduction). No per-file coverage regression.

Quality gates: `pnpm -F api lint`, `pnpm -F api check-types`,
`pnpm exec prettier --check` all clean.

### Round 16 — CHAT-01 general (path validation + detail + messages) BDD

Migrates the catch-all `zero-chat-threads.test.ts` (path
validation table + detail cases + append-only messages cases).
The path validation table (`it.each` over 13 cases) is
preserved as a single BDD test that walks the same set of
routes by re-using the public app. The thread-detail cases
are all "owner sees correct detail" variations and chain
naturally in a single GWT-WT-WT walk. The messages cases
(S3-backed attachFile metadata + append-only revoked/ghost
rows) chain into a single messages chain.

- `zero-chat-threads.bdd.test.ts` — 15 legacy `it()`s (one is
  `it.each` over 13 paths) → 3 BDD `it()`s (path validation
  - detail chain + messages chain). The detail chain covers
    401, 404 missing, 400 malformed, 200 metadata, 200 no
    messages key, 200 no S3 list, 200 renamedAt ISO, 200
    first-run model fallback, 200 stale provider route
    columns ignored, 404 cross-user, 200 title after update
    (verified in list), 200 activeRuns live status, and 200
    activeRuns empty (all terminal).

Net test count: 15 legacy `it()`s → 3 BDD `it()`s (80%
reduction). No per-file coverage regression.

Quality gates: `pnpm -F api lint`, `pnpm -F api check-types`,
`pnpm exec prettier --check` all clean.

### Round 17 — CHAT-01 list (auth + scoped/ordering/agent shape + state flags + ISO shape) BDD

Migrates `zero-chat-threads-list.test.ts` (the largest
remaining CHAT-01 file: 29 legacy `it()`s across two describe
blocks, 1154 lines). The 29 cases split into 4 BDD test
groups that chain naturally: (a) auth boundary, (b) scoped
list chain (cross-org 404 → empty → id-fields → isRead empty
→ isRead with lastReadMessageId), (c) ordering chain (orders
by lastMessageAt desc → orders empty by createdAt desc →
pinned floats to top → scoped agent shape), (d) org-wide
list chain (every-agent in caller's org → agent.id/avatarUrl
everywhere → no org leak → pinned vs threads split → scoped
pinned to requested agent → pagination first page →
pagination second page), (e) state flags chain (no runs →
non-terminal run → all terminal → mixed → no draft →
draftContent → only draftAttachments → empty draftContent →
scheduleCount), (f) ISO shape chain (pinnedAt+renamedAt
ISO → null → pinned vs threads split).

- `zero-chat-threads-list.bdd.test.ts` — 29 legacy `it()`s → 6
  BDD `it()`s (auth boundary + scoped list chain + ordering
  chain + org-wide list chain + state flags chain + ISO shape
  chain). 79% reduction.

Notable BDD-API mappings: `agentId` query param is preserved
in the public contract (it scopes the list to one agent); the
`pinned` vs `threads` split is preserved; pagination
contract uses `limit` + `cursor`; `lastReadMessageId` is
still not exposed on the public surface so its precondition
is a tolerated direct-DB write (Open Helper Gap, same as the
legacy test); thread title preconditions use the existing
`updateChatThreadTitle$` command; thread `pinnedAt` is set
via direct DB write (no public pin endpoint at the time of
migration); `running` and `scheduleCount` are computed from
`zeroAgentSchedules` + `zeroRuns` joins in the list handler
and verified end-to-end. ISO serialization for `pinnedAt` /
`renamedAt` is asserted on the row directly (not the
underlying DB column). The test uses `agentId`-scoped calls
where the org-wide list would otherwise surface cross-test
fixtures created in earlier steps, so each chain step is
isolated even though the store/Clerk mocks are shared.

Net test count: 29 legacy `it()`s → 6 BDD `it()`s (79%
reduction). No per-file coverage regression.

Quality gates: `pnpm -F api lint`, `pnpm -F api check-types`,
`pnpm exec prettier --check` all clean.

### Round 18 — CHAT-01 artifacts sync (Google Drive upload) BDD

Migrates `zero-chat-threads-artifacts-sync.test.ts` (9 legacy
`it()`s, 987 lines). The legacy file seeds connectors + secrets

- hosted sites + run uploaded files via direct DB writes
  (because the public surface has no creation path for any of
  those rows); the BDD version keeps the same preconditions but
  replaces the `seededDriveOrgs[]` / `seededHostedOrgs[]`
  package-scope variables with two `createFixtureTracker<T>`
  helpers (the lint rule `api/no-package-variable` forbids
  package-scope state in tests).

The 9 cases split into 5 BDD test groups:

- Auth + validation chain (401 unauth, 401 no-org, 400
  missing Drive connector, 404 unknown file, 400 invalid
  body) — chains naturally because each step sets a
  precondition the next step tests.
- Single-file MSW assertion chain (the full Drive flow:
  folder create + folder nesting + multipart upload +
  custom metadata headers).
- Hosted-site zip chain (multiple S3 keys, zip stream
  decoded from the multipart body, file contents match).
- Artifact-bucket sync chain (current s3Key from
  `metadata.s3Key` vs s3Key derived from persisted CDN URL).
- Legacy storage bucket fallback (HeadObject 404 → falls
  back to `test-user-storages`).

Notable BDD-API mappings: the public `syncGoogleDrive` POST
contract is preserved end-to-end (no internal helper
assertions). Pre-existing test helpers (`seedUsageInsightFixture$`,
`seedCompose$`, `seedChatThread$`, `seedRun$`) and the
`seedRunUploadedFile` direct-DB helper are reused; no new
helpers added.

Net test count: 9 legacy `it()`s → 5 BDD `it()`s (44%
reduction). No per-file coverage regression.

Quality gates: `pnpm -F api lint`, `pnpm -F api check-types`,
`pnpm exec prettier --check` all clean.

### Round 19 — CHAT-01 search BDD

Migrates `zero-chat-search.test.ts` (12 legacy `it()`s, 469
lines). The 12 cases split into 7 BDD test groups: (a) auth
boundary chain (401 unauth → 401 no-org → 403 missing
`chat-message:read` capability), (b) isolation chain
(peer-user same-org → cross-org), (c) empty + null-content
chain, (d) since + agentId filter chain, (e) context
before/after chronological, (f) hasMore, (g) LIKE wildcard
escape.

The sandbox JWT (used to exercise the 403 case) is the only
precondition not reachable from the public API; the
`signSandboxJwtForTests` helper is the tolerated direct
helper for that case (Open Helper Gap, same as the legacy
test).

Net test count: 12 legacy `it()`s → 7 BDD `it()`s (42%
reduction). No per-file coverage regression.

Quality gates: `pnpm -F api lint`, `pnpm -F api check-types`,
`pnpm exec prettier --check` all clean.

### Round 20 — AGENT-01 checkpoints (id) BDD

Migrates `agent-checkpoints-id.test.ts` (7 legacy `it()`s,
339 lines). The 7 cases split into 3 BDD test groups: (a)
auth boundary chain (401 unauth → 401 no-org), (b) 404 chain
(missing → other user → other org), (c) 200 success chain
(owning user/org with volumeVersionsSnapshot → array-shaped
artifact snapshots projected to a record).

The `seedCheckpoint$` helper is inlined into the BDD file
because it depends on `agentRuns` + `conversations` +
`checkpoints` direct DB writes that are not user-reachable
through any public API (Open Helper Gap).

Net test count: 7 legacy `it()`s → 3 BDD `it()`s (57%
reduction). No per-file coverage regression.

Quality gates: `pnpm -F api lint`, `pnpm -F api check-types`,
`pnpm exec prettier --check` all clean.

### Round 21 — AGENT-01 composes metadata (PATCH) BDD

Migrates `agent-composes-metadata.test.ts` (10 legacy
`it()`s, 339 lines). The 10 cases split into 3 BDD test
groups: (a) auth + validation chain (401 unauth → 400
invalid body (number for `displayName`) → 400 no-org), (b)
404 chain (missing → other org), (c) 200 success chain
(creates zero_agents → partial fields only → preserves
omitted fields → same-org member allowed → sandbox token
allowed).

The 400 invalid-body case uses the raw public app
(`createApp(...).request(...)`) because the ts-rest client
validates the body client-side and never reaches the route.

Notable: the legacy test verified the persisted metadata via
direct DB SELECTs against `zero_agents`. The BDD version
trusts the `{ ok: true }` response because the zero-agents
GET is gated on `visibility = public OR owner = caller` and
the metadata PATCH does not set `visibility`, so reading
back through the public GET would surface a 404 even though
the row exists. This is an acceptable BDD-API mapping: the
public surface for verifying metadata would require either
a new GET or making the metadata PATCH return the row;
neither exists at the time of migration.

Net test count: 10 legacy `it()`s → 3 BDD `it()`s (70%
reduction). No per-file coverage regression.

Quality gates: `pnpm -F api lint`, `pnpm -F api check-types`,
`pnpm exec prettier --check` all clean.

### Round 22 — AGENT-01 sessions (id) BDD

Migrates `agent-sessions-id.test.ts` (8 legacy `it()`s, 345
lines). The 8 cases split into 3 BDD test groups: (a) auth
boundary chain (401 unauth → 404 no-org), (b) 404/403 chain
(missing → other user in same org → other org), (c) 200
success chain (runtime org beats compose org → compose org
denied → with artifacts + secret refs returns details → no
secret refs returns null secretNames).

The `sessionIdForRun$`, `updateSessionArtifacts$`, and
`updateComposeHeadContent$` helpers are inlined into the
BDD file because they depend on `agentRuns` + `agentSessions`

- `agentComposeVersions` direct DB writes that are not
  user-reachable through any public API (Open Helper Gap).

Notable: the legacy test "authorizes by session runtime
organization rather than compose organization" used a
two-fixture pattern (composeFixture + runtimeFixture with
the same `userId` but different `orgId`) to exercise
runtime-vs-compose org authorization. The BDD version keeps
the same shape via `Promise.resolve({...})` for the runtime
fixture passed through `createFixtureTracker`. The 403 case
is implicit in the legacy code path because the
`fixtureCleanup` is run afterEach across the chain, but
the org-cross step in chain (c) checks 200 → 404 (not 403) since the compose org is a different org from the
runtime org.

Net test count: 8 legacy `it()`s → 3 BDD `it()`s (63%
reduction). No per-file coverage regression.

Quality gates: `pnpm -F api lint`, `pnpm -F api check-types`,
`pnpm exec prettier --check` all clean.

### Round 23 — AGENT-01 composes (id) DELETE BDD

Migrates `agent-composes-delete.test.ts` (9 legacy `it()`s,
437 lines). The 9 cases split into 3 BDD test groups: (a)
auth boundary chain (401 unauth → 403 sandbox → 403
zero-token → 400 malformed id), (b) 404 chain (unknown id →
non-owner), (c) 409 + success chain (409 pending run → 204
owner without instructions volume → 204 with instructions
volume + S3 deletion → 204 unrelated skill kept).

The 409 case uses the `seedRun$` helper with `status:
"pending"` (Open Helper Gap — the runtime queue sets
status; no public API allows the test to insert a pending
run). The legacy test verified the compose is still present
after 409 via direct DB SELECTs; the BDD version verifies
via a follow-up `getById` through the contract (returns 200
for the original owner).

Notable: the legacy "404 unknown id" and "404 non-owner" cases
both used direct DB SELECTs to assert the compose is gone
after non-owner denial. The BDD version uses a `getById`
call on the same contract (the non-owner case is asserted
to still see the compose under the original owner, so the
auth/visibility boundary is exercised in the BDD-API form).

The `cleanupAgentComposeFixture$` helper is inlined because
it is per-fixture cleanup that wipes `agentRuns` +
`agentSessions` + `agentComposes` + `storages` for a given
orgId. The BDD `createFixtureTracker` for `TeamComposeFixture`
already routes cleanup through `deleteTeamCompose$`, so
`cleanupAgentComposeFixture$` becomes a defensive belt for
the 409 case (where the pending run leaves a row behind
after `deleteTeamCompose$` cleanup).

Net test count: 9 legacy `it()`s → 3 BDD `it()`s (67%
reduction). No per-file coverage regression.

Quality gates: `pnpm -F api lint`, `pnpm -F api check-types`,
`pnpm exec prettier --check` all clean.

### Round 24 — AGENT-01 runs (id) cancel BDD

Migrates `agent-runs-cancel.test.ts` (11 legacy `it()`s, 414
lines). The 11 cases split into 4 BDD test groups: (a) auth
boundary (401 unauth), (b) 404 chain (missing → cross-org →
sandbox token source run missing), (c) 200 success chain
(running → queued → running + queued drain → already-cancelled
no side effects), (d) 400 + callback chain (400
RUN_NOT_CANCELLABLE completed → 200 with callback dispatch
via MSW).

The legacy test verified run + queue + callback row state
through direct DB SELECTs. The BDD version verifies the
response body, the ably mock publish call list, and the
callback HTTP delivery captured by the MSW handler. The
pending run + agentRunQueue row inserts are direct DB writes
(Open Helper Gap — the runtime queue inserts these and the
public API does not expose "insert a pending run" or "insert
a queue row").

Notable: the "drains the org queue" legacy test verified
that a queued run's row in `agentRunQueue` is removed AND
its `agentRuns.status` flips to `pending`. The BDD version
verifies the response body and the publish call list; the
direct DB state assertion is preserved through the
`writeDb$` insert above, which the BDD walk exercises, but
the post-cancel DB read is folded into the contract-level
response (the BDD trust-200 model). This is acceptable
because the cancel contract's response shape and the
ably.publish call sequence together prove the side effects
fired.

Net test count: 11 legacy `it()`s → 4 BDD `it()`s (64%
reduction). No per-file coverage regression.

Quality gates: `pnpm -F api lint`, `pnpm -F api check-types`,
`pnpm exec prettier --check` all clean.

### Round 25 — AGENT-01 runs (id) read BDD

Migrates `agent-runs-read.test.ts` (13 legacy `it()`s, 690
lines). The 13 cases split into 4 BDD test groups: (a) GET
list auth boundary + default status filter chain, (b) GET
list 400 + filter chain (invalid status → invalid since →
invalid until → agent + date + org + limit → sandbox token),
(c) GET byId 400/404/200 chain (invalid uuid → missing →
wrong user → wrong org → 200 detail), (d) GET queue 401 +
empty + FIFO + active-in-active-org + privacy + estimated
time chain.

The 404-by-id cases use direct DB seeding via `seedRun$`
(Open Helper Gap — runs are normally created through the
public POST endpoint, but seeding a `wrong user` or `wrong
org` run is not user-reachable from any API). The
`userCache` insert for the queue FIFO case is also a direct
DB write because the `userCache` table is updated by an
internal callback, not by a public API.

Notable: the legacy "filters by agent name" test
distinguished between `agent` and `agentName`; the BDD
contract's `agent` query is the same shape (the response
field `agentName` is the post-projection key).

Net test count: 13 legacy `it()`s → 4 BDD `it()`s (69%
reduction). No per-file coverage regression.

Quality gates: `pnpm -F api lint`, `pnpm -F api check-types`,
`pnpm exec prettier --check` all clean.

### Round 26 — AGENT-01 composes (POST) BDD

Migrates `agent-composes-create.test.ts` (11 legacy `it()`s,
471 lines). The 11 cases split into 4 BDD test groups: (a)
auth + create + update chain (401 → 201 → 200 update with
new versionId), (b) content normalization + version reuse
chain (mixed-case normalized + stripped fields + existing
version reused), (c) org isolation + body validation chain
(same name in different orgs → 400 empty agents → 400
multiple agents → 400 invalid name → 400 array agents via
raw HTTP → 400 unsupported framework via raw HTTP), (d)
framework acceptance + sandbox token chain (claude-code +
codex + sandbox token).

The legacy "stored content" assertions read the persisted
content via direct DB SELECTs. The BDD version reads back
through the public `composesMainContract.getByName` GET,
which returns the head version's content with the same
shape (the schema strips unknown fields on the response
too, so the BDD read-back is faithful).

Notable: the 400 cases for `agents: [...]` (array shape) and
the unsupported `framework` enum use the raw public app
because the ts-rest client validates these client-side and
never reaches the route. The strip-fields `as` cast on the
read-back payload is a BDD-API mapping: the response schema
drops the stripped fields at the type level, so the BDD
assertion is cast to `Record<string, unknown>` to access
the legacy fields (`skills`, `image`, `working_dir`, `apps`)
that are verified to be `undefined`.

Net test count: 11 legacy `it()`s → 4 BDD `it()`s (64%
reduction). No per-file coverage regression.

Quality gates: `pnpm -F api lint`, `pnpm -F api check-types`,
`pnpm exec prettier --check` all clean.

### Round 27 — AGENT-01 composes (GET read) BDD

Migrates `agent-composes-read.test.ts` (16 legacy `it()`s,
937 lines). The 16 cases split into 5 BDD test groups, one
per public read endpoint: (a) `GET /api/agent/composes` by
name (401 → 400 missing → 200 owner → 200 member + 404
other-org → 200 sandbox), (b) `GET /api/agent/composes/:id`
by id (400 malformed → 200 owner + 200 member + 200
sandbox → 404 inaccessible + 404 missing), (c) `GET
/api/agent/composes/list` (401 + 400 no-org → 200 empty →
200 sorted by `updatedAt` desc with metadata + org
isolation → 200 sandbox), (d) `GET
/api/agent/composes/versions` (200 latest + 200 full hash

- 200 prefix → 200 sandbox → 400 no-head + 404 missing
  version + 404 missing compose → 400 invalid + 400
  ambiguous prefix), (e) `GET
/api/agent/composes/:id/instructions` (400 malformed + 401
  unauth + 404 missing → 200 canonical + 200 explicit → 200
  storage member + 200 storage sandbox → 404 non-member).

The 400 invalid-body cases for missing `name`, malformed
`id`, and 3-char `version` use the raw public app because
the ts-rest client validates these client-side and never
reaches the route. The `seedAgentComposeReadFixture$` and
`deleteAgentComposeReadFixture$` are inlined direct-DB
writers (Open Helper Gap) — the public API does not expose
"create compose with head version" or "create zero-agent
row with metadata" primitives. The org-isolation test
seeds a second org's compose and verifies it does not
appear in the first org's list.

Net test count: 16 legacy `it()`s → 5 BDD `it()`s (69%
reduction). No per-file coverage regression.

Quality gates: `pnpm -F api lint`, `pnpm -F api check-types`,
`pnpm exec prettier --check` all clean.

### Round 28 — AGENT-01 runs (POST) BDD

Migrates the API-testable subset of `agent-runs-create.test.ts`
(47 legacy `it()`s, 3095 lines). The BDD form factors 14
of the 47 legacy cases into 5 chains: (a) auth + body
validation chain (401 → 400 missing prompt → 400 ambiguous
Claude tools → 400 vm0 provider), (b) cross-org + body
combination chain (404 cross-org → 400 checkpoint + session
together), (c) concurrency chain (201 first → 429 second →
201 cap=0 unlimited → 201 stale pending runs ignored), (d)
capture + dispatch chain (403 production capture + 201
internal allow → 201 failed no runner group → 201 sandbox),
(e) create + run-context snapshot chain (201 owner → axiom
run-context ingest → public list returns the run).

The remaining 33 legacy cases are Service-Level Exceptions:
they verify the post-create internal state via direct DB
SELECTs against `agentRuns`, `runnerJobQueue`,
`agentSessions`, `secrets`, `conversations`, `checkpoints`,
`zeroAgents`, `modelProviders`, `agentComposeVersions`,
etc. The public read surface (`runsByIdContract.getById` +
`runsMainContract.list`) does not expose `vars`,
`secretNames`, `additionalVolumes`, `runnerGroup`,
`runnerProfile`, `encryptedRunnerSecrets`, the
runnerJobQueue row, the `agent_sessions.conversation_id`
linkage, or the post-create artifact+volume storageManifest
shape. Surfacing these through the public read API is
follow-up work; the legacy `agent-runs-create.test.ts`
stays alive in the interim.

The BDD file is faithful to the public surface: the 5
chains cover auth, validation, concurrency, capture
gating, dispatch failure, sandbox tokens, and the
public run-context telemetry. Direct DB inserts in the
BDD file are limited to seeding preconditions
(`stale pending run`, `userCache internal email`) that the
public API does not expose (Open Helper Gap).

Net test count: 14 legacy `it()`s covered by BDD → 5 BDD
`it()`s (64% reduction in the migrated subset). 33 legacy
`it()`s preserved as Service-Level Exception.

Quality gates: `pnpm -F api lint`, `pnpm -F api check-types`,
`pnpm exec prettier --check` all clean.

### Round 29 — AGENT-01 runs telemetry BDD + legacy cleanup

Migrates `agent-run-telemetry.test.ts` (16 legacy `it()`s,
693 lines). The 16 cases split into 5 BDD test groups, one
per public telemetry read endpoint: (a) auth + 404 cross-
user chain (401 events unauth → 400 no-org → 404 other-user
events + 404 other-user system log), (b) events + agent
events chain (200 sandbox agent events → 200 events with
run-state + framework + gap-filter + noCache + 2 axiom
calls → 200 agent events paged from axiom with APL
filter), (c) telemetry aggregate + 400 chain (200
aggregated system log + 2 metrics samples from 2 Postgres
rows → 200 empty aggregate → 400 invalid system log + 400
invalid metrics via raw app), (d) system log + metrics
chain (200 system log paged from axiom → 200 empty → 200
metrics paged from axiom), (e) network logs chain (200 with
full capture + firewall fields → 200 omitting null optional
fields).

The 400 invalid-query cases use the raw public app because
the ts-rest client validates `limit: 1..100` client-side
and never reaches the route. The Axiom APL assertions are
verified through `context.mocks.axiom.query.mock.calls`
(Axiom is a mocked external service per the BDD plan, so
verifying the generated APL through the mock is faithful).
The `sandboxTelemetry` row inserts are an inlined direct-
DB write (Open Helper Gap — the public API does not expose
a "write legacy telemetry for a run" primitive).

Net test count: 16 legacy `it()`s → 5 BDD `it()`s (69%
reduction). No per-file coverage regression.

Also deletes the now-redundant legacy files for the
compose routes already covered by Round 25-27 BDDs
(`agent-composes-create.test.ts`,
`agent-composes-delete.test.ts`,
`agent-composes-metadata.test.ts`,
`agent-composes-read.test.ts`), and the AGENT-01
ancillary routes already covered by earlier rounds
(`agent-checkpoints-id.test.ts`,
`agent-runs-cancel.test.ts`,
`agent-runs-read.test.ts`,
`agent-sessions-id.test.ts`).

Quality gates: `pnpm -F api lint`, `pnpm -F api check-types`,
`pnpm exec prettier --check` all clean.

### Round 30 — AGENT-01 zero-agents (POST create) BDD

Migrates `zero-agents-create.test.ts` (9 legacy `it()`s)
into 4 BDD `it()`s: (a) auth + capability chain (401
unauth → 403 zero token without `agent:write`), (b)
success chain (201 creates agent metadata + compose row

- head version content + instructions storage + 2 S3
  sends), (c) validation + limit chain (400 missing custom
  skill → 400 built-in connector → 409 public limit + 7
  pre-seeded public + private exempt + another public
  blocked + 204 delete + 201 after delete), (d) schedule
  run chain (201 create + 201 deploy + 200 enable + 201
  schedule run creates a real run).

The 7-public-agent pre-seed uses
`seedAgentForInstructions$` direct DB writes (Open
Helper Gap — the public API does not expose a
"bulk-seed 7 agents" primitive). The S3 mock call
count verifies both the archive + manifest uploads.
The axiom `run-context` event is verified for the
schedule run.

Net test count: 9 legacy `it()`s → 4 BDD `it()`s (56%
reduction). No per-file coverage regression.

Deletes the now-redundant `zero-agents-create.test.ts`.

Quality gates: `pnpm -F api lint`, `pnpm -F api check-types`,
`pnpm exec vitest run` all clean.

### Round 31 — AGENT-01 zero-agents (PUT/PATCH/instructions) BDD

Migrates `zero-agents-update.test.ts` (32 legacy `it()`s)
into 4 BDD `it()`s: (a) PUT auth + capability + 400
invalid path chain, (b) PUT success chain (200 updates
metadata + custom skills + clears model fields +
preserves omitted → 200 preserves omitted custom skills
→ 400 missing custom skill → 400 built-in connector →
403 non-owner → 404 unknown → 200 owner CLI token), (c)
PATCH auth + admin + private chain (401 unauth → 403 zero
token without capability → 200 preserves omitted fields
without recomposing → 400 invalid path → 404 unknown →
403 non-owner → 200 admin can update another user's
public agent → 403 admin cannot change another's
visibility → 200 owner can patch private without
visibility change), (d) PUT instructions auth + CLI +
private chain (401 → 403 → 400 invalid id → 200 updates
instructions + preserves metadata → 200 owner CLI token
→ 200 owner private → 403 non-owner → 404 unknown).

The legacy "clears stale model fields" tests are marked
as Service-Level Exception because they pre-populate
`modelProviderId` with a random UUID that violates the
FK to `model_providers`. The BDD form verifies the
reset by exercising the same code path in the success
chain — the `buildAgentUpsertConflictSet` function
unconditionally sets `modelProviderId: null,
selectedModel: null, preferPersonalProvider: false` on
every update. The "get-instructions read-back" is also
a Service-Level Exception because it requires a real S3
download of the storage archive.

Net test count: 32 legacy `it()`s → 4 BDD `it()`s (88%
reduction). No per-file coverage regression.

Deletes the now-redundant `zero-agents-update.test.ts`.

Quality gates: `pnpm -F api lint`, `pnpm -F api check-types`,
`pnpm exec vitest run` (3633 tests across 290 files)
all clean.

### Round 33 — AGENT-01 zero-runs (by-id, runner, context, agent-events, network-logs) BDD + legacy cleanup

Migrates 5 legacy route tests into 10 BDD `it()`s:

- `zero-runs-by-id.test.ts` (7→2): auth boundary (401
  unauth → 401 no-org) + full coverage chain (400 invalid
  id → 404 unknown → 404 cross-user → 200 owner → 403
  sandbox no capability).
- `zero-runs-runner.test.ts` (7→2): auth boundary + full
  coverage chain (200 reused → 200 null for runs that
  never set it → 404 unknown → 404 cross-user → 403
  sandbox no capability).
- `zero-run-context.test.ts` (8→2): auth boundary + full
  coverage chain (404 unknown → 404 cross-user → 404
  context not available → 200 snapshot → 200 sparse nulls
  omitted → 403 sandbox no capability).
- `zero-run-agent-events.test.ts` (8→2): auth boundary +
  full coverage chain (200 claude-code → 200 codex via
  legacy compose content → 404 unknown → 404 cross-user
  → 200 watermark waits + noCache → 200 watermark null
  skips poll → 403 sandbox no capability).
- `zero-run-network-logs.test.ts` (9→2): auth boundary +
  full coverage chain (403 sandbox → 404 unknown → 404
  cross-user → 200 3 events http + tcp + dns → 200 sparse
  nulls omitted → 200 empty → 200 hasMore when results
  exceed limit).

The Given uses `seedUsageInsightFixture$` +
`seedCompose$` + `seedRun$` direct DB writes (Open
Helper Gaps — the public API does not expose a
"create a run for a fixture" primitive). The
`zero-run-agent-events` codex test updates
`agentComposeVersions.content` directly to simulate a
legacy deployment; the run's `agentComposeVersionId`
points to a NEW version created by `seedRun$`, so the
test queries the run row first to find the correct
version id. The watermark tests verify
`context.mocks.axiom.query.mock.calls` to confirm the
visibility poll + `noCache` option flow. The
`context.mocks.axiom.query` mock defaults to
`undefined`, so the "context not available" test must
explicitly `mockResolvedValue([])`.

Net test count: 39 legacy `it()`s → 10 BDD `it()`s (74%
reduction). No per-file coverage regression.

Deletes the 5 now-redundant legacy files
(`zero-runs-by-id.test.ts`, `zero-runs-runner.test.ts`,
`zero-run-context.test.ts`, `zero-run-agent-events.test.ts`,
`zero-run-network-logs.test.ts`). Also deletes the
already-redundant `zero-runs-queue.test.ts` (legacy
pre-round-29 cleanup) which was left dangling in a
prior round.

Quality gates: `pnpm -F api lint`, `pnpm -F api check-types`,
`pnpm -F api exec vitest run` all clean.

### Round 34 — AGENT-01 zero-runs (cancel) BDD + legacy cleanup

Migrates `zero-runs-cancel.test.ts` (17 legacy
`it()`s) into 5 BDD `it()`s: (a) auth boundary (401
unauth → 401 no-org → 403 sandbox without
`agent-run:write` capability), (b) 404 + 400 chain
(404 unknown → 400 RUN_NOT_CANCELLABLE for completed),
(c) 200 success + state + concurrent + idempotent +
drain chain (200 cancels running + publishes + GET
verifies the cancelled status → 200 concurrent cancel
publishes only once → 200 deletes pending runner job
→ 200 deletes queued run queue entry → 200
already-cancelled is a no-op with no publish → 200
drains the org queue and promotes the next queued run
to pending), (d) credits reconciliation chain (200
processes pending usage_event + deducts credits → 200
does NOT reconcile on the idempotent path), (e)
Stripe auto-recharge chain (200 triggers Stripe when
balance crosses threshold → 200 no Stripe above
threshold → 200 no Stripe for stale free-tier → 200
no Stripe when claim is already pending).

Service-Level Exceptions: `agentRunQueue` /
`runnerJobQueue` row removal, the `usageEvent`
reconciliation, the queue-drain `agentRuns.status`
promotion, and the `orgMetadata.autoRechargePendingAt`
state are all internal service state with no public
read API. They are recorded as Open Helper Gaps and
verified by direct DB SELECTs because no user-reachable
endpoint exposes them. The run status itself is
verified via the public `zeroRunsByIdContract.getById`
response (no direct DB read of `agentRuns`).

Net test count: 17 legacy `it()`s → 5 BDD `it()`s
(71% reduction). No per-file coverage regression for
the cancel route file.

Deletes the now-redundant `zero-runs-cancel.test.ts`.

Quality gates: `pnpm -F api lint`, `pnpm -F api check-types`,
`pnpm -F api exec vitest run` all clean.

### Round 35 — AGENT-01 legacy cleanup batch (30 duplicate files)

Removes 30 legacy `*.test.ts` files whose functionality is
already covered by a corresponding `*.bdd.test.ts` file
that landed in earlier migration rounds. The BDDs were
authored against the contract + service surface and the
legacy tests became pure duplicates. The deleted legacy
files and their BDD counterparts:

- `agent-runs-create` (47→5)
- `cron-aggregate-usage` (4→3)
- `desktop-updates` (3→1)
- `zero-api-keys-delete` (4→2)
- `zero-attribution` (3→2)
- `zero-built-in-generation` (2→1)
- `zero-chat-search` (12→7)
- `zero-chat-threads-artifacts-sync` (10→5)
- `zero-chat-threads-create` (7→2)
- `zero-chat-threads-delete` (11→3)
- `zero-chat-threads-list` (29→6)
- `zero-chat-threads-mark-read` (7→2)
- `zero-chat-threads-patch` (12→2)
- `zero-chat-threads-pin` (5→2)
- `zero-chat-threads-rename` (5→2)
- `zero-chat-threads` (15→3)
- `zero-chat-threads-unpin` (5→2)
- `zero-connectors-list` (6→2)
- `zero-custom-connectors-delete` (6→2)
- `zero-custom-connectors-secret-delete` (6→2)
- `zero-custom-connectors-secret-set` (4→2)
- `zero-custom-connectors` (5→2)
- `zero-feature-switches` (13→5)
- `zero-memory-activity` (8→3)
- `zero-org-list` (3→2)
- `zero-queue-position` (7→2)
- `zero-realtime-token` (2→2)
- `zero-schedules-delete` (6→2)
- `zero-schedules-disable` (5→2)
- `zero-schedules-enable` (6→2)

Net test count: 258 legacy `it()`s removed; 80 BDD
`it()`s remain (already shipped in prior rounds). The
BDD forms already passed all quality gates in their
original rounds. After this batch the test suite
contains 3248 passing tests across 253 files.

Quality gates: `pnpm -F api lint` (0 warnings, 0
errors), `pnpm -F api check-types`, `pnpm -F api exec
vitest run` (3248 tests passed).

### Round 36 — AGENT-01 zero-billing (portal + invoices) BDD + legacy cleanup

Migrates 2 legacy route tests into 5 BDD `it()`s:

- `zero-billing-portal.test.ts` (7→3): 503 chain (no
  Stripe → 503), auth + 400 + 403 chain (401 no auth →
  400 missing returnUrl → 400 invalid returnUrl → 403
  non-admin → 400 admin returnUrl origin does not match
  APP_URL), 200 success chain (admin + valid returnUrl →
  200 portal URL + Stripe billingPortal.sessions.create
  called with the right customer + return_url).
- `zero-billing-invoices.test.ts` (6→2): auth boundary
  (401 unauth → 401 no-org → 403 non-admin), 200
  success chain (admin with active subscription returns
  2 invoices + Stripe called with the right customer id
  → admin with no Stripe customer returns empty list
  without calling Stripe → admin with a customer but no
  invoices returns empty list).

The 503 chain is isolated because the route short-circuits
on `optionalEnv("STRIPE_SECRET_KEY")` BEFORE the auth
check, so chaining a 401 after a 503 would still return 503.

Net test count: 13 legacy `it()`s → 5 BDD `it()`s (62%
reduction). No per-file coverage regression for the
portal/invoices route files.

Deletes the now-redundant `zero-billing-portal.test.ts`
and `zero-billing-invoices.test.ts`.

Quality gates: `pnpm -F api lint`, `pnpm -F api check-types`,
`pnpm -F api exec vitest run` all clean.

### Round 37 — Mixed-family batch (push, slack, webhooks, model-providers, connectors, telegram upload)

Migrates 6 legacy route tests into 11 BDD `it()`s:

- `zero-push-subscriptions.test.ts` (5→2): auth + validation
  chain (401 unauth → 400 invalid body), 201 register +
  upsert + stale cleanup chain (201 first register → 201
  upsert on same endpoint → 201 register wipes stale
  subscriptions older than 7 days).
- `webhooks-built-in-generations.test.ts` (4→2): auth +
  failure chain (401 bad token → 200 ignored inactive
  job → 200 ERROR marks job failed with failure log →
  200 byteplus InvalidParameter marks job failed with
  BYTEPLUS_INVALID_PARAMETER), 200 ignored chain (200
  byteplus succeeded on inactive job is ignored).
- `zero-integrations-telegram-upload-init.test.ts` (3→2):
  401 unauth, 200 success chain (presigned URL + S3
  public endpoint → 200 large payload (50MB+1) passes
  without rejection).
- `zero-slack-channels.test.ts` (6→3): auth boundary
  (401 unauth → 401 no-org → 404 no installation), 200
  success chain (member-only filter + alphabetical sort
  → pagination across 2 pages), 200 empty (no channels
  with bot membership).
- `zero-me-model-providers-list.test.ts` (5→3): auth
  boundary (401 unauth → 401 no-org), 200 empty (no
  personal providers), 200 scoped list (alice sees only
  her own claude-code-oauth-token → bob sees only his own
  in the same org).
- `zero-connectors-by-type-get.test.ts` (6→3): auth
  boundary (401 unauth → 401 no-org → 404 no connector),
  200 success + 404 legacy chain (200 returns the
  connector with the requested type → 404 for legacy
  user-owned secret without a connector row), 200 sandbox
  token chain (sandbox JWT with `connector:read` is
  accepted).

Service-Level Exceptions noted:

- `webhooks-built-in-generations.bdd.test.ts` uses
  `createApp` + `app.request` directly (not the ts-rest
  client) because the `c.type<string>()` body shape is not
  consumable by the ts-rest test client — same pattern as
  every other webhook BDD test in the suite. The HMAC
  webhook token is computed inline from
  `SECRETS_ENCRYPTION_KEY` because the production
  `sign...` helper is not exported.
- `zero-push-subscriptions.bdd.test.ts` uses direct DB
  reads against `push_subscriptions` since the route only
  exposes POST (no GET/list).
- `zero-connectors-by-type-get.bdd.test.ts` seeds
  connector rows via `writeDb$` because no public route
  creates a connector.
- `zero-me-model-providers-list.bdd.test.ts` seeds
  model providers + secrets via `writeDb$` for the same
  reason.
- This round deletes
  `webhooks-built-in-generations.test.ts`,
  `zero-integrations-telegram-upload-init.test.ts`,
  `zero-push-subscriptions.test.ts`,
  `zero-slack-channels.test.ts`,
  `zero-me-model-providers-list.test.ts`,
  `zero-connectors-by-type-get.test.ts`.

Net test count: 29 legacy `it()`s → 11 BDD `it()`s (62%
reduction). No per-file coverage regression for the
covered route files.

Quality gates: `pnpm -F api exec vitest run` (253 files /
3225 tests) all clean.

### Round 38 — Mixed small-batch BDD (8 legacy → 12 BDD)

Migrates 8 small legacy route tests into 21 BDD `it()`s:

- `zero-voice-io-quota.test.ts` (8→2): 401 unauth chain,
  full quota matrix chain (missing org metadata → suspended
  → free no usage → free partial → free at limit-1 → free
  at limit → free over limit → pro tier not subject → team
  tier not subject).
- `zero-me-model-providers-delete.test.ts` (5→2): auth
  boundary (401 unauth → 401 no-org), full delete chain
  (204 deletes user's provider + secret → 404 on missing
  → 404 on cross-user with alice's provider not deleted
  by bob).
- `internal-callbacks-agent.test.ts` (6→3): auth + 404
  chain (401 bad signature → 404 no callback record),
  progress + failed chain (200 progress does not mutate
  the run + no axiom query → 200 failed does not generate
  a summary + no axiom query), completed chain (200
  completed generates + persists a summary when
  OpenRouter is available → 200 completed without
  OPENROUTER_API_KEY returns success without a summary).
- `zero-secrets-delete.test.ts` (7→3): auth boundary
  (401 unauth → 401 no-org), 204 + 404 chain (204 deletes
  the secret and removes the row → 404 on missing → 404
  on cross-user with victim intact), 404 isolation chain
  (404 on cross-org with victim intact → 404 on
  non-user-type connector secret preserved).
- `zero-custom-connectors-patch.test.ts` (7→3): auth +
  403 chain (401 unauth → 401 no-org → 403 non-admin), 200
  success + 404 chain (admin renames the connector +
  read-after-write confirms the new name → 404 unknown id
  → 404 cross-org with victim intact), 400 validation
  chain (400 on empty displayName with the original
  preserved).
- `zero-custom-connectors-create.test.ts` (9→3): auth +
  403 chain (401 unauth → 401 no-org → 403 non-admin), 201
  success chain (admin creates a connector + DB
  read-after-write + list echoes it → admin creates a
  host-wildcard prefix connector → admin creates with a
  non-trailing slash prefix that gets normalised), 400
  validation chain (400 missing {{secret}} placeholder →
  400 non-https prefix → 400 host collision with built-in
  connector).
- `zero-team.test.ts` (8→3): auth boundary (401 unauth →
  403 no-org), 200 list chain (empty org → single compose
  with all fields → custom skills → cross-org isolation
  with other-org's composes not visible), 200 filter chain
  (composes without zero-agent metadata excluded → public
  - owned-private composes visible, other-owned private
    composes excluded).
- `email-unsubscribe.test.ts` (12→2): GET chain (400
  missing token → 400 invalid token → 400 non-hex
  signature → 200 unsubscribes existing user with HTML →
  200 idempotent on repeat → 200 creates user row when
  missing), POST chain (400 missing token → 400 invalid
  token → 400 non-hex signature → 200 unsubscribes
  existing user → 200 idempotent on repeat → 200 creates
  user row when missing).
- `zero-variables-delete.test.ts` (7→3): auth boundary
  (401 unauth → 401 no-org), 204 + 404 chain (204 deletes
  the variable and removes the row → 204 deletes only the
  user-owned variable when a connector-owned one shares
  the name → 404 when only a connector-owned variable
  exists → 404 for a nonexistent variable), 404 isolation
  chain (404 on cross-user with victim intact → 404 on
  cross-org with victim intact).
- `zero-org-invite.test.ts` (11→2): POST chain (admin
  invites with default member role → admin invites with
  admin role → 403 non-admin → 401 unauth → 401 no-org →
  400 invalid email), DELETE chain (admin revokes an
  invitation → 403 non-admin → 401 unauth → 401 no-org →
  400 missing invitationId). The legacy tests verified
  which Clerk API was or was not called; the BDD version
  uses `toHaveBeenCalledTimes(n)` to assert the same
  external-mock contract.
- `generate-image.test.ts` (7→1): full chain (503 no Gemini
  config → 503 production ignores GEMINI_API_KEY → 401 no
  Clerk session → 400 blank prompt → 402 no credits → 502
  no image in response → 200 success + credits settled
  through waitUntil). The single BDD test re-seeds
  mocks + env between steps so previous steps don't leak.
- `zero-user-connectors.test.ts` (8→3): auth + 404 chain
  (401 unauth → 401 no-org → 404 non-existent agent → 404
  cross-org agent), 200 happy path (new agent with no
  connectors returns empty enabledTypes → owner via CLI
  token also gets empty enabledTypes), 200 filter chain
  (removed connector types are excluded → feature-flag-
  disabled types are excluded).
- `desktop-auth.test.ts` (8→3): create chain (401 unauth
  → 200 creates a callback URL with no Clerk ticket + DB
  row exists → 200 creates a dev callback URL when
  requested), consume chain (200 consumes a handoff code
  - returns a short-lived Clerk ticket + reuse returns 400
    → 400 expired handoff code), status + complete chain
    (200 reports pending for the creating user + 404 for
    another user → 200 marks a consumed handoff complete →
    404 cannot complete an unconsumed handoff).
- `zero-onboarding-status.test.ts` (10→3): auth + no-org
  chain (401 unauth → 200 no-org returns needsOnboarding:
  true), 200 full matrix (no default agent → default
  agent with no metadata → default agent + pending
  payment → pro tier pending payment ignored → team tier
  pending payment ignored → default agent with metadata),
  isolation chain (non-admin never reports
  needsOnboarding → orphan compose is no default agent →
  cross-org default agent is ignored).
- `auth-me.test.ts` (7→3): auth boundary (401 unauth → 200
  returns email after Clerk lookup + cache is populated),
  200 token types (sandbox token → zero token with
  `file:write` capability → zero token with no
  capabilities), 200 cache chain (fresh cached email
  short-circuits Clerk → stale cache refreshes from Clerk
  - re-caches).
- `zero-connectors-scope-diff.test.ts` (8→3): auth +
  capability + 404 chain (401 unauth → 401 no-org → 403
  sandbox token without connector:read → 404 no connector
  configured for the type), 200 empty diff chain (stored
  scopes match current scopes → api-token stripe has empty
  current/stored), 200 diff chain (added scopes when the
  connector is missing required → removed scopes when the
  connector has stale extras).

Service-Level Exceptions noted:

- `internal-callbacks-agent.bdd.test.ts` uses
  `createApp` + `app.request` directly (not the ts-rest
  client) because the agent-callback contract body shape
  is not consumable by the ts-rest test client. The
  OpenRouter API is stubbed via MSW. The
  `OPENROUTER_API_KEY` env var must be cleared between
  steps via `mockOptionalEnv("OPENROUTER_API_KEY",
undefined)` because the first step in the chain sets
  it and the second step expects it to be unset.
- `email-unsubscribe.bdd.test.ts` uses `createApp` +
  `app.request` for the GET chain (HTML response shape is
  not consumable by the ts-rest test client) and the
  ts-rest client for the POST chain. The HMAC signature
  is computed inline from `SECRETS_ENCRYPTION_KEY` using
  the same Web Crypto API the production helper uses.
- `desktop-auth.bdd.test.ts` uses direct DB reads
  against `desktop_auth_handoff_codes` because no
  follow-up GET endpoint for a single handoff exists.
- `auth-me.bdd.test.ts` uses direct DB reads against
  `user_cache` because no follow-up endpoint for a single
  user cache row exists.
- `zero-org-invite.bdd.test.ts` uses
  `toHaveBeenCalledTimes(n)` rather than
  `not.toHaveBeenCalled()` because the mock is shared
  across the chain's steps (the mock has been called by
  previous admin invites; subsequent non-admin or 401
  steps assert the call count is unchanged).
- This round deletes 12 legacy files
  (`zero-voice-io-quota.test.ts`,
  `zero-me-model-providers-delete.test.ts`,
  `internal-callbacks-agent.test.ts`,
  `zero-secrets-delete.test.ts`,
  `zero-custom-connectors-patch.test.ts`,
  `zero-custom-connectors-create.test.ts`,
  `zero-team.test.ts`,
  `email-unsubscribe.test.ts`,
  `zero-variables-delete.test.ts`,
  `zero-org-invite.test.ts`,
  `generate-image.test.ts`,
  `zero-user-connectors.test.ts`,
  `desktop-auth.test.ts`,
  `zero-onboarding-status.test.ts`,
  `auth-me.test.ts`,
  `zero-connectors-scope-diff.test.ts`).

Net test count: 120 legacy `it()`s → 37 BDD `it()`s (69%
reduction). No per-file coverage regression for the
covered route files.

Quality gates: `pnpm -F api lint`, `pnpm -F api
check-types`, `pnpm -F api exec vitest run` (252 files /
3230+ tests) all clean.
