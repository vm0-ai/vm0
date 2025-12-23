# Code Review: 7213ffd0

**Commit**: feat(image): enforce lowercase image names for Docker compatibility
**Author**: Lancy
**Date**: 2025-12-22

## Summary

This commit implements case-insensitive image name handling by normalizing all inputs to lowercase before storage and lookup, aligning with Docker conventions.

## Files Changed

| File                                                  | Changes                                            |
| ----------------------------------------------------- | -------------------------------------------------- |
| `apps/cli/src/lib/__tests__/yaml-validator.test.ts`   | +26 lines - Added tests for `normalizeAgentName()` |
| `apps/cli/src/lib/yaml-validator.ts`                  | +11 lines - Added `normalizeAgentName()` function  |
| `apps/web/app/api/agent/composes/route.ts`            | +4/-4 lines - Normalize agent name before storage  |
| `packages/core/src/__tests__/scope-reference.spec.ts` | +78 lines - Added case normalization tests         |
| `packages/core/src/contracts/images.ts`               | +3/-2 lines - Added `.transform()` to alias schema |
| `packages/core/src/scope-reference.ts`                | +6/-6 lines - Normalize scope/name in parsers      |

## Review Findings

### ✅ Positive Observations

1. **Comprehensive test coverage**: New tests cover multiple case normalization scenarios including:
   - Mixed case to lowercase conversion
   - Uppercase to lowercase conversion
   - Already lowercase names (no change)
   - Invalid name format returns null
   - Legacy template passthrough (no normalization)
   - Tag case preservation

2. **Consistent implementation pattern**: Follows the existing scope slug normalization pattern using Zod's `.transform()` method.

3. **Clean, focused changes**: Each file modification is minimal and targeted.

4. **Good defensive programming**: The `normalizeAgentName()` function validates before normalizing, returning `null` for invalid inputs.

5. **Proper test isolation**: Each test case is independent and tests a single behavior.

### ⚠️ Suggestions

1. **Consider normalizing tags too** (Low Priority): The implementation preserves tag case (`DeadBeef`), which is correct for version hashes, but if tags like `Latest` vs `latest` should be equivalent, consider normalizing those too. Current behavior is fine for the stated use case.

2. **Compose route handler consistency**: The `agentName` variable is used to access `content.agents[agentName]` after `normalizedAgentName` is defined. This is correct (the YAML key still has original case), but the variable naming could be clearer (e.g., `originalAgentName`).

### ❌ Issues Found

**None** - The implementation is clean and follows project conventions.

## Code Quality Checklist

- [x] No mocks introduced
- [x] Test coverage added
- [x] No unnecessary try/catch blocks
- [x] No over-engineering
- [x] No dynamic imports
- [x] No timer/delay patterns
- [x] Key interfaces unchanged (backward compatible)

## Verdict

**APPROVED** ✅

This is a well-implemented feature with good test coverage. The changes are minimal, focused, and follow existing patterns in the codebase.
