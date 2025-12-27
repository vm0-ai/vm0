# Review: ebef5f23 - refactor(web): convert storage routes to ts-rest pattern

## Summary
This commit converts storage API routes from inline types (Pattern B) to ts-rest contracts (Pattern A), including CLI and webhook endpoints. Tests were updated to use `NextRequest` (required by ts-rest) and fix hash values to match SHA-256 validation (64 chars).

## Files Changed
- `turbo/apps/web/app/api/storages/prepare/route.ts` - Converted to ts-rest
- `turbo/apps/web/app/api/storages/commit/route.ts` - Converted to ts-rest
- `turbo/apps/web/app/api/storages/download/route.ts` - Converted to ts-rest
- `turbo/apps/web/app/api/webhooks/agent/storages/prepare/route.ts` - Converted to ts-rest
- `turbo/apps/web/app/api/webhooks/agent/storages/commit/route.ts` - Converted to ts-rest
- `turbo/apps/web/app/api/storages/*/__tests__/route.test.ts` - Test updates

## Analysis

### 1. Mock Analysis
**Existing mocks only** - Tests use appropriate mocks for:
- `getUserId` - Auth mocking
- `generatePresignedPutUrl`/`generatePresignedUrl` - S3 URL generation
- `s3ObjectExists`, `verifyS3FilesExist` - S3 verification
- `downloadManifest` - Manifest retrieval

**Assessment:** These mocks are appropriate for isolating external dependencies (S3, auth). Tests use real database connections per project guidelines.

### 2. Test Coverage
Tests cover:
- Authentication (401 scenarios)
- Validation (400 scenarios - missing fields, invalid types)
- Not found (404 scenarios)
- Business logic (version creation, deduplication, HEAD updates)
- Edge cases (empty artifacts, S3 files missing, concurrent commits)

**Assessment:** Good coverage with meaningful tests. Tests verify actual behavior, not just status codes.

### 3. Error Handling
**Pattern used:** Custom `errorHandler` function for each route

```typescript
function errorHandler(err: unknown): TsRestResponse | void {
  if (err && typeof err === "object" && "bodyError" in err && "queryError" in err) {
    // Handle Zod validation errors
    ...
  }
  // Log and return generic error
  log.error("...", err);
  return TsRestResponse.fromJson({...}, { status: 500 });
}
```

**Assessment:**
- Appropriate error handler that converts Zod validation errors to API format
- Falls back to 500 for unexpected errors
- Logs errors for debugging

### 4. Interface Changes
**Breaking changes: None** - The API surface remains identical, only the implementation pattern changed:
- Same HTTP methods
- Same request/response shapes
- Same status codes

### 5. Timer and Delay Analysis
**None** - No timers, delays, or fake timers in the code.

### 6. Dynamic Imports
**Tests use dynamic imports** - Tests use `await import("../route")` pattern:
```typescript
const { POST } = await import("../route");
```

**Assessment:** This is acceptable for tests because:
1. It allows tests to import after mocks are set up
2. It's the standard pattern for testing Next.js API routes
3. Not prohibited by project guidelines (which focus on production code)

### 7. Database/Service Mocking
**Good:** Tests do NOT mock `globalThis.services`. They use real database connections as required by project guidelines.

### 8. Test Mock Cleanup
**Good:** All test files call `vi.clearAllMocks()` in `beforeEach` hooks.

### 9. TypeScript Types
**Good:** No `any` types introduced. Proper type narrowing used throughout:
```typescript
const validationError = err as {
  bodyError: { issues: Array<{ path: string[]; message: string }> } | null;
  queryError: { issues: Array<{ path: string[]; message: string }> } | null;
};
```

### 10. Lint/Type Suppressions
**Good:** No `eslint-disable`, `@ts-ignore`, or other suppression comments.

## Observations

### Positives
1. Consistent pattern across all converted routes
2. Tests properly updated to work with ts-rest (NextRequest, 64-char hashes)
3. Good separation between CLI and webhook authentication patterns
4. Defense-in-depth S3 verification maintained

### Code Patterns
The conversion follows a consistent pattern:
```typescript
import { createHandler, tsr, TsRestResponse } from "...";
import { someContract } from "@vm0/core";

const router = tsr.router(someContract, {
  methodName: async ({ body/query }) => {
    // Business logic
    return { status: 200 as const, body: {...} };
  },
});

function errorHandler(err: unknown): TsRestResponse | void { ... }

const handler = createHandler(someContract, router, { errorHandler });
export { handler as POST/GET };
```

### Minor Notes
1. Tests still include some error status tests (401, 400, 404) - acceptable since they verify the route integration works correctly
2. Some test hash values changed from short strings to 64-char strings to match schema validation

## Verdict
**APPROVED** - Clean conversion to ts-rest pattern with no regressions. Tests properly updated. Follows project coding standards.
