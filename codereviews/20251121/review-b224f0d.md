# Review: test: simplify e2e tests and remove redundant checks

**Commit:** b224f0d3368f2ea0482c6b2ded7659297d143663
**Author:** Lan Chenyu
**Date:** Fri Nov 21 20:22:28 2025 +0800

## Summary

Simplified E2E tests for improved CI/CD reliability by:

- Removing duplicate test in t02-run.bats that verified the same command
- Simplifying volume mounting tests to use only simple text files instead of JSON
- Removing JSON file tests (config.json, profile.json) for stability
- Using consistent message.txt pattern for both static and dynamic volumes
- Cleaning up S3 test data setup to only create necessary files

This reduces test complexity and focuses on core volume mounting functionality.

## Code Smell Analysis

### ✅ Good Practices

- YAGNI principle applied - removes duplicate and unnecessary tests
- Clear simplification strategy - consolidating on single file type (text) reduces complexity
- Consistent test patterns across static and dynamic volume tests
- Reduces maintenance burden by removing flaky JSON-based tests
- Proper documentation in commit explaining the rationale
- Test data cleanup in S3 setup script follows minimalism principle

### ⚠️ Issues Found

- **Bad Smell #15 (Avoid Bad Tests)** - Tests for JSON files were potentially brittle (being removed for stability). Simplification is appropriate.
- **Bad Smell #15 (Over-testing)** - The duplicate test in t02-run.bats that verified the same command represents test redundancy

### 💡 Recommendations

- Consider documenting test coverage gaps for JSON file access - may need verification tests once volume stability improves
- Monitor S3 test data setup for any edge cases not covered by simplified text-based tests
- Evaluate if message.txt pattern is sufficient for all volume mounting scenarios

## Breaking Changes

- **Test Data Format**: Changed from JSON-based test data to text files
- **S3 Test Data**: Reduced S3 test bucket contents - removes profile.json, config.json, and README.md test files
- **Test Assertions**: Updated assertions to look for "Hello from" messages instead of specific JSON field values
- **File Paths**: Tests now access different file paths (message.txt vs profile.json/config.json)
