# Bad Smell Tracking

This document tracks code smells and technical debt that should be addressed in future iterations.

---

## Filesystem Mocks in Tests

### Problem

One test file still uses filesystem mocks because it requires code refactoring:

**turbo/apps/runner/src/lib/firecracker/**tests**/ip-pool.test.ts**

- Issue: IP pool module uses hardcoded path constants
  ```typescript
  const VM0_RUN_DIR = "/var/run/vm0";
  const REGISTRY_FILE_PATH = path.join(VM0_RUN_DIR, "ip-registry.json");
  ```
- Solution needed: Accept custom path via config, constructor parameter, or environment variable
- Impact: Would enable proper test isolation with temp directories

### Background

The project principle is to **never mock the filesystem** in tests. We should use real filesystem operations with temporary directories for better test reliability.

9 out of 10 test files have been successfully migrated to use real filesystem (issue #1404). This file remains with mocks due to tight coupling with hardcoded paths in the production code.

### Recommendation

Future refactoring should make the IP pool module accept configurable paths (similar to how VMRegistry already does) to enable real filesystem testing.

### Migrated Files (for reference)

The following files were successfully migrated to use real filesystem with temp directories:

1. `apps/cli/src/commands/__tests__/init.test.ts`
2. `apps/cli/src/commands/__tests__/compose.test.ts`
3. `apps/cli/src/commands/__tests__/cook.test.ts`
4. `apps/runner/src/lib/proxy/__tests__/vm-registry.test.ts`
5. `apps/runner/src/__tests__/config.test.ts`
6. `apps/cli/src/commands/__tests__/setup-github.test.ts`
7. `apps/cli/src/commands/schedule/__tests__/init.test.ts`
8. `apps/cli/src/lib/domain/__tests__/cook-state.test.ts`
9. `apps/runner/src/lib/proxy/__tests__/proxy-manager.test.ts`
