# Implementation Plan: ts-rest Integration for CLI (Issue 1182)

## Overview

Migrate CLI API client from raw fetch to ts-rest client, starting with `createRun` as the first PR to validate the approach in CI.

## Phase 1: createRun Migration (First PR)

### Goal

Replace `apiClient.createRun()` with ts-rest client implementation and ensure all CI pipelines pass.

### Files to Modify

1. **`turbo/apps/cli/src/lib/api-client.ts`**
   - Add ts-rest client infrastructure (createClientConfig, getRunsClient)
   - Replace `createRun()` method implementation
   - Keep existing method signature for backward compatibility
   - Remove local `CreateRunResponse` type (use from contract)

2. **`turbo/apps/cli/src/lib/__tests__/api-client.test.ts`**
   - Update `createRun` tests to use proper Response mock with headers
   - Ensure all existing test cases still pass

### Changes Detail

**Add to api-client.ts:**

```typescript
import { initClient } from "@ts-rest/core";
import { runsMainContract, type ApiErrorResponse } from "@vm0/core";

async function createClientConfig() { ... }
async function getRunsClient() { ... }
```

**Replace createRun method:**

- Use ts-rest client internally
- Maintain same public interface
- Throw errors same as before for compatibility

### Cleanup

- Delete spike files after merging:
  - `src/lib/api-client-tsrest-spike.ts`
  - `src/lib/__tests__/api-client-tsrest-spike.test.ts`

---

## Phase 2: Events & Telemetry Endpoints

### Endpoints to Migrate

- `getEvents()` - uses `runEventsContract`
- `getTelemetry()` - uses `runTelemetryContract`
- `getSystemLog()` - uses `runSystemLogContract`
- `getMetrics()` - uses `runMetricsContract`
- `getAgentEvents()` - uses `runAgentEventsContract`
- `getNetworkLogs()` - uses `runNetworkLogsContract`

### Approach

- Add client factories for each contract
- Migrate one endpoint at a time
- Update corresponding tests

---

## Phase 3: Compose Endpoints

### Endpoints to Migrate

- `getComposeByName()` - uses `composesMainContract`
- `getComposeById()` - uses `composesByIdContract`
- `getComposeVersion()` - uses `composesVersionsContract`
- `createOrUpdateCompose()` - uses `composesMainContract`

### Notes

- `getComposeVersion` has jsonQuery edge case (scientific notation) - ts-rest handles automatically

---

## Phase 4: Session & Scope Endpoints

### Endpoints to Migrate

- `getSession()` - uses `sessionsByIdContract`
- `getCheckpoint()` - uses `checkpointsByIdContract`
- `getScope()` - uses `scopeContract`
- `createScope()` - uses `scopeContract`
- `updateScope()` - uses `scopeContract`

---

## Phase 5: Generic Methods & Cleanup

### Decision Point

Generic methods (`get()`, `post()`, `delete()`) are used by:

- `direct-upload.ts` for storage endpoints

### Options

A. Migrate storage endpoints to typed clients, remove generic methods
B. Keep generic methods but consolidate header logic
C. Create typed storage client, deprecate generic methods

### Final Cleanup

- Remove unused local type definitions
- Consolidate all client creation logic
- Update all tests to use proper Response mocks
- Remove any remaining `as Type` casts without validation

---

## Success Criteria

### Phase 1 (Must Pass)

- [ ] All existing `createRun` tests pass
- [ ] Type check passes (`pnpm check-types`)
- [ ] Lint passes (`pnpm lint`)
- [ ] All CLI tests pass (`pnpm vitest run`)
- [ ] CI pipeline passes (lint, test, build, cli-e2e)

### Overall

- [ ] No breaking changes to public API
- [ ] All 523+ tests pass
- [ ] Code reduction target: ~780 lines → ~300 lines
- [ ] All API responses validated at runtime
