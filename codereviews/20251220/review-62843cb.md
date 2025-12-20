# Code Review: 62843cb

## Commit Info
- **Message**: feat(web): add community edition support for self-hosting
- **Files Changed**: 11 files (+355, -142 lines)

## Summary
This commit implements Community Edition mode for VM0, enabling self-hosting without Clerk authentication.

## Issues Found

### Critical: Dynamic Imports Violation (Bad Smell #6)

**Location**: Multiple files

The project's bad smell guidelines have **ZERO tolerance for dynamic imports** in production code. This commit introduces several dynamic imports:

1. **middleware.ts:19-21**
   ```typescript
   const { clerkMiddleware, createRouteMatcher } = await import(
     "@clerk/nextjs/server"
   );
   ```

2. **get-user-id.ts:93-94**
   ```typescript
   const { auth } = await import("@clerk/nextjs/server");
   ```

3. **app/api/auth/me/route.ts:35**
   ```typescript
   const { clerkClient } = await import("@clerk/nextjs/server");
   ```

**Why this is problematic according to bad-smell.md:**
- Breaks tree-shaking and bundle optimization
- Adds unnecessary async complexity
- Makes dependency analysis harder
- Hides import errors until runtime

**However, this appears to be a justified exception:**
The dynamic imports are necessary to prevent build failures when Clerk dependencies are not available in Community Edition. This is a case of "truly optional dependencies that may not exist" mentioned as a rare exception in the guidelines.

**Recommendation**: Add code comments explaining why dynamic imports are necessary here to document this justified exception.

## Test Analysis

### New Tests Added
- `edition.test.ts`: 10 tests covering `getEdition()`, `isCommunityEdition()`, `isCloudEdition()`

### Test Quality
- Tests properly use `beforeEach`/`afterEach` for environment cleanup
- Uses `vi.resetModules()` to ensure clean state
- Tests cover default values, valid values, and invalid values
- **Good**: Tests call `vi.clearAllMocks()` is not needed here as there are no mocks

### Missing Test Coverage
- `clerk-config.ts` changes have no tests
- No integration tests for middleware behavior changes

## Code Quality

### Positive Aspects
1. Clean separation with `edition.ts` helper functions
2. Good use of conditional logic in layout.tsx with `LayoutContent` component extraction
3. Environment variable validation with Zod schema
4. Added to `turbo.json` globalEnv for proper cache invalidation

### Minor Issues
1. **Layout refactoring creates duplication avoidance**: The `LayoutContent` component extraction is a good pattern to avoid code duplication between Cloud and Community modes.

2. **sign-in/sign-up pages**: The redirect logic is simple and correct.

## Interface Changes
- New environment variables: `VM0_EDITION`, `VM0_COMMUNITY_AUTH_TOKEN`
- `CLERK_SECRET_KEY` and `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` are now optional
- New public functions: `getEdition()`, `isCommunityEdition()`, `isCloudEdition()`

## Verdict

**APPROVE with comments**

The dynamic imports are a justified exception for supporting optional Clerk dependency in Community Edition. The implementation is clean and well-organized. Recommend adding comments to document why dynamic imports are used.
