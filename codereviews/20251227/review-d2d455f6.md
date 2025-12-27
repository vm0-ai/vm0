# Review: d2d455f6 - feat(core): add ts-rest contracts for storage direct upload endpoints

## Summary
This commit adds type-safe ts-rest contracts for storage direct upload endpoints, including CLI endpoints (prepare, commit, download) and webhook endpoints for sandbox use.

## Files Changed
- `turbo/packages/core/src/contracts/storages.ts` - New schemas and contracts for CLI endpoints
- `turbo/packages/core/src/contracts/webhooks.ts` - New contracts for webhook endpoints
- `turbo/packages/core/src/contracts/index.ts` - Export updates

## Analysis

### 1. Mock Analysis
**No mocks introduced** - This commit only adds contract definitions with no mock implementations.

### 2. Test Coverage
**N/A** - This is a contract definition commit. Tests are in the second commit.

### 3. Error Handling
**Good** - Consistent error schemas using `apiErrorSchema` across all endpoints:
- 400 (BAD_REQUEST)
- 401 (UNAUTHORIZED)
- 404 (NOT_FOUND)
- 409 (S3_FILES_MISSING) - specific to commit endpoint
- 500 (INTERNAL_ERROR)

### 4. Interface Changes
**New interfaces added:**

Shared schemas:
- `fileEntryWithHashSchema` - File entry with SHA-256 hash validation (64 chars)
- `storageChangesSchema` - Incremental upload change tracking
- `presignedUploadSchema` - Presigned URL structure

CLI contracts:
- `storagesPrepareContract` - POST /api/storages/prepare
- `storagesCommitContract` - POST /api/storages/commit
- `storagesDownloadContract` - GET /api/storages/download

Webhook contracts:
- `webhookStoragesPrepareContract` - POST /api/webhooks/agent/storages/prepare
- `webhookStoragesCommitContract` - POST /api/webhooks/agent/storages/commit

**Design Notes:**
- CLI contracts have optional `runId` for sandbox auth
- Webhook contracts require `runId` (enforced via schema)
- Download contract uses `z.union()` to handle both normal and empty responses

### 5. Timer and Delay Analysis
**None** - No timers or delays introduced.

### 6. Dynamic Imports
**None** - All imports are static.

## Observations

### Positives
1. Clear schema separation between shared schemas and endpoint-specific contracts
2. Good JSDoc documentation explaining each contract's purpose
3. Proper reuse of schemas between CLI and webhook contracts
4. Type exports for all contracts enable type-safe client usage

### Minor Notes
1. The `storagesDownloadContract` uses `z.union()` for the 200 response - this is appropriate for handling both normal downloads and empty artifact responses
2. The webhook contracts properly distinguish from CLI contracts by requiring `runId` instead of making it optional

## Verdict
**APPROVED** - Well-structured contract definitions following project patterns. No issues found.
