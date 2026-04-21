/**
 * Shared utilities for custom ESLint rules.
 */

import { ESLintUtils } from "@typescript-eslint/utils";

interface RuleDocs {
  description: string;
  recommended?: boolean;
  requiresTypeChecking?: boolean;
}

export const createRule = ESLintUtils.RuleCreator<RuleDocs>(
  (name) =>
    `https://github.com/anthropics/vm0/blob/main/docs/eslint/${name}.md`,
);
