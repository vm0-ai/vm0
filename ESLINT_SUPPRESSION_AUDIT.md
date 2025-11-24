# ESLint Suppression Violations Audit

**Audit Date:** 2025-11-24
**Project:** VM0
**Policy:** Zero tolerance for lint/type suppressions (per CLAUDE.md)

## Executive Summary

| Category                | Count | Status      |
| ----------------------- | ----- | ----------- |
| ESLint Suppressions     | 4     | 🔴 Must Fix |
| TypeScript Suppressions | 0     | ✅ Clean    |
| Prettier Suppressions   | 0     | ✅ Clean    |
| OxLint Suppressions     | 0     | ✅ Clean    |

## Violations Found

### 1. `turbo/apps/cli/src/lib/__tests__/env-expander.test.ts`

**Violation Type:** `eslint-disable-next-line turbo/no-undeclared-env-vars`
**Occurrences:** 4

#### Line 15-16

```typescript
// eslint-disable-next-line turbo/no-undeclared-env-vars
process.env.TEST_TOKEN = "secret-token-123";
```

#### Line 17-18

```typescript
// eslint-disable-next-line turbo/no-undeclared-env-vars
process.env.TEST_USER = "testuser";
```

#### Line 19-20

```typescript
// eslint-disable-next-line turbo/no-undeclared-env-vars
process.env.TEST_REGION = "us-east-1";
```

#### Line 319-320

```typescript
// eslint-disable-next-line turbo/no-undeclared-env-vars
process.env.EMPTY_VAR = "";
```

### Root Cause Analysis

The `turbo/no-undeclared-env-vars` rule requires all environment variables to be declared in a centralized configuration. Test files are setting environment variables dynamically without proper declaration, triggering the lint rule.

### Fix Strategy

**Option 1: Declare Test Environment Variables (Recommended)**

- Create a test environment configuration file
- Declare all test environment variables in turbo configuration
- Remove suppression comments

**Option 2: Use Vitest Environment Setup**

- Move environment setup to `vitest.setup.ts`
- Declare variables in test configuration
- Remove suppression comments

**Option 3: Mock process.env Properly**

- Use vitest's `vi.stubEnv()` to mock environment variables
- This approach is type-safe and follows testing best practices
- Remove suppression comments

## Recommended Fix Implementation

### Step 1: Update Test to Use vi.stubEnv()

Replace the current beforeEach with:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("env-expander", () => {
  beforeEach(() => {
    vi.stubEnv("TEST_TOKEN", "secret-token-123");
    vi.stubEnv("TEST_USER", "testuser");
    vi.stubEnv("TEST_REGION", "us-east-1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // ... rest of tests
});
```

### Step 2: Update Line 319-320

Replace:

```typescript
// eslint-disable-next-line turbo/no-undeclared-env-vars
process.env.EMPTY_VAR = "";
const result = validateEnvVars(["EMPTY_VAR", "UNDEFINED_VAR"]);
```

With:

```typescript
vi.stubEnv("EMPTY_VAR", "");
const result = validateEnvVars(["EMPTY_VAR", "UNDEFINED_VAR"]);
```

## Verification Steps

After applying fixes:

1. **Remove all suppression comments**

   ```bash
   # Verify no suppressions remain
   grep -r "eslint-disable" turbo/apps/cli/src/lib/__tests__/env-expander.test.ts
   ```

2. **Run linter**

   ```bash
   cd turbo && pnpm turbo run lint
   ```

3. **Run tests**

   ```bash
   cd turbo && pnpm vitest env-expander.test.ts
   ```

4. **Verify all tests pass**
   ```bash
   cd turbo && pnpm vitest
   ```

## Impact Assessment

- **Files Affected:** 1
- **Lines to Modify:** ~10 lines
- **Breaking Changes:** None
- **Test Impact:** Should pass without modification
- **Risk Level:** Low

## Timeline

- **Estimated Time:** 10-15 minutes
- **Priority:** HIGH (Policy Violation)
- **Blocking:** Yes - should be fixed before next release

## Related Issues

- Commit 8e2ff1d: feat: implement VM0 system events
- Commit a197eba: feat: add validation for environment and template variables
- Code Review: codereviews/20251121/

## Additional Notes

The `vi.stubEnv()` and `vi.unstubAllEnvs()` methods are the recommended way to mock environment variables in Vitest. They provide:

- Type safety
- Automatic cleanup
- Better isolation between tests
- Compliance with linting rules
- No direct mutation of process.env

This approach aligns with the project's principles of avoiding defensive programming and maintaining strict type checking.
