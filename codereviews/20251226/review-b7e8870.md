# Review: b7e8870 - feat: add scope support to agent compose

## Summary

This is the main feature commit that adds scope support to agent composes, enabling the `scope/name:version` naming convention.

## Changes Overview

**Files Changed:** 21 files (+563/-35 lines)

### Key Components:

1. **CLI Changes** (`turbo/apps/cli/`)
   - `run.ts`: Added scope parsing for `[scope/]name[:version]` format
   - `compose.ts`: Display `scope/name:version` format in output
   - `api-client.ts`: Added optional `scope` parameter to `getComposeByName()`

2. **API Changes** (`turbo/apps/web/`)
   - `composes/route.ts`: Resolve composes by scope+name, auto-use user's scope
   - `cli/auth/token/route.ts`: Auto-create personal scope on login

3. **Database Changes**
   - `agent-compose.ts`: Added `scopeId` column with foreign key to `scopes`
   - Migration 0045: Create scopes for existing users
   - Migration 0046: Add `scopeId` to `agent_composes` with index

4. **Service Layer**
   - `scope-service.ts`: Added `generateDefaultScopeSlug()` using SHA-256 hash

5. **Contracts**
   - `composes.ts`: Added optional `scope` query parameter

## Code Quality Analysis

### Positive Aspects

1. **Follows existing patterns**: The implementation mirrors the proven Image scope pattern already in production
2. **Deterministic slug generation**: Using SHA-256 hash ensures consistent user experience across logins
3. **Migration strategy**: Clean two-phase migration - first create scopes, then add `scopeId` column
4. **Type safety**: Proper TypeScript types throughout
5. **Error handling in scope creation**: Handles rare slug collision with fallback

### Issues Found

#### 1. Silent Error Swallowing in compose.ts (Minor)

```typescript
try {
  const scopeResponse = await apiClient.getScope();
  scopeSlug = scopeResponse.slug;
} catch {
  // Scope might not be available, continue without it
}
```

**Concern**: Empty catch block silently swallows any error. While intentional for scope unavailability, this could mask other errors.

**Suggestion**: Consider logging at debug level or checking for specific error types.

#### 2. Tests Use Direct DB Operations (Acceptable for test setup)

Multiple test files directly insert into `agentComposes` and `scopes` tables. Per bad-smell guidelines (rule 12), tests should prefer API endpoints. However, this is acceptable for test setup/fixtures where API calls would execute complex business logic (like sandbox creation).

### Mock Analysis

**New mocks identified:**
- None in production code

**Test mocks:**
- `vi.mock("@clerk/nextjs/server")` - Existing pattern
- `vi.mock("next/headers")` - Existing pattern

No new mock patterns introduced.

### Error Handling Analysis

1. **Token route**: Proper error handling with retry logic for slug collision
2. **Composes route**: Returns 400 with descriptive messages for missing scope

### Interface Changes

1. **API Contract**: Added optional `scope` query parameter to `GET /api/agent/composes`
   - Backward compatible (scope is optional)
2. **CLI API Client**: Added optional `scope` parameter to `getComposeByName()`
   - Backward compatible

### Migration Safety

Both migrations are safe:
- 0045: Uses `ON CONFLICT DO NOTHING` for idempotency
- 0046: Multi-step approach with proper ordering

## Verdict

**APPROVED** - Well-implemented feature following established patterns. Minor suggestion for error logging but not blocking.
