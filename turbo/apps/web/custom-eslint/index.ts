/**
 * Custom ESLint plugin for web app testing patterns.
 *
 * Enforces testing best practices:
 * - no-direct-db-in-tests: Don't access database directly in test files
 */

import noDirectDbInTests from "./rules/no-direct-db-in-tests.ts";

const plugin = {
  meta: {
    name: "web",
    version: "1.0.0",
  },
  rules: {
    "no-direct-db-in-tests": noDirectDbInTests,
  },
};

export default plugin;
