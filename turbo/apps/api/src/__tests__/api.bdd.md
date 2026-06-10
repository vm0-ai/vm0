# API BDD Migration Plan

This file tracks the API Vitest migration for
https://github.com/vm0-ai/vm0/issues/16967. Add rows as route families are
migrated.

## Test Principles

- Setup uses `testContext()` at module scope and calls routes through
  `setupApp({ context })(contract)`.
- Given state for BDD route tests is created through real API requests whenever
  a user-visible route exists.
- When steps are real API requests.
- Then steps assert response bodies and verify state through follow-up API
  requests, artifact/file reads, queue/status APIs, or external-provider mock
  state.
- BDD tests do not seed rows with `writeDb$`, Drizzle inserts, or
  `store.set(writeDb$)`.
- BDD tests do not verify outcomes by reading database rows directly.
- Mock only external services through `context.mocks` or MSW.

## Helper Contract

- BDD helpers must be thin wrappers over route calls or external-service mocks.
- Database fixture helpers are legacy coverage and should be removed when the
  same state can be created or observed through route calls.
- If a required precondition or assertion is user-reachable but has no visible
  route/helper, record it under Open Helper Gaps and keep the legacy test until
  the gap is closed.
- If source code is not reachable from any API endpoint, record it under
  Unreachable Code Candidates. Do not delete production source in this effort.

## Chained Scenario Candidates

| ID                      | Route family                                | Candidate chain                                                                                                       |
| ----------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| CHAIN-FEATURE-SWITCHES  | `/api/zero/feature-switches`                | GET empty overrides -> POST create -> GET created -> POST merge -> POST override -> GET merged -> DELETE -> GET empty |
| CHAIN-MEMORY-SUMMARY    | `/api/cron/summarize-memory`                | seed memory versions -> GET cron summarize -> GET memory activity -> POST dev refresh -> GET memory activity          |
| CHAIN-AGENT-RUN-STORAGE | `/api/agent/runs` + `/api/storages/prepare` | POST prepare uncommitted volume -> POST create run with additional volume -> inspect run-context snapshot             |
| CHAIN-STRIPE-INVOICE    | `/api/webhooks/stripe`                      | POST concurrent subscription invoice.paid deliveries -> verify billing credits and expiry idempotency                 |
| CHAIN-VOICE-IO-QUOTA    | `/api/zero/voice-io/*`                      | POST test telegram state -> GET quota -> POST STT until exhausted -> GET quota blocked -> POST STT blocked            |
| CHAIN-TEST-TELEGRAM     | `/api/test/telegram-state`                  | POST seed Telegram state -> GET diagnostic state -> POST idempotent seed -> GET stable link -> DELETE cleanup         |
| CHAIN-API-KEYS          | `/api/zero/api-keys`                        | POST create key -> GET list without token -> DELETE key -> GET list without key -> DELETE foreign key returns 404     |
| CHAIN-CUSTOM-CONNECTOR  | `/api/zero/custom-connectors`               | POST create connector -> GET list -> PATCH rename -> PUT secret -> DELETE secret/connector -> GET visible state       |
| CHAIN-CHAT-THREAD-META  | `/api/zero/chat-threads/*`                  | POST create agent -> POST create thread -> POST pin/rename/model-selection/unpin -> GET list/detail visible metadata  |
| CHAIN-SECRETS           | `/api/zero/secrets`                         | POST create user secret -> GET list -> DELETE user secret -> GET list without secret                                  |

## Migration Audit Table

| Case group           | Legacy coverage                                                                         | BDD case id                 | Decision | Evidence                                                                                                                                                                                                                                   |
| -------------------- | --------------------------------------------------------------------------------------- | --------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| FEATURE-SWITCHES-01  | Unauthenticated and organizationless GET/POST/DELETE requests                           | CHAIN-FEATURE-SWITCHES-AUTH | migrated | `zero-feature-switches.test.ts` calls the route contract for all three operations and expects 401 responses.                                                                                                                               |
| FEATURE-SWITCHES-02  | Empty, create, merge, override, delete, and follow-up reads                             | CHAIN-FEATURE-SWITCHES      | migrated | `zero-feature-switches.test.ts` creates and verifies all state through the feature-switches API.                                                                                                                                           |
| MEMORY-SUMMARY-01    | Changed summary, item path, user isolation, and dev refresh                             | CHAIN-MEMORY-SUMMARY        | partial  | `cron-summarize-memory.test.ts` now verifies changed-summary outcomes through `/api/zero/memory/activity`.                                                                                                                                 |
| AGENT-RUN-STORAGE-01 | Additional volume latest-version resolution for prepared storage without a HEAD version | CHAIN-AGENT-RUN-STORAGE     | partial  | `agent-runs-create.test.ts` creates the no-HEAD volume through `/api/storages/prepare`, creates the run through `/api/agent/runs`, and verifies the volume is omitted through the run-context Axiom mock; compose setup is still legacy.   |
| STRIPE-INVOICE-01    | Duplicate subscription `invoice.paid` branch guarded by the org row lock                | CHAIN-STRIPE-INVOICE        | partial  | `webhooks-third-party.test.ts` posts two concurrent Stripe webhook requests and gates the mocked subscription lookup until both deliveries are ready; billing verification still uses DB reads until a billing observation API is audited. |
| VOICE-IO-QUOTA-01    | Free-tier lifetime audio-input quota states from zero usage through quota exhaustion    | CHAIN-VOICE-IO-QUOTA        | partial  | `zero-voice-io-quota.test.ts` creates a free starter org through `/api/test/telegram-state`, records usage through `/api/zero/voice-io/stt`, and verifies quota state through `/api/zero/voice-io/quota`.                                  |
| TEST-TELEGRAM-01     | POST seed/idempotency state verification                                                | CHAIN-TEST-TELEGRAM         | partial  | `test-telegram-state.test.ts` now verifies seeded installation, link, org metadata, and idempotent link state through `/api/test/telegram-state` GET responses instead of direct DB row reads.                                             |
| API-KEYS-01          | Create, list, delete, and foreign-owner delete behavior                                 | CHAIN-API-KEYS              | partial  | `zero-api-keys.test.ts` and `zero-api-keys-delete.test.ts` create keys through POST, verify persisted state through GET list, and verify delete/foreign-owner behavior through DELETE plus follow-up GET list.                             |
| CUSTOM-CONNECTOR-01  | Connector creation, rename, delete, and per-user secret flags                           | CHAIN-CUSTOM-CONNECTOR      | partial  | The custom connector create/patch/delete and secret set/delete suites create connectors through POST, mutate them through route calls, and verify visibility/per-user `hasSecret` through GET list.                                        |
| CHAT-THREAD-META-01  | Pin, unpin, rename, idempotency, and cross-user no-leak behavior                        | CHAIN-CHAT-THREAD-META      | migrated | `zero-chat-threads-pin.test.ts`, `zero-chat-threads-unpin.test.ts`, and `zero-chat-threads-rename.test.ts` create agents/threads through route calls and verify `pinnedAt`, `renamedAt`, title, and list placement through GET list.       |
| CHAT-THREAD-MODEL-01 | Model selection set, clear, validation, and cross-user no-leak behavior                 | CHAIN-CHAT-THREAD-META      | migrated | `zero-chat-threads-model-selection.test.ts` creates agents/threads through route calls, mutates model selection through POST, and verifies `modelProviderId`/`selectedModel` through GET detail responses.                                 |
| SECRETS-DELETE-01    | Delete user secret, missing secret, and cross-user/cross-org no-leak behavior           | CHAIN-SECRETS               | partial  | `zero-secrets-delete.test.ts` creates user secrets through POST, deletes through DELETE, and verifies user-visible state through GET list; connector-type filter regression still needs a visible connector-secret setup/read helper.      |

## Open Helper Gaps

| File or route family          | Current delta | Gap                                                                                                                                                                                                                                                                                                                                                   | Current action                                                                                                                                                                                        |
| ----------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/zero/voice-io/quota`    | 0 statements  | Free-tier setup and quota exhaustion are now API-visible through `/api/test/telegram-state` plus `/api/zero/voice-io/stt`; the missing-metadata and zero-usage fixture checks are redundant parity guards, paid-tier setup still has no route fixture, and a `count > limit` state cannot be reached through STT because the API blocks at the limit. | Keep the redundant fixture guards, paid-tier, and above-limit legacy coverage until a paid-tier fixture API exists or the direct data-state cases are recorded as approved exceptions.                |
| `/api/test/telegram-state`    | -1 statement  | The starter-grant `inserted.length === 0` branch is a concurrent conflict path where a credit-expiry insert loses while org metadata is still not visible. It is reachable only through timing-sensitive concurrent setup and has no deterministic route/helper precondition.                                                                         | Keep the concurrent preflight coverage, avoid adding flaky timing loops, and accept the documented one-statement gap until a deterministic setup helper exists or the route is simplified.            |
| `/api/zero/api-keys`          | 0 statements  | Sorted list and `lastUsedAt` formatting cases need predated API-key rows with mutable usage timestamps, but there is no user-visible route to create historical keys or mark a key as used at a controlled time.                                                                                                                                      | Keep those legacy fixture rows until a visible helper exists; create/delete/no-leak behavior is now verified through route calls.                                                                     |
| `/api/zero/custom-connectors` | 0 statements  | Secret material is intentionally never exposed by API responses, so exact encrypted-value/decryption assertions and exact secret-row cascade assertions cannot be expressed through route reads. Connector ownership fields such as `createdBy` are also not response fields; route-level scoping is observed through list responses.                 | Verify create, rename, delete, and per-user secret state through route-visible fields, and keep exact secret material checks out of BDD route tests unless a dedicated safe diagnostic helper exists. |
| `/api/zero/secrets`           | 0 statements  | User secret create/list/delete is API-visible, but the `secrets.type = "connector"` type-filter regression guard has no public setup route or safe read route that creates that exact legacy row shape.                                                                                                                                               | Keep the connector-type direct fixture guard in `zero-secrets-delete.test.ts` until connector secret setup/read is API-visible or the legacy row shape is retired.                                    |

## Unreachable Code Candidates

None recorded yet.

## Service-Level Exceptions

None recorded yet.

## Drop Decisions

| File                                                            | Decision           | Reason                                                                                                                                                       |
| --------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/signals/routes/__tests__/helpers/zero-feature-switches.ts` | drop legacy helper | The migrated feature-switch tests no longer need direct database seeding or cleanup; all state is created and verified through `/api/zero/feature-switches`. |
