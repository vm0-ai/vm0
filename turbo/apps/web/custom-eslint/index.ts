/**
 * Custom ESLint plugin for web app patterns.
 *
 * Enforces best practices:
 * - no-direct-db-in-tests: Don't access database directly in test files
 * - no-relative-vi-mock: Don't use relative paths in vi.mock()
 * - no-duplicate-migration-prefix: Prevent duplicate migration file prefixes
 */

import noDirectDbInTests from "./rules/no-direct-db-in-tests.ts";
import noDuplicateMigrationPrefix from "./rules/no-duplicate-migration-prefix.ts";
import noRelativeViMock from "./rules/no-relative-vi-mock.ts";

const plugin = {
  meta: {
    name: "web",
    version: "1.0.0",
  },
  rules: {
    "no-direct-db-in-tests": noDirectDbInTests,
    "no-duplicate-migration-prefix": noDuplicateMigrationPrefix,
    "no-relative-vi-mock": noRelativeViMock,
  },
};

export default plugin;
