# Review: test: simplify volume mount paths to workspace root

**Commit:** 7bbb25ebd5d89864227446f4ebc20e8797cb04d7
**Author:** Lan Chenyu
**Date:** Fri Nov 21 23:43:43 2025 +0800

## Summary

Simplified volume mount paths in E2E tests by:

- Changing mount paths from subdirectories to workspace root (/home/user/workspace)
- Updated volume configurations in vm0-test-volume-static.yaml and vm0-test-volume-dynamic.yaml
- Updated test assertions to reflect simplified paths
- Reduces path complexity in volume mounting tests

Changes:

- Static volume: /home/user/workspace/data → /home/user/workspace
- Dynamic volume: /home/user/workspace/user-files → /home/user/workspace

## Code Smell Analysis

### ✅ Good Practices

- YAGNI principle applied - removes unnecessary path nesting complexity
- Simpler paths reduce confusion and make tests more straightforward
- Configuration files properly updated to match test expectations
- Test assertions consistently updated across all affected tests
- Improves maintainability by reducing path depth

### ⚠️ Issues Found

- **None identified** - Clean, simple refactoring with consistent updates

### 💡 Recommendations

- Verify that simplifying to workspace root doesn't cause file conflicts if multiple volume types are used simultaneously
- Document the new mount path convention for future volume setup
- Consider whether this impacts the volume mounting documentation or setup examples

## Breaking Changes

- **Volume Mount Paths**: Tests now expect volumes mounted directly to /home/user/workspace instead of subdirectories
- **File Access Paths**: Any code or tests accessing mounted volume files must use updated paths
- **Configuration**: vm0-test-volume-static.yaml and vm0-test-volume-dynamic.yaml have new mount paths
- **Agent Scripts**: Commands in tests must reference /home/user/workspace directly (e.g., /home/user/workspace/message.txt instead of /home/user/workspace/data/message.txt)
