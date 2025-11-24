# Review: feat: add validation for environment and template variables before execution

**Commit:** a197eba
**Author:** Lan Chenyu <lancy@vm0.ai>
**Date:** Sun Nov 23 22:33:28 2025 +0800

## Summary

This comprehensive commit adds a validation system to catch missing environment and template variables early, preventing runtime failures. The implementation spans both CLI and backend API:

**CLI changes:**

- `extractEnvVarReferences()` scans config for `${VAR}` patterns
- `validateEnvVars()` checks if variables exist in process.env
- Integration into build command with clear error messages
- 17 comprehensive test cases for extraction and validation

**Backend changes:**

- `extractUnexpandedVars()` detects remaining `${VAR}` in configs
- `extractTemplateVars()` scans for `{{VAR}}` patterns
- Validation in POST `/api/agent/configs` for unexpanded vars
- Validation in POST `/api/agent/runs` for template vars
- Return 400 errors with clear messages for missing variables

**Files affected:** 13 files changed, 449 insertions(+), 27 deletions(-)

- New files: `vm0-test-env-with-token.yaml`, `vm0-test-env-without-token.yaml`, `config-validator.ts`, `t01-validation.bats`
- Modified: build.ts, api-client.ts, env-expander.ts, event-renderer.ts, configs/route.ts, runs/route.ts, and test files

## Code Smell Analysis

### ✅ Good Practices

- **Early validation**: Catches configuration errors at build/run time rather than runtime, improving user experience
- **Comprehensive test coverage**: 17 CLI tests + 6 e2e tests covering various scenarios (single/multiple variables, nested objects, arrays, edge cases)
- **Clear error messages**: Provides specific, actionable feedback to users listing missing variables
- **Fail-fast approach**: Returns 400 errors immediately when validation fails instead of attempting workarounds
- **Type-safe implementation**: Uses proper regex matching with null checks for match groups
- **Separation of concerns**: Validation logic properly isolated in dedicated functions
- **Consistent error handling**: API error structure properly documented and used throughout (error.error.message)
- **Real async testing**: E2e tests properly handle async operations without artificial delays

### ⚠️ Issues Found

**1. Potential ESLint Violation in Test - Line 143 of env-expander.test.ts**

- **Issue**: Comment `// eslint-disable-next-line turbo/no-undeclared-env-vars` appears in test
- **Category**: #14 - Prohibition of Lint/Type Suppressions
- **Details**: The test file contains an eslint-disable comment instead of properly declaring the test environment variable
- **Location**: `/workspaces/vm01/turbo/apps/cli/src/lib/__tests__/env-expander.test.ts` line 143
- **Severity**: Medium - Violates zero-tolerance suppression policy

**2. Artificial Delay in Test - Line 218 of runs/route.test.ts**

- **Issue**: `await new Promise((resolve) => setTimeout(resolve, 500))` artificial delay introduced
- **Category**: #10 - Artificial Delays in Tests
- **Details**: While the commit message explains this is for CI timing, artificial delays mask real async issues
- **Location**: `/workspaces/vm01/turbo/apps/web/app/api/agent/runs/__tests__/route.test.ts` line 218
- **Severity**: Low-Medium - Better to use proper event-based waits or proper async/await patterns

### 💡 Recommendations

**Critical - Fix ESLint Suppression:**
The eslint-disable comment must be removed and either:

1. Properly declare the environment variable in the test setup, or
2. Use a fixture/helper that manages test environment variables properly

**Address Artificial Delay:**
Replace the artificial setTimeout delay with proper async/await patterns:

```typescript
// Instead of:
await new Promise((resolve) => setTimeout(resolve, 500));

// Consider using a proper async helper that waits for a specific condition:
await waitFor(() => {
  // Verify the async operation completed
});
```

**Process Recommendation:**
Before merging, ensure:

1. ESLint suppression is removed and replaced with proper environment setup
2. Artificial delay is replaced with event-based or condition-based waiting
3. Run full lint/type check: `cd turbo && pnpm turbo run lint`

## Breaking Changes

**API Changes - New Validation Behavior:**

1. **POST /api/agent/configs**
   - Now validates that no unexpanded environment variables (`${VAR}`) remain in config
   - Returns 400 error if validation fails: `"Configuration contains unexpanded environment variables: VAR1, VAR2"`

2. **POST /api/agent/runs**
   - Now validates that all template variables (`{{VAR}}`) are provided in `dynamicVars`
   - Returns 400 error if validation fails: `"Missing required template variables: VAR1, VAR2"`

**Impact:**

- Clients must ensure environment variables are properly expanded before config creation
- Clients must provide all required template variables when creating runs
- This is a **non-breaking** change in the sense that it catches errors earlier, but clients need to handle new 400 error responses

**CLI Changes:**

- `vm0 build` now validates environment variables and fails early with clear error messages
- This prevents silent failures during expansion, improving user experience
