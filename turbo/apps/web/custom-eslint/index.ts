/**
 * Custom ESLint plugin for web app patterns.
 *
 * Enforces best practices:
 * - no-direct-db-in-tests: Don't access database directly in test files
 * - no-relative-vi-mock: Don't use relative paths in vi.mock()
 * - no-duplicate-migration-prefix: Prevent duplicate migration file prefixes
 * - no-global-assignment: Don't attach new properties to globalThis/global
 */

import noDirectDbInTests from "./rules/no-direct-db-in-tests.ts";
import noDuplicateMigrationPrefix from "./rules/no-duplicate-migration-prefix.ts";
import noGlobalAssignment from "./rules/no-global-assignment.ts";
import noRelativeViMock from "./rules/no-relative-vi-mock.ts";
import noRequestJsonAs from "./rules/no-request-json-as.ts";

const plugin = {
  meta: {
    name: "web",
    version: "1.0.0",
  },
  rules: {
    "no-direct-db-in-tests": noDirectDbInTests,
    "no-duplicate-migration-prefix": noDuplicateMigrationPrefix,
    "no-global-assignment": noGlobalAssignment,
    "no-relative-vi-mock": noRelativeViMock,
    "no-request-json-as": noRequestJsonAs,
  },
};

export default plugin;
