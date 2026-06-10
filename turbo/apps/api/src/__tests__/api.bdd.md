# API BDD Migration Plan

Issue: https://github.com/vm0-ai/vm0/issues/16967

This file is the working audit for rewriting `turbo/apps/api/src/**/*.test.ts`
into API-first BDD coverage without silently losing coverage.

## Coverage Baseline

Baseline command:

```shell
pnpm -F api exec vitest run --coverage
```

Last green baseline captured on 2026-06-10:

| Metric     | Coverage |
| ---------- | -------: |
| Statements |   87.20% |
| Branches   |   72.80% |
| Functions  |   93.32% |
| Lines      |   87.20% |

Artifacts:

- `/tmp/vm0-api-coverage/base-per-file.json`
- `/tmp/vm0-api-coverage/current-per-file.json`
- `/tmp/vm0-api-coverage/diff.json`
- `/tmp/vm0-api-coverage/diff.tsv`

Latest current run on 2026-06-10:

| Metric     | Coverage |
| ---------- | -------: |
| Statements |   87.16% |
| Branches   |   72.76% |
| Functions  |   93.29% |
| Lines      |   87.16% |

Current diff status: `pnpm -F api exec vitest run --coverage` passes, but the
overall percentages are below the captured baseline. The secrets/variables
production route and service files did not regress in per-file coverage; the
remaining negative deltas are currently in unrelated Slack connect source files
and test helper files. Do not mark the migration complete until the overall
baseline diff is closed or a stricter source-only baseline policy is agreed.

## Test Principles

Route BDD tests must use this sequence:

1. Setup app with `testContext()` and `setupApp({ context })(contract)`.
2. Given state through real API requests. Do not seed route BDD tests through
   `writeDb$`, Drizzle inserts, or service commands.
3. When through one real API request.
4. Then assert the response and verify state through follow-up API requests or
   external mock state.

Route BDD tests may mock only external services through `context.mocks` or MSW.
Do not `vi.mock()` internal modules. Do not use fake timers. Deterministic time
must use `mockNow`.

## Helper Contract

BDD helpers must be thin route wrappers or external mock setup. A helper may not
hide direct database writes or reads for route preconditions/assertions.

If a reachable behavior cannot currently be set up or observed through an API,
record it as an Open Helper Gap and keep the legacy coverage until the gap is
closed. If code is not reachable from any API endpoint, record it as an
Unreachable Code Candidate before dropping legacy coverage.

## Chained Scenario Candidates

- `CHAIN-AGENT`: create agent -> read/list -> update -> read -> delete.
- `CHAIN-RUN`: create run -> read/detail -> queue/status -> cancel.
- `CHAIN-CHAT`: create thread -> message -> list/read -> rename/pin/read-state.
- `CHAIN-CONNECTOR`: connect/custom connector -> list/search/read -> patch -> delete.
- `CHAIN-BILLING-MEDIA`: billing status/checkout/portal plus image/video/voice quota.
- `CHAIN-FILE`: upload prepare -> complete -> download.
- `CHAIN-SCHEDULE`: create schedule -> list/read -> enable/disable/run/delete.

## Service-Level Exceptions

These categories are not route BDD migrations unless a public route can exercise
the behavior with equivalent assertions:

| Category                       | Scope                                                                                                                                               |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Custom ESLint rules            | `turbo/apps/api/custom-eslint/__tests__`                                                                                                            |
| App/bootstrap compatibility    | `src/__tests__/app-factory.test.ts`, `instrument.test.ts`, `release-please-config.test.ts`, `vercel-crons.test.ts`, `web-api-compatibility.test.ts` |
| Auth and middleware primitives | token signing/parsing and route wrapper behavior that runs before route handlers                                                                    |
| Pure/lib adapters              | SQL span names, time helpers, log adapter behavior, callback route wrapper                                                                          |
| Provider failure log mapping   | `providerFailureDetailsForLog` and provider-specific error mappers that normalize external provider payloads before logging or response mapping     |
| External adapters              | service clients without a route-visible behavior surface                                                                                            |
| Pure algorithms                | parsers, crypto helpers, memory diff/summarize helpers, cron next-run calculation                                                                   |

## Open Helper Gaps

| ID                              | Area                  | Gap                                                                                                                                                                                                                                                               | Legacy Coverage                                                              |
| ------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| GAP-MODEL-STATS-01              | Model stats           | Model usage observations and public ranking fixtures are still created with direct DB writes; a route-visible setup path must be identified before converting this file to strict route BDD.                                                                      | `src/signals/routes/__tests__/model-stats.test.ts`                           |
| GAP-MEMORY-CRON-01              | Memory summarize cron | Memory storage/version setup is still built with fixture commands and S3 mocks. Keep legacy cron coverage until setup and Then assertions are route-visible or documented as a service exception.                                                                 | `src/signals/routes/__tests__/cron-summarize-memory.test.ts`                 |
| GAP-DESKTOP-UPDATES-01          | Desktop updates       | Manifest Given currently uses an internal service test hook. Convert to an external manifest fetch mock or record a service-level exception before migrating.                                                                                                     | `src/signals/routes/__tests__/desktop-updates.test.ts`                       |
| GAP-MODEL-POLICIES-ZERO-AUTH-01 | Model policies        | Zero-token reads require an org membership cache row; no route-visible setup path has been identified for that membership state. Keep legacy coverage until the auth Given can be created through an API or the behavior is split into an auth service exception. | `src/signals/routes/__tests__/zero-model-policies.test.ts`                   |
| GAP-ZERO-USER-DATA-CONNECTOR-01 | Secrets and variables | User secrets/variables POST routes only create `type: "user"` rows. Connector-owned secret/variable rows are route-visible in list/delete behavior but cannot be constructed through a public API setup path yet.                                                 | `src/signals/routes/__tests__/zero-secrets-variables-connector-gaps.test.ts` |

## Unreachable Code Candidates

None recorded yet.

## Drop Decisions

None recorded yet.

## Migration Audit Table

| ID                          | Route family                 | Legacy test                                                                                                                                                                                                                          | BDD replacement                                                                                                                                     | Status             | Coverage note                                                                                                                                                                                                                            |
| --------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OPS-HEALTH-01               | Health                       | `src/signals/routes/__tests__/health.test.ts`                                                                                                                                                                                        | `src/signals/routes/__tests__/health.bdd.test.ts`                                                                                                   | Migrated           | API-only, no helper gap. Public health and unauthenticated auth-health are chained in one test.                                                                                                                                          |
| OPS-REALTIME-01             | Realtime token               | `src/signals/routes/__tests__/zero-realtime-token.test.ts`                                                                                                                                                                           | `src/signals/routes/__tests__/zero-realtime-token.bdd.test.ts`                                                                                      | Migrated           | API-only with Clerk Given and Ably external mock Then; unauthenticated and authenticated flow are chained in one test.                                                                                                                   |
| ORG-LIST-01                 | Org list                     | `src/signals/routes/__tests__/zero-org-list.test.ts`                                                                                                                                                                                 | `src/signals/routes/__tests__/zero-org-list.bdd.test.ts`                                                                                            | Migrated           | API-only with Clerk membership mock Given; unauthenticated, single-org, and multi-org flow are chained in one test.                                                                                                                      |
| ORG-INVITE-01               | Org invite                   | `src/signals/routes/__tests__/zero-org-invite.test.ts`                                                                                                                                                                               | `src/signals/routes/__tests__/zero-org-invite.bdd.test.ts`                                                                                          | Migrated           | API-only with Clerk invitation mock Then; invite and revoke flows are chained by method.                                                                                                                                                 |
| ORG-MEMBERSHIP-REQUESTS-01  | Org membership requests      | `src/signals/routes/__tests__/zero-org-membership-requests.test.ts`                                                                                                                                                                  | `src/signals/routes/__tests__/zero-org-membership-requests.bdd.test.ts`                                                                             | Migrated           | API-only with Clerk/MSW boundary; accept and reject flows are chained by method.                                                                                                                                                         |
| ORG-LOGO-01                 | Org logo                     | `src/signals/routes/__tests__/zero-org-logo.test.ts`                                                                                                                                                                                 | `src/signals/routes/__tests__/zero-org-logo.bdd.test.ts`                                                                                            | Migrated           | API-only with Clerk external logo mock Then; get, upload, and delete flows are chained by method.                                                                                                                                        |
| ATTRIBUTION-01              | Signup attribution           | `src/signals/routes/__tests__/zero-attribution.test.ts`                                                                                                                                                                              | `src/signals/routes/__tests__/zero-attribution.bdd.test.ts`                                                                                         | Migrated           | API-only with Clerk user metadata mock Given; auth failure, first-touch write, and no-overwrite flow are chained in one test.                                                                                                            |
| FILE-LEGACY-01              | Legacy file redirects        | `src/signals/routes/__tests__/legacy-file.test.ts`                                                                                                                                                                                   | `src/signals/routes/__tests__/legacy-file.bdd.test.ts`                                                                                              | Migrated           | API-only raw app requests with S3 external mock Then; migrated, fallback, and CORS flows are chained in one test.                                                                                                                        |
| BILLING-REDEEM-CODE-01      | Billing redeem code          | `src/signals/routes/__tests__/zero-billing-redeem-code.test.ts`                                                                                                                                                                      | `src/signals/routes/__tests__/zero-billing-redeem-code.bdd.test.ts`                                                                                 | Migrated           | API-only with Clerk M2M and Atom MSW boundary; auth/config, Atom errors, and success are chained.                                                                                                                                        |
| TEST-OAUTH-PROVIDER-01      | Test OAuth provider          | `src/signals/routes/__tests__/test-oauth-provider-get.test.ts`                                                                                                                                                                       | `src/signals/routes/__tests__/test-oauth-provider-get.bdd.test.ts`                                                                                  | Migrated           | API-only synthetic OAuth routes; production/preview gates, authorize, device auth, code exchange, refresh, device-token, userinfo, and echo flows are chained.                                                                           |
| COMPOSE-READ-01             | Zero composes read/list      | `src/signals/routes/__tests__/zero-composes-by-id.test.ts`, `src/signals/routes/__tests__/zero-composes-by-name.test.ts`, `src/signals/routes/__tests__/zero-composes-list.test.ts`                                                  | `src/signals/routes/__tests__/zero-composes.bdd.test.ts`                                                                                            | Migrated           | Given composes are created through `/api/agent/composes`; Then uses zero by-id, by-name, list, metadata, sandbox, and delete APIs.                                                                                                       |
| API-KEYS-01                 | Zero API keys                | `src/signals/routes/__tests__/zero-api-keys.test.ts`, `src/signals/routes/__tests__/zero-api-keys-delete.test.ts`                                                                                                                    | `src/signals/routes/__tests__/zero-api-keys.bdd.test.ts`                                                                                            | Migrated           | Given keys are created through the API; Then uses list/delete APIs to verify token hiding, sort order, owner isolation, and delete visibility.                                                                                           |
| SCHEDULE-MUTATIONS-01       | Zero schedule mutations      | `src/signals/routes/__tests__/zero-schedules-enable.test.ts`, `src/signals/routes/__tests__/zero-schedules-disable.test.ts`, `src/signals/routes/__tests__/zero-schedules-delete.test.ts`                                            | `src/signals/routes/__tests__/zero-schedules-mutations.bdd.test.ts`                                                                                 | Migrated           | Given schedules are deployed through `/api/zero/schedules`; Then uses enable, disable, list, delete, and zero-token capability APIs, including one-time past enable via `mockNow`.                                                       |
| BILLING-PORTAL-INVOICES-01  | Billing portal and invoices  | `src/signals/routes/__tests__/zero-billing-portal.test.ts`, `src/signals/routes/__tests__/zero-billing-invoices.test.ts`                                                                                                             | `src/signals/routes/__tests__/zero-billing-portal-invoices.bdd.test.ts`                                                                             | Migrated           | Given Stripe customers are created through checkout API; Then uses portal and invoice APIs with Stripe external mocks.                                                                                                                   |
| FEATURE-SWITCHES-01         | Feature switches             | `src/signals/routes/__tests__/zero-feature-switches.test.ts`                                                                                                                                                                         | `src/signals/routes/__tests__/zero-feature-switches.bdd.test.ts`                                                                                    | Migrated           | API-only GET/POST/DELETE chain; update, merge, override, and delete are verified through follow-up GET without DB assertions.                                                                                                            |
| USER-PREFERENCES-01         | User preferences             | `src/signals/routes/__tests__/zero-user-preferences.test.ts`                                                                                                                                                                         | `src/signals/routes/__tests__/zero-user-preferences.bdd.test.ts`                                                                                    | Migrated           | API-only GET/POST chain from default state; invalid updates, full create, partial updates, and final persistence are verified through route responses and GET.                                                                           |
| USER-MODEL-PREFERENCE-01    | User model preference        | `src/signals/routes/__tests__/zero-user-model-preference.test.ts`                                                                                                                                                                    | `src/signals/routes/__tests__/zero-user-model-preference.bdd.test.ts`                                                                               | Migrated           | API-only GET/PUT chain from default state; malformed bodies, removed models, unconfigured supported models, configured model persistence, and clearing are verified through responses and GET.                                           |
| TEAM-LIST-01                | Team list                    | `src/signals/routes/__tests__/zero-team.test.ts`                                                                                                                                                                                     | `src/signals/routes/__tests__/zero-team.bdd.test.ts`                                                                                                | Migrated           | Given agents, skills, and raw composes are created through public APIs; Then verifies empty list, metadata, custom skills, org isolation, private visibility, and raw compose exclusion through `/api/zero/team`.                        |
| DEFAULT-AGENT-01            | Default agent                | `src/signals/routes/__tests__/zero-default-agent.test.ts`                                                                                                                                                                            | `src/signals/routes/__tests__/zero-default-agent.bdd.test.ts`                                                                                       | Migrated           | Given agents are created and deleted through public zero-agent APIs; Then verifies auth/admin gates, invalid body, missing/cross-org agents, set, duplicate conflict, unset conflict, and re-set after deletion through route responses. |
| PERSONAL-MODEL-PROVIDERS-01 | Personal model providers     | `src/signals/routes/__tests__/zero-me-model-providers-list.test.ts`, `src/signals/routes/__tests__/zero-me-model-providers-upsert.test.ts`, `src/signals/routes/__tests__/zero-me-model-providers-delete.test.ts`                    | `src/signals/routes/__tests__/zero-me-model-providers.bdd.test.ts`                                                                                  | Migrated           | API-only list/upsert/delete chain; verifies auth/org gates, empty list, create, update, owner isolation, delete, unsupported providers, and Codex auth_json success/error metadata without DB secret assertions.                         |
| ZERO-USER-DATA-01           | Secrets and variables        | `src/signals/routes/__tests__/zero-secrets.test.ts`, `src/signals/routes/__tests__/zero-secrets-delete.test.ts`, `src/signals/routes/__tests__/zero-variables.test.ts`, `src/signals/routes/__tests__/zero-variables-delete.test.ts` | `src/signals/routes/__tests__/zero-secrets-variables.bdd.test.ts` plus `src/signals/routes/__tests__/zero-secrets-variables-connector-gaps.test.ts` | Partially migrated | User-owned list/set/delete, auth/org failures, validation failures, cross-user/cross-org isolation, and KMS external boundary are strict API-first BDD. Connector-owned setup remains legacy under `GAP-ZERO-USER-DATA-CONNECTOR-01`.    |
| PROVIDER-FAILURE-LOG-01     | Provider failure log mapping | `src/signals/routes/__tests__/webhooks-built-in-generations.test.ts`                                                                                                                                                                 | Service-level exception                                                                                                                             | Retained           | Pure provider payload normalization; no route-visible stable Then beyond logs.                                                                                                                                                           |
| OPS-MODEL-STATS-01          | Model stats                  | `src/signals/routes/__tests__/model-stats.test.ts`                                                                                                                                                                                   | Pending                                                                                                                                             | Legacy retained    | Strict BDD blocked by `GAP-MODEL-STATS-01`.                                                                                                                                                                                              |
| OPS-MEMORY-CRON-01          | Memory summarize cron        | `src/signals/routes/__tests__/cron-summarize-memory.test.ts`                                                                                                                                                                         | Pending                                                                                                                                             | Legacy retained    | Strict BDD blocked by `GAP-MEMORY-CRON-01`.                                                                                                                                                                                              |
