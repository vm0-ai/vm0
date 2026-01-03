# Code Review: c40eaa9

**PR:** #814
**Commit:** c40eaa9d590e40b75223d8956ed807bbc28a525c
**Title:** feat(cli): smart secret confirmation - only prompt for new secrets

## Summary

This commit implements smart secret confirmation in the compose command. Instead of prompting for ALL secrets every time, it compares the new compose's secrets against the HEAD version and only prompts for truly NEW secrets.

## Changes

### `turbo/apps/cli/src/commands/compose.ts`

1. **New export: `getSecretsFromComposeContent`** - Helper function that extracts secret names from compose content using existing `extractVariableReferences` and `groupVariablesBySource` from `@vm0/core`.

2. **HEAD version comparison logic** - Fetches existing compose's HEAD version to get previously approved secrets.

3. **Truly new secrets calculation** - Filters `newSecrets` to only include those not in `headSecrets`.

4. **Updated display** - Shows `(new)` marker for truly new secrets.

5. **Smart confirmation** - Only prompts when `trulyNewSecrets.length > 0`.

6. **Improved error message** - Non-TTY error now lists the specific new secrets detected.

### `turbo/apps/cli/src/commands/__tests__/compose.test.ts`

Added unit tests for `getSecretsFromComposeContent`:
- Extract secrets from compose environment
- Return empty set when no secrets
- Handle compose without environment
- Handle nested objects with secrets
- Deduplicate secrets with same name

## Review Findings

### Positive Aspects

1. **Clean implementation** - Uses existing utility functions from `@vm0/core` rather than reinventing the wheel.
2. **Good unit test coverage** - The helper function is well-tested.
3. **Clear error messages** - The non-TTY error explicitly lists which new secrets were detected.
4. **Follows project patterns** - Code style is consistent with existing codebase.

### Issues Found

#### Critical Issue: Missing E2E Test Coverage

**File:** `e2e/tests/02-parallel/t24-vm0-skill-frontmatter.bats`

The E2E test file was NOT modified to add tests for the new smart confirmation behavior. The following scenarios should be tested:

1. **Re-compose with same secrets skips confirmation** - After initial compose with `--yes`, a second compose without `--yes` should succeed without prompting.

2. **New secrets trigger confirmation** - When adding a skill with new secrets, the compose should prompt (or fail in non-TTY without `--yes`).

3. **Display shows `(new)` marker** - Output should contain `(new)` for new secrets but not for existing ones.

**Recommendation:** Add E2E tests to cover these scenarios. The challenge is that existing public skills may not have `vm0_secrets` in their frontmatter - consider creating a test-specific skill or mock.

#### Minor Issue: Empty try-catch block

**File:** `compose.ts:252-258`

```typescript
try {
  const existingCompose = await apiClient.getComposeByName(agentName);
  if (existingCompose.content) {
    headSecrets = getSecretsFromComposeContent(existingCompose.content);
  }
} catch {
  // No existing compose - all secrets are new (first-time compose)
}
```

The empty catch block silently swallows ALL errors, not just "compose not found" errors. However, this is acceptable in this context because:
1. The default behavior (empty `headSecrets`) is safe - it means all secrets are treated as new
2. Any API errors would surface later when trying to create/update the compose

The comment makes the intent clear, so this is acceptable but could be improved by checking for 404 specifically.

### Suggestions

1. **Consider adding debug logging** - When HEAD version is fetched or not found, a debug log would help troubleshooting.

2. **Test the `(new)` marker in unit tests** - The unit tests only test the helper function. Consider adding integration-level tests for the display logic.

## Overall Assessment

**Grade: B+**

The implementation is clean and follows project patterns. The main gap is the lack of E2E test coverage for the new behavior. The unit tests for the helper function are good, but the smart confirmation flow itself is not tested end-to-end.

### Recommended Actions

1. **[Required]** Add E2E tests for smart secret confirmation behavior
2. **[Optional]** Add debug logging for HEAD version fetch
3. **[Optional]** Consider more specific error handling for the try-catch block
