# Code Review: e3dd443

**Commit**: fix: sandbox calls commit on deduplication to update HEAD (#649)
**Files Changed**: 2
**Lines Changed**: +18, -1

## Summary

This commit fixes a bug where `vm0 cook` auto-pull fails with 404 when artifact deduplication occurs. The fix applies the same pattern that was previously implemented in the CLI's TypeScript code (#626) to the sandbox's Python script.

## Review by Criteria

### 1. YAGNI (You Aren't Gonna Need It) ✅ PASS

The changes are minimal and directly address the issue:

- No unnecessary abstractions added
- No "just in case" parameters
- Follows the simplest solution that works

### 2. Avoid Defensive Programming ✅ PASS

The error handling is appropriate:

- The commit response check (`if not commit_response or not commit_response.get("success")`) handles a legitimate failure case that needs specific error recovery (return None)
- No unnecessary try/catch blocks added
- Errors propagate naturally when they should

### 3. Strict Type Checking ✅ PASS

- TypeScript change is minimal (one argument added)
- No `any` types introduced
- Python code follows existing patterns in the file

### 4. Zero Tolerance for Lint Violations ✅ PASS

- No eslint-disable comments
- No @ts-ignore or @ts-nocheck
- Code follows project formatting standards

### 5. Commit Message ✅ PASS

- Follows Conventional Commits format
- Type is lowercase (`fix:`)
- Description is clear and concise
- Includes issue reference (`Fixes #649`)

## Code Analysis

### Change 1: `direct_upload.py.ts` (Primary Fix)

```python
# Step 3: Check if version already exists (deduplication)
# Still call commit to update HEAD pointer (fixes #649)
if prepare_response.get("existing"):
    log_info(f"Version already exists (deduplicated): {version_id[:8]}")
    log_info("Updating HEAD pointer...")

    commit_payload = {
        "storageName": storage_name,
        "storageType": storage_type,
        "versionId": version_id,
        "files": files
    }
    if run_id:
        commit_payload["runId"] = run_id

    commit_response = http_post_json(STORAGE_COMMIT_URL, commit_payload)
    if not commit_response or not commit_response.get("success"):
        log_error(f"Failed to update HEAD: {commit_response}")
        return None

    return {"versionId": version_id, "deduplicated": True}
```

**Assessment**: ✅ Good

- Mirrors the existing CLI TypeScript implementation
- Uses existing logging functions (`log_info`, `log_error`)
- Follows the same payload structure as the non-deduplication path
- Proper error handling with informative log message

### Change 2: `cook.ts` (Secondary Fix)

```typescript
await execVm0Command(["artifact", "pull", serverVersion], {
  cwd: artifactDir,
  silent: true,
});
```

**Assessment**: ✅ Good

- Simple one-line change
- `serverVersion` was already extracted earlier in the code
- Adds robustness without complexity

## Potential Issues

### Minor: No Test Coverage

While the fix is correct, there are no new tests added for:

- Sandbox deduplication with HEAD update
- Cook auto-pull with explicit version

**Recommendation**: Consider adding integration or E2E tests to prevent regression.

### Minor: Python Code in TypeScript File

The Python code is embedded in a TypeScript template string (`direct_upload.py.ts`). This is an existing pattern in the codebase, but it does make testing more difficult.

**Note**: This is not a new issue introduced by this PR.

## Verdict: ✅ APPROVED

The changes are:

- Minimal and focused
- Follow established patterns
- Address the root cause effectively
- Well-documented with clear comments

No blocking issues found.
