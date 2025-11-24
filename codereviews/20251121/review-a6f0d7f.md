# Review: test: remove flaky dynamic volume verification test

**Commit:** a6f0d7f17271f46ca2f4d2a20fc3c99b8bee8769
**Author:** Lan Chenyu
**Date:** Fri Nov 21 20:01:22 2025 +0800

## Summary

Removed a flaky E2E test that was experiencing frequent timeouts. The test "Run agent with dynamic volume - verify user data access" was verifying JSON file access and was unsuitable for CI/CD gate checks. The change improves CI reliability by removing unreliable tests that slow down the pipeline.

## Code Smell Analysis

### ✅ Good Practices

- Pragmatic approach to test reliability - removing a problematic test rather than leaving it to cause false failures
- Clean test removal without introducing technical debt
- Proper documentation in commit message explaining why the test was removed
- Follows conventional commits format with lowercase type and description

### ⚠️ Issues Found

- **Bad Smell #10 (Artificial Delays in Tests)** - While the test itself is being removed, the issue it exposed may relate to timeout settings or test design. No artificial delays were introduced, but the flaky nature suggests potential timing/async issues.
- **Bad Smell #15 (Avoid Bad Tests)** - The removed test appears to have been a brittle test (experiencing frequent timeouts), which is appropriate to remove.

### 💡 Recommendations

- Consider investigating why this test was flaky - it may reveal issues with:
  - JSON file handling in volume mounting
  - Async operation sequencing in dynamic volume setup
  - Sandbox initialization timing
- Document the investigation findings to prevent similar issues in other tests
- Monitor for equivalent test coverage gaps that this removal creates

## Breaking Changes

- **Test Coverage**: Removed coverage verification for JSON files in dynamic volumes
- Users relying on JSON file access through dynamic volumes will need alternative verification methods
