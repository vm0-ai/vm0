/**
 * ESLint rule: no-manual-mock-cleanup
 *
 * Vitest config owns mock cleanup. Manual cleanup calls are redundant and can
 * break global test setup spies during teardown.
 */

import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";

export default createRule({
  name: "no-manual-mock-cleanup",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow manual Vitest mock cleanup calls because config handles mock cleanup",
    },
    schema: [],
    messages: {
      noManualMockCleanup:
        "Do not call vi.{{method}}(). Vitest config owns mock cleanup for platform tests.",
    },
  },
  create(context) {
    const bannedMethods = new Set([
      "restoreAllMocks",
      "clearAllMocks",
      "unstubAllGlobals",
    ]);

    return {
      CallExpression(node: TSESTree.CallExpression) {
        const callee = node.callee;
        if (callee.type !== AST_NODE_TYPES.MemberExpression) {
          return;
        }
        if (
          callee.object.type === AST_NODE_TYPES.Identifier &&
          callee.object.name === "vi" &&
          callee.property.type === AST_NODE_TYPES.Identifier &&
          bannedMethods.has(callee.property.name)
        ) {
          context.report({
            node,
            messageId: "noManualMockCleanup",
            data: { method: callee.property.name },
          });
        }
      },
    };
  },
});
