# Code Review: 4842d80

**Commit**: 4842d80f0ce24aec3683ff0e364fc9e22eb24177
**Title**: feat: add support for agent names in vm0 run command (#71)
**Author**: Lan Chenyu
**Date**: 2025-11-19

## Overview

Adds ability to reference agent configs by name in addition to UUID. Users can now run `vm0 run my-agent` instead of requiring a UUID. Includes new API endpoint for name-based lookups.

## Files Changed

- CLI: `build.ts`, `run.ts`, `api-client.ts`
- API: `route.ts` (agent configs endpoint)
- Tests: `build.test.ts`, `run.test.ts`, `get-by-name.test.ts`, `upsert.test.ts`

## Bad Smell Analysis

### ✅ EXCELLENT: Polymorphic Input Handling (Not a Fallback - Bad Smell #13)

**turbo/apps/cli/src/commands/run.ts:47-68**

```typescript
if (isUUID(identifier)) {
  // It's a UUID config ID - use directly
  configId = identifier;
} else {
  // It's an agent name - resolve to config ID
  try {
    const config = await apiClient.getConfigByName(identifier);
    configId = config.id;
  } catch (error) {
    // Error handling
  }
}
```

**Analysis**: This looks like a fallback pattern but is actually **proper polymorphic input handling**:
- Both UUID and name are valid primary use cases
- Not error recovery - both paths are intentional
- Errors fail fast with clear messages
- No silent fallbacks

**Assessment**: ✅ Correct pattern - not a violation

### ✅ EXCELLENT: Test Coverage (Bad Smell #2)

**New test file**: `turbo/apps/web/app/api/agent/configs/__tests__/get-by-name.test.ts`

Comprehensive coverage:
- Success case (retrieve by name)
- Not found case
- Missing parameter validation
- User isolation/security
- URL encoding handling

**Assessment**: High-quality test coverage

### ✅ PASS: Type Safety (Bad Smell #9)
- No `any` types introduced
- Proper interfaces defined (`GetConfigResponse`)
- All types explicit and correct

### ✅ EXCELLENT: Error Handling (Bad Smell #3)

**turbo/apps/cli/src/commands/run.ts:47-68**

- Proper fail-fast error handling
- Clear error messages for users
- No defensive try/catch wrapping
- Errors propagate with context

Example error message:
```typescript
`Agent config not found: ${identifier}`
```

### ✅ PASS: All Other Bad Smells
- No dynamic imports
- No fake timers
- No mocking issues (tests use appropriate mocks)
- No hardcoded URLs
- No lint suppressions
- No bad test patterns

## Recommendations

### 1. Documentation Enhancement
Add to API documentation:
- UUID vs name identifier format
- When to use each format
- Name validation rules (allowed characters)

### 2. Future Enhancement: Name Validation
Consider adding validation for agent name format:
- Character restrictions
- Length limits
- Reserved names

**Note**: Following YAGNI, current implementation without validation is acceptable for initial release.

### 3. Integration Tests
Consider adding E2E test covering full flow:
```bash
vm0 build agent.yaml  # Creates config with name
vm0 run agent-name    # Runs by name
```

## Overall Assessment

**Grade**: A (Excellent)

Clean implementation with comprehensive test coverage. Proper polymorphic input handling (not a fallback pattern). Maintains type safety and fail-fast error handling.

## Key Strengths

1. ✅ Proper polymorphic input handling
2. ✅ Comprehensive test coverage including security tests
3. ✅ Strict type safety maintained
4. ✅ Clear error messages for users
5. ✅ No code smells introduced
6. ✅ Clean separation of concerns

## Impact

**Positive**: Improves user experience significantly by allowing human-readable agent names instead of UUIDs. Implementation is clean and well-tested.
