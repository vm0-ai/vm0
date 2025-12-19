# Code Review: 800e94c

**Commit**: feat(ci): add cron simulator for sandbox heartbeat timeout detection
**Author**: lancy
**Date**: 2025-12-18

## Summary

This commit adds a background cron simulator to the CLI E2E test workflow that periodically calls the cleanup-sandboxes endpoint. This enables heartbeat timeout detection in CI environments where Vercel cron jobs don't run (preview deployments).

## Files Changed

| File | Changes |
|------|---------|
| `.github/workflows/turbo.yml` | +19 lines |
| `e2e/scripts/cron-simulator.sh` | +29 lines (new file) |

## Review Against Bad Code Smells

### 1. Mock Analysis
- **Status**: N/A
- No mock implementations added. This is CI/infrastructure code.

### 2. Test Coverage
- **Status**: N/A
- This is CI workflow code, not application code requiring unit tests.
- The change will be validated by existing E2E tests running with the cron simulator active.

### 3. Error Handling
- **Status**: PASS
- The script uses appropriate error handling:
  - `set -euo pipefail` for strict shell execution
  - `|| true` after curl to continue on failure (appropriate for background polling)
  - Graceful shutdown with `kill ... 2>/dev/null || true`

### 4. Interface Changes
- **Status**: N/A
- No public interface changes. CI workflow modifications only.

### 5. Timer and Delay Analysis
- **Status**: PASS
- Uses `sleep "$INTERVAL"` in production CI script, which is appropriate for a polling/cron simulation use case.
- This is intentional periodic execution, not an artificial delay to mask issues.

### 6. Dynamic Imports
- **Status**: N/A
- Shell script, not TypeScript.

### 7. Database/Service Mocking
- **Status**: N/A
- No test code added.

### 8. Test Mock Cleanup
- **Status**: N/A
- No test code added.

### 9. TypeScript `any` Usage
- **Status**: N/A
- Shell script, not TypeScript.

### 10. Artificial Delays in Tests
- **Status**: N/A
- Not test code.

### 11. Hardcoded URLs and Configuration
- **Status**: PASS
- No hardcoded URLs. API_URL is passed as a parameter.
- Environment variables used for secrets: `CRON_SECRET`, `VERCEL_AUTOMATION_BYPASS_SECRET`

### 12. Direct Database Operations
- **Status**: N/A
- No database operations.

### 13. Fallback Patterns
- **Status**: PASS
- Uses `${CRON_SECRET:-}` and `${VERCEL_AUTOMATION_BYPASS_SECRET:-}` which are appropriate for optional environment variables in this context (empty string fallback, not hiding errors).
- The `${1:?Error: ...}` pattern correctly fails fast when required parameter is missing.

### 14. Lint/Type Suppressions
- **Status**: PASS
- No suppression comments.

### 15. Bad Tests
- **Status**: N/A
- No test code added.

## Code Quality Assessment

### Strengths
1. **Clear documentation**: Script has helpful comments explaining purpose and usage
2. **Proper parameter validation**: Uses `${1:?Error: ...}` for required parameters
3. **Good logging**: Logs timestamps and HTTP status for debugging
4. **Fault tolerance**: Script continues on curl failures (appropriate for background process)
5. **Clean shutdown**: Uses `if: always()` to ensure cleanup runs even if tests fail

### Minor Observations
1. The script logs to stdout, which will appear in CI logs - this is appropriate for debugging
2. Default interval is 60 seconds, matching production cron schedule

## Verdict

**APPROVED** - This is a well-implemented CI enhancement that:
- Solves the problem of heartbeat timeout detection in preview deployments
- Follows shell scripting best practices
- Has appropriate error handling and cleanup
- Does not introduce any code smells
