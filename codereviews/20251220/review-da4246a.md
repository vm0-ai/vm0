# Code Review: da4246a

## Commit Info
- **Message**: test(web): add community edition auth tests for getUserId
- **Files Changed**: 1 file (+113, -16 lines)

## Summary
This commit adds comprehensive unit tests for Community Edition authentication in `getUserId()`.

## Test Analysis

### New Tests Added (6 tests)
1. **Token-protected mode** (`VM0_COMMUNITY_AUTH_TOKEN` configured):
   - Token matches -> returns "community_edition"
   - Token mismatch -> returns null
   - Missing Authorization header -> returns null
   - Wrong format (Basic instead of Bearer) -> returns null

2. **Open access mode** (no token configured):
   - No auth header -> returns "community_edition"
   - Random auth header -> returns "community_edition"

### Test Quality Assessment

**Positive:**
- Uses `vi.clearAllMocks()` in `beforeEach` (compliant with Bad Smell #8)
- Proper environment variable cleanup with `afterEach`
- Tests verify Clerk auth is NOT called in Community Edition mode
- Good use of nested `describe` blocks for organization

**Concerns:**

1. **Mocking `isCommunityEdition`** (potential Bad Smell #15 - over-mocking)
   The test mocks the `edition` module:
   ```typescript
   vi.mock("../../edition");
   const mockIsCommunityEdition = vi.mocked(editionModule.isCommunityEdition);
   ```

   This is acceptable because:
   - It allows testing both Cloud and Community paths in the same test file
   - The `edition` module itself has its own dedicated tests
   - The mock is simple and predictable

2. **Tests verify mock was NOT called**
   ```typescript
   expect(mockAuth).not.toHaveBeenCalled();
   ```
   This is appropriate here because it verifies that Community Edition doesn't accidentally call Clerk auth.

### Missing Test Scenarios
- No test for empty string token (`VM0_COMMUNITY_AUTH_TOKEN=""`)
- No test for whitespace in token

## Verdict

**APPROVE**

Well-structured tests that cover the critical Community Edition authentication paths. The use of mocking is appropriate and the tests are maintainable.
