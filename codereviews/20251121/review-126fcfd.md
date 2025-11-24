# Review: feat: standardize config naming to snake_case for reserved keywords (#135)

**Commit:** 126fcfd
**Author:** Lan Chenyu <lancy@vm0.ai>
**Date:** Fri Nov 21 18:56:21 2025 +0800

## Summary

This commit standardizes configuration naming to use snake_case for reserved keywords, specifically renaming `dynamic-volumes` to `dynamic_volumes` throughout the codebase. This aligns with Docker Compose conventions for reserved keywords.

Key changes:

- Updated type definitions from `"dynamic-volumes"` to `dynamic_volumes`
- Updated volume resolver with validation for deprecated format
- Updated all test cases to use new naming
- Updated example config files
- Added error message for deprecated format with migration instructions

## Code Smell Analysis

### ✅ Good Practices

- Breaking change is clearly marked and documented in commit message
- Proper migration path with helpful error message for users
- Type-safe updates to interfaces
- Good test coverage for deprecated format rejection
- Validation logic properly placed in resolver
- Clear error messaging guides users to fix their configs
- Comments explain the rationale (Docker Compose conventions alignment)

### ⚠️ Issues Found

#### 1. **Acceptable Error Handling Pattern** (Error Handling - Good)

- **File:** `/workspaces/vm01/turbo/apps/web/src/lib/volume/volume-resolver.ts`
- **Lines:** 73-79
- **Issue:** Throws error for deprecated format
  ```typescript
  if ("dynamic-volumes" in config) {
    throw new Error(
      "Configuration error: 'dynamic-volumes' is deprecated. Please use 'dynamic_volumes' instead (snake_case). " +
        "Migration: Simply rename 'dynamic-volumes:' to 'dynamic_volumes:' in your config file.",
    );
  }
  ```
- **Assessment:** ✅ This is appropriate error handling - fails fast with clear user guidance. No issue here.

#### 2. **Type-Safe Interface Update** (Type Safety - Good)

- **File:** `/workspaces/vm01/turbo/apps/web/src/lib/volume/types.ts`
- **Line:** 47
- **Issue:** Changed from string literal `"dynamic-volumes"` to `dynamic_volumes`

  ```typescript
  // Before
  "dynamic-volumes"?: Record<string, VolumeConfig>;

  // After
  dynamic_volumes?: Record<string, VolumeConfig>;
  ```

- **Assessment:** ✅ Proper TypeScript - no longer requires string literal property access, enabling better IDE support and type checking

#### 3. **Test Coverage for Deprecated Format** (Test Coverage - Good)

- **File:** `/workspaces/vm01/turbo/apps/web/src/lib/volume/__tests__/volume-resolver.test.ts`
- **Lines:** 265-286
- **Issue:** New test case validates that old format is rejected
- **Assessment:** ✅ Excellent - tests the migration path, ensures backward incompatibility is obvious to users

#### 4. **Inconsistent Error Message Reference** (Documentation Quality)

- **File:** `/workspaces/vm01/turbo/apps/web/src/lib/volume/volume-resolver.ts`
- **Line:** 99
- **Issue:** Updated error message references both sources:
  ```typescript
  message: `Volume "${volumeName}" not found in volumes or dynamic_volumes`,
  ```
- **Problem:** Minor - this message is now accurate and improved
- **Assessment:** ✅ Good - previous message was confusing with hyphenated reference

#### 5. **Missing Deprecation Warning Phase** (Change Management)

- **File:** All modified files
- **Issue:** No intermediate phase where deprecated format shows warning but still works
- **Problem:** This is a hard breaking change with no migration period. Users get an error immediately.
- **Recommendation:** Consider (for future): Phase 1 (v1.0) - deprecation warning but works, Phase 2 (v1.1) - error. Current approach is valid but harsh.
- **Note:** The error message does make this discoverable, so acceptable for v1.0

#### 6. **Configuration File Path Not Validated** (Implementation Detail)

- **File:** `/workspaces/vm01/e2e/fixtures/configs/vm0-test-volume-dynamic.yaml`
- **Line:** 12
- **Issue:** Only one fixture file appears to be updated
- **Problem:** Are there other config files in the codebase that need updating? The diff shows only one.
- **Recommendation:** Verify all config files have been updated through full codebase search

#### 7. **No Migration Guide Created** (Documentation)

- **File:** No migration guide found in commit
- **Issue:** Users upgrading will get an error but might not know where to look
- **Problem:** The inline error message helps, but comprehensive migration guide would be better
- **Recommendation:** Create `MIGRATION.md` or update `CHANGELOG.md` with:
  - List of affected config files
  - Before/after examples
  - Automated migration script if possible

#### 8. **Case Sensitivity Not Addressed** (Potential Issue)

- **File:** `/workspaces/vm01/turbo/apps/web/src/lib/volume/volume-resolver.ts`
- **Lines:** 73-79
- **Issue:** Check `if ("dynamic-volumes" in config)` is case-sensitive
- **Problem:** Users might try variations like `dynamic-Volumes` or `DYNAMIC_VOLUMES` and get confusing errors
- **Recommendation:** Consider more lenient matching with helpful error:
  ```typescript
  const hasDeprecatedKey = Object.keys(config).some(
    (key) => key.toLowerCase() === "dynamic-volumes",
  );
  if (hasDeprecatedKey) {
    throw new Error(
      "Configuration error: 'dynamic-volumes' is deprecated. Use 'dynamic_volumes' instead (snake_case). " +
        `Found: '${Object.keys(config).find((k) => k.toLowerCase() === "dynamic-volumes")}'`,
    );
  }
  ```

#### 9. **Index Signature Not Updated** (Type Safety)

- **File:** `/workspaces/vm01/turbo/apps/web/src/lib/volume/types.ts`
- **Issue:** Interface allows any property name via implicit index signature
  ```typescript
  export interface AgentVolumeConfig {
    // ... other properties
    dynamic_volumes?: Record<string, VolumeConfig>;
  }
  ```
- **Problem:** The deprecation check at runtime is good, but TypeScript doesn't prevent passing `{ "dynamic-volumes": ... }` due to index signatures
- **Assessment:** This is acceptable since the runtime validation catches it

#### 10. **Test All Call Sites Updated** (Test Coverage - Good)

- **File:** `/workspaces/vm01/turbo/apps/web/src/lib/volume/__tests__/volume-resolver.test.ts`
- **Lines:** 127, 168, 208
- **Issue:** All test cases updated to use new naming
- **Assessment:** ✅ Comprehensive - all 3 main test scenarios properly updated

### 💡 Recommendations

1. **Consider case-insensitive deprecation check:**
   - Helps users with typos find issues faster
   - Provides exact feedback on what they typed

2. **Create migration documentation:**
   - Add section to CHANGELOG.md
   - Create migration guide with before/after examples
   - Consider automated migration script using find/replace

3. **Verify all config files updated:**
   - Run grep to find any remaining `dynamic-volumes` references
   - Ensure test fixtures all use new format
   - Check documentation examples

4. **Optional: Provide migration helper:**
   - Consider CLI tool to auto-migrate config files
   - Parse YAML, replace key, write back

5. **Add logging for transparency:**
   - When a config is loaded successfully, could log which format was used
   - Helps teams verify migration is complete

6. **Version the configuration format:**
   - Consider adding `configVersion: 1.0` to distinguish between old/new
   - Enables easier format evolution in future

## Breaking Changes

- **BREAKING CHANGE:** Configuration files must rename `dynamic-volumes:` to `dynamic_volumes:`
- **Migration:** Users will receive clear error message with instructions
- **Impact:** Required for all users with dynamic volume configurations
- **Timeline:** No migration period - immediate error on old format

## Code Quality Score: 8.5/10

**Strengths:** Clear breaking change, good error messaging, comprehensive test coverage, proper type safety, follows project conventions
**Weaknesses:** No migration period, case-sensitivity not handled, no migration guide documentation, missing comprehensive config file audit

**Note:** This is a well-executed breaking change with good error handling. The score is high because the change serves a real purpose (Docker Compose alignment) and is well-tested. The weaknesses are mostly around user experience and documentation rather than code quality.
