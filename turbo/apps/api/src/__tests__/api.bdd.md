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

| ID                     | Route family                 | Candidate chain                                                                                                       |
| ---------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| CHAIN-FEATURE-SWITCHES | `/api/zero/feature-switches` | GET empty overrides -> POST create -> GET created -> POST merge -> POST override -> GET merged -> DELETE -> GET empty |

## Migration Audit Table

| Case group          | Legacy coverage                                               | BDD case id                 | Decision | Evidence                                                                                                     |
| ------------------- | ------------------------------------------------------------- | --------------------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| FEATURE-SWITCHES-01 | Unauthenticated and organizationless GET/POST/DELETE requests | CHAIN-FEATURE-SWITCHES-AUTH | migrated | `zero-feature-switches.test.ts` calls the route contract for all three operations and expects 401 responses. |
| FEATURE-SWITCHES-02 | Empty, create, merge, override, delete, and follow-up reads   | CHAIN-FEATURE-SWITCHES      | migrated | `zero-feature-switches.test.ts` creates and verifies all state through the feature-switches API.             |

## Open Helper Gaps

| File or route family                                    | Current delta | Gap                                                                                                                                                                         | Current action                                                                                                            |
| ------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `/api/zero/voice-io/quota`                              | 0 statements  | Quota scenarios need org tier and lifetime audio input usage preconditions, but no user-visible setup API has been audited for those values yet.                            | Keep existing legacy coverage until an API-visible setup path is identified or this is recorded as an approved exception. |
| `src/signals/services/agent-run-storage.service.ts`     | -1 statement  | Runner storage-manifest edge cases still need storage rows, storage versions, and S3 state that are not yet fully constructible and observable through route-level helpers. | Keep existing coverage until storage/artifact BDD helpers expose the setup and readback path through APIs.                |
| `src/signals/services/cron-summarize-memory.service.ts` | -2 statements | Memory-summary cron behavior is invoked through an API route, but summary rows are currently observable only by direct database reads in tests.                             | Keep existing coverage until a visible API/helper can verify generated memory summaries without direct DB assertions.     |

## Unreachable Code Candidates

None recorded yet.

## Service-Level Exceptions

None recorded yet.

## Drop Decisions

| File                                                            | Decision           | Reason                                                                                                                                                       |
| --------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/signals/routes/__tests__/helpers/zero-feature-switches.ts` | drop legacy helper | The migrated feature-switch tests no longer need direct database seeding or cleanup; all state is created and verified through `/api/zero/feature-switches`. |
