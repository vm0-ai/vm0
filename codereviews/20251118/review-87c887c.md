# Code Review: Commit 87c887c

**Commit:** 87c887cdf900010f8b71bf900b910abf8af60a69
**Title:** feat: migrate authentication from api keys to bearer tokens (#59)
**Author:** Ethan Zhang
**Date:** Tue Nov 18 18:29:21 2025 +0800
**Reviewer:** Claude Code
**Review Date:** 2025-11-20

## Summary of Changes

This commit represents a significant architectural change that migrates the authentication system from API key-based authentication to OAuth 2.0 device flow with bearer tokens. The changes include:

### Added Files
- `/turbo/apps/web/src/lib/auth/sandbox-token.ts` - Token generation for E2B sandboxes
- 3 database migration files for schema changes

### Modified Files
- 5 API route handlers (agent-configs, agent-runtimes, webhooks)
- Database schema files (agent-config, agent-runtime)
- E2B service implementation
- Seed script

### Deleted Files
- API key schema and middleware (`api-key.ts`, `auth.ts`, `webhook-auth.ts`)
- 4 test files (1,180 lines of tests removed)

### Statistics
- **24 files changed**
- **+168 insertions, -1,383 deletions**
- **Net reduction of 1,215 lines**

---

## Issues Found

### 1. Mock Analysis

**Status:** ✅ PASS

No new mocks were introduced in this commit. The changes actually removed test files that contained mocks rather than adding new ones.

---

### 2. Test Coverage

**Status:** ❌ FAIL - Critical Issue

**Problem:** This commit deletes 4 complete test files (1,180+ lines) without replacing them:

1. `/turbo/apps/web/src/lib/__tests__/webhook-auth.test.ts` (99 lines)
2. `/turbo/apps/web/src/lib/api/__tests__/agent-configs.test.ts` (260 lines)
3. `/turbo/apps/web/src/lib/api/__tests__/agent-runtimes.test.ts` (361 lines)
4. `/turbo/apps/web/src/lib/api/__tests__/webhooks.test.ts` (360 lines)
5. `/turbo/apps/web/src/lib/middleware/__tests__/auth.test.ts` (136 lines)

**Impact:**
- Zero test coverage for the new bearer token authentication system
- No tests for `generateSandboxToken()` function
- No tests for the updated API routes using `getUserId()`
- No tests for webhook endpoint with resource ownership validation
- No tests for E2B service with new token passing mechanism

**What Should Be Tested:**
1. **Sandbox Token Generation:**
   - Token generation creates valid tokens
   - Tokens are stored in database with correct expiration (2 hours)
   - Expired token cleanup works correctly
   - Token format matches `vm0_live_*` pattern

2. **API Authentication:**
   - Endpoints reject requests without Authorization header
   - Endpoints accept valid bearer tokens
   - Endpoints reject expired tokens
   - Endpoints reject invalid tokens

3. **Resource Ownership:**
   - Webhook endpoint verifies runtime belongs to authenticated user
   - Users cannot access other users' agent configs
   - Users cannot access other users' runtimes

4. **E2B Integration:**
   - Sandbox receives correct environment variables
   - Sandbox token is passed correctly to E2B runtime

---

### 3. Error Handling

**Status:** ✅ PASS

The error handling follows the project's "fail fast" principle appropriately:

```typescript
// Good: Fail fast when not authenticated
const userId = await getUserId();
if (!userId) {
  throw new UnauthorizedError("Not authenticated");
}
```

No unnecessary try/catch blocks were added. Errors propagate naturally.

---

### 4. Interface Changes

**Status:** ⚠️ NEEDS DOCUMENTATION

**Breaking Changes Identified:**

1. **Authentication Header Change:**
   - Old: `x-api-key: <api-key>`
   - New: `Authorization: Bearer <token>`

2. **Database Schema Changes:**
   - `agent_configs.api_key_id` removed → `agent_configs.user_id` added
   - `agent_runtimes.user_id` added
   - `api_keys` table dropped

3. **New Interfaces:**
   ```typescript
   // CreateRuntimeOptions now includes sandboxToken
   interface CreateRuntimeOptions {
     agentConfigId: string;
     prompt: string;
     dynamicVars?: Record<string, string>;
     sandboxToken: string; // NEW
   }
   ```

4. **E2B Environment Variables Changed:**
   - Removed: `VM0_WEBHOOK_TOKEN`
   - Added: `VM0_TOKEN` (bearer token)
   - Added: `VM0_API_URL`

**Recommendations:**
- Migration guide needed for existing API consumers
- Document the token expiration policy (2 hours for sandbox tokens)
- Update API documentation with new authentication requirements

---

### 5. Timer and Delay Analysis

**Status:** ✅ PASS

No fake timers, artificial delays, or timer manipulations were added. The 2-hour timeout in `sandbox-token.ts` is a legitimate configuration value, not an artificial delay in tests:

```typescript
const expiresAt = new Date(now.getTime() + 2 * 60 * 60 * 1000); // 2 hours
```

---

### 6. Prohibition of Dynamic Imports

**Status:** ✅ PASS

All imports in new and modified files are static. Example from `sandbox-token.ts`:

```typescript
import { randomBytes } from "crypto";
import { initServices } from "../init-services";
import { cliTokens } from "../../db/schema/cli-tokens";
import { eq, and, lt } from "drizzle-orm";
```

No dynamic `import()` statements found.

---

### 7. Database and Service Mocking in Web Tests

**Status:** N/A - Tests Removed

This smell would have been checked against the deleted test files. The removed tests appear to have been using real database connections (good), but since they're deleted, there's no new code to review for this smell.

---

### 8. Test Mock Cleanup

**Status:** N/A - Tests Removed

No test files remain to check for `vi.clearAllMocks()` usage.

---

### 9. TypeScript `any` Type Usage

**Status:** ✅ PASS

No `any` types were introduced. All new code uses proper TypeScript typing:

```typescript
export async function generateSandboxToken(
  userId: string,
  runtimeId: string,
): Promise<string> { ... }

private async createSandbox(
  envVars: Record<string, string>,
): Promise<Sandbox> { ... }
```

---

### 10. Artificial Delays in Tests

**Status:** N/A - Tests Removed

No test files with artificial delays were added.

---

### 11. Hardcoded URLs and Configuration

**Status:** ✅ PASS

The code correctly uses environment variables with appropriate fallbacks for development:

```typescript
const apiUrl = globalThis.services?.env?.VM0_API_URL || "http://localhost:3000";
```

The localhost fallback is acceptable for development environments.

---

### 12. Direct Database Operations in Tests

**Status:** N/A - Tests Removed

The deleted test files did contain direct database operations (violating this principle), but no new tests were added that we could review.

Example of deleted bad pattern:
```typescript
// From deleted test - direct DB operations
const [insertedKey] = await globalThis.services.db
  .insert(apiKeys)
  .values({ keyHash: hashApiKey(testApiKey), name: "Test API Key" })
  .returning({ id: apiKeys.id });
```

---

### 13. Avoid Fallback Patterns - Fail Fast

**Status:** ✅ PASS

The code properly fails fast when authentication is missing:

```typescript
const userId = await getUserId();
if (!userId) {
  throw new UnauthorizedError("Not authenticated");
}
```

No silent fallbacks or recovery logic that would hide configuration issues.

---

### 14. Prohibition of Lint/Type Suppressions

**Status:** ✅ PASS

No lint or type suppression comments were added:
- No `// eslint-disable`
- No `// @ts-ignore`
- No `// @ts-nocheck`
- No `// @ts-expect-error`

---

### 15. Avoid Bad Tests

**Status:** ⚠️ PREVIOUS ISSUES REMOVED

The deleted test files contained several bad patterns that are now gone (which is good):

**Bad Patterns That Were Removed:**

1. **Over-testing error responses:**
   ```typescript
   // Deleted - was testing every HTTP status code
   it("should return 401 when API key is missing", async () => {
     expect(response.status).toBe(401);
   });

   it("should return 401 when API key is invalid", async () => {
     expect(response.status).toBe(401);
   });

   it("should return 400 when config is missing", async () => {
     expect(response.status).toBe(400);
   });
   ```

2. **Direct database operations in tests:**
   ```typescript
   // Deleted - was using direct DB instead of APIs
   const [insertedKey] = await globalThis.services.db
     .insert(apiKeys)
     .values({ ... })
   ```

While removing bad tests is positive, the complete absence of replacement tests is concerning.

---

## Additional Observations

### Positive Aspects

1. **Significant Code Reduction:** Net reduction of 1,215 lines indicates good cleanup
2. **Better Security Model:** Bearer tokens with OAuth 2.0 device flow is more secure than API keys
3. **Resource Ownership:** Webhook validation now properly checks resource ownership
4. **Clean Deletions:** Completely removed deprecated API key infrastructure
5. **Database Migrations:** Proper migrations with placeholder defaults for existing data
6. **Static Imports:** All new code uses static imports correctly

### Concerns

1. **Test Coverage Gap:** Most critical issue - no tests for new authentication system
2. **Sandbox Token Lifecycle:** Token cleanup happens on creation, but no background cleanup job
3. **Token Expiration:** 2-hour expiration for sandbox tokens may be too long or too short depending on use case
4. **Migration Path:** No backward compatibility or transition period for existing API consumers
5. **E2B Environment Variables:** Changed from `VM0_WEBHOOK_TOKEN` to `VM0_TOKEN` may break existing sandboxes

---

## Recommendations

### Critical (Must Fix)

1. **Add Test Coverage:**
   - Write integration tests for bearer token authentication
   - Test sandbox token generation and expiration
   - Test resource ownership validation in webhook endpoint
   - Test E2B service with new token passing

2. **Token Lifecycle Management:**
   - Add background job to clean up expired tokens (not just on-demand)
   - Consider adding token revocation endpoint
   - Add monitoring for token creation/usage

### Important (Should Fix)

3. **Documentation:**
   - Create migration guide for API consumers
   - Document new authentication flow
   - Update API documentation with examples
   - Document sandbox token expiration policy

4. **Error Messages:**
   - Add more descriptive error messages (e.g., "Token expired" vs "Not authenticated")
   - Include token expiration time in error responses

### Nice to Have

5. **Token Configuration:**
   - Make 2-hour expiration configurable via environment variable
   - Add ability to specify custom expiration per sandbox

6. **Logging:**
   - Add structured logging for authentication events
   - Log token usage for security audit trail

---

## Overall Assessment

**Status: ⚠️ NEEDS WORK**

### Scoring

| Category | Status | Score |
|----------|--------|-------|
| Code Quality | ✅ Pass | 9/10 |
| Security | ✅ Pass | 9/10 |
| Architecture | ✅ Pass | 8/10 |
| **Test Coverage** | ❌ **Fail** | **0/10** |
| Documentation | ⚠️ Needs Work | 5/10 |
| Error Handling | ✅ Pass | 9/10 |
| **Overall** | **⚠️ NEEDS WORK** | **6.7/10** |

### Summary

The code changes are architecturally sound and follow best practices for authentication. The migration from API keys to bearer tokens is well-executed with proper error handling, type safety, and clean code deletion. The implementation correctly uses static imports, fails fast, and avoids unnecessary complexity.

**However, the complete removal of 1,180+ lines of tests without replacement is a critical issue that prevents this commit from being production-ready.** While some deleted tests had bad patterns (over-testing error codes, direct DB operations), the new authentication system has zero test coverage.

### Verdict

**NEEDS WORK** - Cannot approve for production until:

1. ✅ Test coverage is added for new authentication system (CRITICAL)
2. ⚠️ Migration documentation is created (IMPORTANT)
3. ⚠️ Background token cleanup job is implemented (IMPORTANT)

The commit represents good technical work but is incomplete without tests. Recommend holding PR merge until test coverage is added.

---

## Action Items

### For Developer

- [ ] Add integration tests for bearer token authentication
- [ ] Add unit tests for `generateSandboxToken()` function
- [ ] Add tests for resource ownership validation
- [ ] Create migration guide for API consumers
- [ ] Implement background job for token cleanup
- [ ] Document token expiration policy

### For Reviewer

- [ ] Verify test coverage meets project standards before approving
- [ ] Review migration strategy with team
- [ ] Confirm token expiration times are appropriate
- [ ] Check for any missed API consumers that need updates

---

**Review Completed:** 2025-11-20
**Reviewer:** Claude Code
**Next Review:** After test coverage is added
