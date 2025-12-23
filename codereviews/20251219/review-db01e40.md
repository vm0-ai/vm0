# Review: db01e40 - feat(cli): add status command for volume and artifact

## Summary
This commit adds `vm0 artifact status` and `vm0 volume status` commands that check the remote storage status and display version information.

## Files Changed
- `turbo/apps/cli/src/commands/artifact/index.ts` - Register status command
- `turbo/apps/cli/src/commands/artifact/status.ts` - Artifact status implementation
- `turbo/apps/cli/src/commands/volume/index.ts` - Register status command
- `turbo/apps/cli/src/commands/volume/status.ts` - Volume status implementation
- `turbo/apps/cli/src/commands/__tests__/artifact-status.test.ts` - Unit tests
- `turbo/apps/cli/src/commands/__tests__/volume-status.test.ts` - Unit tests

## Bad Smell Analysis

### 1. Mock Analysis
**New mocks identified:**
- `vi.mock("../../lib/storage-utils")` - Mocks storage config reading
- `vi.mock("../../lib/api-client")` - Mocks API client

**Assessment:** These mocks are appropriate for CLI unit tests since:
- `storage-utils` reads from filesystem (external I/O)
- `api-client` makes network requests (external service)

This follows the guideline of "Only mock external services, network calls, or slow operations."

### 2. Test Coverage
**Test scenarios covered:**
- No config exists (suggests init)
- Wrong type config (suggests other command)
- Remote returns 404 (suggests push)
- Remote exists with files
- Remote exists but empty
- API error (500)
- Network error

**Assessment:** Good coverage of happy paths and error cases. Tests verify actual behavior (console output messages) rather than just mock calls.

### 3. Error Handling
**Pattern used:**
```typescript
try {
  // ... operations
} catch (error) {
  console.error(chalk.red("✗ Status check failed"));
  if (error instanceof Error) {
    console.error(chalk.gray(`  ${error.message}`));
  }
  process.exit(1);
}
```

**Assessment:** The try/catch here is appropriate because:
- It's a CLI entry point that needs to display user-friendly errors
- It properly exits with error code 1
- It doesn't suppress errors silently - it displays them

### 4. Interface Changes
**New public interfaces:**
- `vm0 artifact status` command
- `vm0 volume status` command

**Assessment:** No breaking changes. These are new additive commands.

### 5. Timer and Delay Analysis
**Assessment:** No timers or delays found. No fakeTimers in tests.

### 6. Dynamic Imports
**Assessment:** All imports are static. No dynamic imports.

### 7. Database Mocking
**Assessment:** N/A - This is CLI code, not web app code. CLI tests appropriately mock external services.

### 8. Test Mock Cleanup
**Assessment:** Tests include `vi.clearAllMocks()` in `beforeEach`. However, there's also `mockClear()` in `afterEach` which is redundant but not harmful.

### 9. TypeScript `any` Usage
**Assessment:** No `any` types found. Proper interfaces defined (`StatusResponse`, `ApiError`).

### 10. Artificial Delays
**Assessment:** No artificial delays in tests.

### 11. Hardcoded URLs
**Assessment:** API path `/api/storages/download` is hardcoded but this is an internal API route, not an environment-specific URL. This is acceptable.

### 12. Direct Database Operations
**Assessment:** N/A - This is CLI code, not test code for web app.

### 13. Fail Fast Pattern
**Assessment:** Code follows fail-fast pattern:
- Checks config first, exits immediately if missing
- Checks config type, exits immediately if wrong
- Handles 404 as explicit "not found" case

### 14. Lint/Type Suppressions
**Assessment:** No suppression comments found.

### 15. Test Quality
**Potential concern:** Console mocking
- Tests mock `console.log` and `console.error` and DO assert on their content
- This is the correct approach per bad-smell.md guidelines

**Assessment:** Tests verify actual console output messages, not just that mocks were called. This is good practice.

## Code Duplication Note
The `artifact/status.ts` and `volume/status.ts` files are nearly identical, differing only in:
- Type check (`artifact` vs `volume`)
- Error messages referencing the type name

This could potentially be refactored into a shared utility, but given YAGNI principle and the small size of these files (~90 lines each), the current approach is acceptable. It matches the existing pattern used by `init`, `push`, and `pull` commands.

## Verdict
**APPROVED** - No bad code smells detected. The implementation follows project patterns and guidelines.
