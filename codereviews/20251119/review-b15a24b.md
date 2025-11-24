# Code Review: b15a24b

**Commit**: b15a24bfc5b279b16c4bc07471aa7aca84c0e5a3
**Title**: test: replace e2b service real api with mocked sdk in unit tests (#86)
**Author**: Lan Chenyu
**Date**: 2025-11-19

## Overview

Converts E2B service integration tests to mocked unit tests by mocking the entire E2B SDK.

## Files Changed

- `/turbo/apps/web/src/lib/e2b/__tests__/e2b-service.test.ts`

## Bad Smell Analysis

### ❌ CRITICAL: Mock Analysis (Bad Smell #1)

**turbo/apps/web/src/lib/e2b/**tests**/e2b-service.test.ts:10**

```typescript
vi.mock("@e2b/code-interpreter");
```

**VIOLATION**: Converts integration tests into fake tests

**Issues**:

1. Mocks entire E2B SDK module
2. Lines 21-30: Creates mock sandbox with mocked methods
3. Lines 37-40: Mocks `Sandbox.create` to return mock sandbox
4. Tests no longer verify real E2B SDK integration works

**Problems**:

- Tests pass while real code could be broken
- Mock behavior may not match real E2B SDK
- Lost confidence in E2B integration
- This is **exactly** what Bad Smell #15 defines as "fake tests"

### ❌ CRITICAL: Over-Mocking (Bad Smell #15)

**Examples throughout file**:

- Lines 81-82: Tests mock was called, not real behavior
  ```typescript
  expect(mockSandbox.commands.run).toHaveBeenCalledTimes(1);
  expect(mockSandbox.kill).toHaveBeenCalledTimes(1);
  ```
- Lines 133-138: Testing mock creation count
- Lines 218-223: Testing mock cleanup was called

**Assessment**: These are "fake tests" that verify mocks, not real functionality.

### ❌ CRITICAL: Testing Mock Behavior (Bad Smell #15)

Tests throughout the file verify that mocks were called correctly instead of testing actual E2B SDK integration:

**Examples**:

- Line 81: `expect(mockSandbox.commands.run).toHaveBeenCalledTimes(1)`
- Line 82: `expect(mockSandbox.kill).toHaveBeenCalledTimes(1)`
- Line 135: Testing mock creation count
- Line 222: Testing cleanup was called

**Problem**: These tests provide **zero confidence** that:

- Real E2B SDK API works correctly
- Real sandbox creation succeeds
- Real command execution functions properly
- Real cleanup logic works

### ✅ GOOD: Test Mock Cleanup (Bad Smell #8)

Line 14: Properly implements `vi.clearAllMocks()` in `beforeEach`

### ⚠️ LOSS OF VALUE: Integration Test Conversion

**Before this commit**:

- Tests used real E2B API
- Provided confidence in actual integration
- Caught real timing expectations (600s → fast response)

**After this commit**:

- Tests use mocks exclusively
- No confidence in E2B integration
- Won't catch E2B SDK API changes
- Won't catch real integration failures

## Recommendations

### 1. CRITICAL: Revert This Commit

**Action**: Keep integration tests with real E2B API
**Reason**: Real API tests provide valuable confidence that mocks cannot

### 2. ALTERNATIVE: Separate Test Types

If unit tests are desired:

- Create `e2b-service.unit.test.ts` for fast unit tests with mocks
- Keep `e2b-service.test.ts` as integration tests with real E2B API
- Run integration tests less frequently (nightly builds)
- Both test types serve different purposes

### 3. Use MSW for HTTP Mocking

If mocking is needed:

- Mock only the HTTP webhook calls using MSW
- Don't mock the E2B SDK itself
- Keep E2B SDK integration real

## Overall Assessment

**Grade**: F (Fails Code Quality Standards)

**Severity**: CRITICAL

This commit converts valuable integration tests into worthless fake tests. The tests will pass even when:

- E2B SDK API changes break integration
- Real sandbox creation fails
- Real command execution has bugs
- Real cleanup logic is broken

## Critical Issues

### Issue 1: Fake Tests ❌

- **Violation**: Bad Smell #15 "Avoid Bad Tests" - Fake tests
- **Severity**: CRITICAL
- **Impact**: Zero confidence in E2B integration

### Issue 2: Over-Mocking ❌

- **Violation**: Bad Smell #1 "Mock Analysis" and Bad Smell #15
- **Severity**: CRITICAL
- **Impact**: Tests verify mocks, not real code

### Issue 3: Lost Integration Coverage ❌

- **Impact**: No longer testing actual E2B SDK integration
- **Severity**: CRITICAL
- **Risk**: Integration bugs will not be caught

## Required Actions

**Option 1** (RECOMMENDED): Revert this commit

- Keep integration tests with real E2B API
- Integration tests are valuable even if slower

**Option 2**: Separate test types

- Create separate unit test file with mocks
- Keep integration tests as separate file
- Document when to run each type

**Option 3**: Mock only external HTTP

- Use MSW to mock webhook HTTP calls only
- Keep E2B SDK integration real
- Best of both worlds: fast tests with real integration

## Impact

**Negative**: Significantly reduces test value and confidence. Violates multiple bad smell criteria. Requires immediate revision.

## Quote from Bad Smell #15

> "Fake tests - Tests that don't actually execute the code under test, but instead test mock implementations. These tests may pass while the real code is broken."

This commit is a textbook example of this anti-pattern.
