# Code Review: e2af8ff

**Commit**: e2af8ff4c7ef2556fe2938d18623f09c6800cfa5
**Title**: fix: enable e2b build scripts to read e2b api key from .env.local (#88)
**Author**: Lan Chenyu
**Date**: 2025-11-19

## Overview

Adds dotenv configuration to E2B build scripts to enable reading E2B_API_KEY from `.env.local` file.

## Files Changed

- `/e2b/README.md`
- `/e2b/build.dev.ts`
- `/e2b/build.prod.ts`
- `/e2b/package-lock.json`
- `/turbo/package.json`

## Bad Smell Analysis

### ⚠️ ISSUE: Hardcoded URLs and Configuration (Bad Smell #11)

**build.dev.ts:5, build.prod.ts:5**

```typescript
config({ path: resolve(process.cwd(), "apps/web/.env.local") });
```

**Problems**:

1. Hardcoded relative path to `.env.local`
2. Assumes script runs from `turbo/` directory
3. Breaks if run from different directory
4. Not portable across environments

**Recommendation**:

```typescript
// Option 1: Check multiple locations
const envPath = resolve(process.cwd(), "apps/web/.env.local");
if (!existsSync(envPath)) {
  throw new Error(`Configuration file not found: ${envPath}`);
}
config({ path: envPath });

// Option 2: Use environment variable for config path
const envPath =
  process.env.ENV_FILE_PATH || resolve(process.cwd(), "apps/web/.env.local");
config({ path: envPath });
```

### ⚠️ ISSUE: Avoid Fallback Patterns (Bad Smell #13)

**build.dev.ts:4-5, build.prod.ts:4-5**

**Problem**: dotenv `config()` silently continues if file is missing

- If `.env.local` doesn't exist, script continues without error
- Later fails with cryptic "E2B_API_KEY not found" error
- This is a silent fallback that hides misconfiguration

**Recommendation**: Fail fast with clear error

```typescript
import { existsSync } from "fs";

const envPath = resolve(process.cwd(), "apps/web/.env.local");

// Check file exists before loading
if (!existsSync(envPath)) {
  throw new Error(
    `E2B_API_KEY configuration file not found at: ${envPath}\n` +
      `Please create apps/web/.env.local with E2B_API_KEY`,
  );
}

config({ path: envPath });

// Verify key was loaded
if (!process.env.E2B_API_KEY) {
  throw new Error(
    `E2B_API_KEY not found in ${envPath}\n` +
      `Please add: E2B_API_KEY=your_key_here`,
  );
}
```

### ✅ GOOD: Dependencies

- Properly added dotenv as dependency
- package-lock.json shows correct installation

### ✅ PASS: All Other Bad Smells

- No dynamic imports
- No type issues (TypeScript files)
- No mocking issues
- No artificial delays
- No suppressions

## Recommendations

### 1. HIGH: Add File Existence Check

**Files**: `build.dev.ts:5`, `build.prod.ts:5`
**Action**: Verify `.env.local` exists before loading
**Benefit**: Clear error message instead of cryptic failure

### 2. HIGH: Verify Environment Variable After Load

**Action**: Check that `E2B_API_KEY` exists after dotenv config
**Benefit**: Fail fast if configuration is incomplete

### 3. MEDIUM: Document Working Directory Requirement

**Files**: `e2b/README.md`
**Action**: Clearly document that scripts must be run from `turbo/` directory
**Alternative**: Make scripts work from any directory

### 4. LOW: Consider Environment-Aware Path Resolution

**Action**: Use environment variable for config path
**Benefit**: More flexible, works in different environments

## Example Improved Implementation

```typescript
import { config } from "dotenv";
import { resolve } from "path";
import { existsSync } from "fs";

// Determine config file path (support multiple locations)
const envPath =
  process.env.ENV_FILE_PATH || resolve(process.cwd(), "apps/web/.env.local");

// Check file exists
if (!existsSync(envPath)) {
  console.error(`ERROR: E2B_API_KEY configuration file not found`);
  console.error(`Expected location: ${envPath}`);
  console.error(`\nPlease:`);
  console.error(`  1. Create apps/web/.env.local`);
  console.error(`  2. Add: E2B_API_KEY=your_key_here`);
  console.error(`  3. Run from turbo/ directory`);
  process.exit(1);
}

// Load environment variables
config({ path: envPath });

// Verify E2B_API_KEY was loaded
if (!process.env.E2B_API_KEY) {
  console.error(`ERROR: E2B_API_KEY not found in ${envPath}`);
  console.error(`\nPlease add to ${envPath}:`);
  console.error(`  E2B_API_KEY=your_key_here`);
  process.exit(1);
}

// Continue with build...
```

## Overall Assessment

**Grade**: C+ (Functional but Needs Improvement)

**Severity**: Medium

The changes work but lack proper validation and error handling. Silent failures make debugging difficult.

## Issues Summary

### Issue 1: Hardcoded Path ⚠️

- **Violation**: Bad Smell #11
- **Severity**: MEDIUM
- **Impact**: Fragile, breaks if run from wrong directory

### Issue 2: Silent Fallback ⚠️

- **Violation**: Bad Smell #13 (Avoid Fallback Patterns)
- **Severity**: MEDIUM
- **Impact**: Cryptic error messages, hard to debug

### Issue 3: Missing Validation ⚠️

- **Severity**: MEDIUM
- **Impact**: No verification that configuration loaded successfully

## Required Actions

1. ⚠️ Add file existence check before loading
2. ⚠️ Verify E2B_API_KEY exists after loading
3. ⚠️ Fail fast with clear error messages
4. ⚠️ Document working directory requirement

## Impact

**Mixed**: Improves developer experience (can use .env.local) but introduces fragility. Needs validation and error handling improvements to meet project quality standards.
