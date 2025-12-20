# Code Review: PR #643 - feat(image): add versioning support with tag syntax

## Summary

This PR implements image versioning support with Docker-like tag syntax (Issue #641). Each image build now gets a unique `versionId` (nanoid 8 chars), allowing users to pin specific versions or use `:latest` to get the most recent ready build.

## Commits Reviewed

1. `9259a2b5` - Main feature implementation (18 files, +1094 / -207)
2. `1d19c29d` - Fix: add user scopes to image route tests
3. `e4715be8` - Fix: update regex to include nanoid special characters
4. `190da3c4` - Fix: add scope setup before image build test
5. `b3fdc254` - Test: expand image versioning test coverage

---

## Detailed Review

### Architecture & Design

**Strengths:**
- Clean separation of concerns: `scope-reference.ts` in `@vm0/core` handles parsing logic, `image-service.ts` handles database operations
- Docker-like tag syntax is intuitive (`image-name:tag`, `@scope/name:tag`)
- Backward compatible: legacy `vm0-*` templates passthrough unchanged
- Proper use of partial unique indexes for versioned vs legacy images

**Minor Observations:**
- `generateE2bAlias()` (line 26-28) still exists but appears unused in new code path - could be deprecated/removed in future
- `computeDockerfileVersionHash()` is defined but not used in this PR (perhaps for future deduplication?)

### Database Migration (0042_add_image_version_id.sql)

**Well done:**
- Nullable `version_id` preserves backward compatibility with existing images
- Smart use of partial unique indexes to handle NULL version_id case
- Added `idx_images_latest_lookup` index for efficient latest version queries

### Test Coverage

**Excellent coverage:**
- Unit tests for `parseImageReferenceWithTag()`: 20+ test cases covering all edge cases
- Unit tests for `resolveImageAlias()`: explicit scope, implicit scope, tags, error cases
- Unit tests for new query functions: `getLatestImage()`, `getImageByScopeAliasAndVersion()`, `listImageVersions()`
- E2E tests: 14 tests covering build output, list, versions, delete with various options

### Code Quality

**No issues found:**
- No unnecessary try/catch blocks - errors propagate naturally
- No over-engineering - implementation is straightforward
- No new mocks introduced in production code
- Clean error messages with actionable hints

### Minor Suggestions (Non-blocking)

1. **E2B alias format is quite long** (line 253-258 of scope-reference.ts):
   ```
   scope-{scopeId}-image-{name}-version-{versionId}
   ```
   This could approach E2B's 64-char limit for long UUIDs + image names. Consider monitoring.

2. **The deprecated function `getImageByScopeAndAlias`** has a deprecation comment but no `@deprecated` JSDoc tag.

---

## Verdict

**APPROVED** - This is a well-designed feature with comprehensive test coverage. The code follows project conventions, avoids over-engineering, and maintains backward compatibility.

## Test Results

All 132 E2E tests pass, including 14 new versioning tests:
- `vm0 image build shows version ID in output`
- `vm0 image list shows versions with (latest) marker`
- `vm0 image versions lists versions for specific image`
- `vm0 image versions --help shows usage`
- `vm0 image build creates multiple versions`
- `vm0 image delete --help shows options`
- `vm0 image rm alias works`
- `vm0 image delete with version syntax deletes specific version`
- `vm0 image delete --all removes all versions`
- `vm0 image delete without --all deletes latest version only`
- `vm0 image delete non-existent version fails`
- `vm0 image delete non-existent image fails`
