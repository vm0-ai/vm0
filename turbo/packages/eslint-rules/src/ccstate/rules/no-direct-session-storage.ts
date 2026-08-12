/**
 * ESLint rule: no-direct-session-storage
 *
 * Disallows direct access to `sessionStorage`. All sessionStorage access should
 * go through the `sessionStorageSignals()` abstraction, which provides ccstate
 * reactivity and test cleanup.
 */

import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";

function isSessionStorage(node: TSESTree.Node): boolean {
  if (
    node.type === AST_NODE_TYPES.Identifier &&
    node.name === "sessionStorage"
  ) {
    return true;
  }

  return (
    node.type === AST_NODE_TYPES.MemberExpression &&
    node.object.type === AST_NODE_TYPES.Identifier &&
    (node.object.name === "window" || node.object.name === "globalThis") &&
    node.property.type === AST_NODE_TYPES.Identifier &&
    node.property.name === "sessionStorage"
  );
}

export default createRule({
  name: "no-direct-session-storage",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow direct sessionStorage access — use sessionStorageSignals() instead",
    },
    schema: [],
    messages: {
      noDirectSessionStorage:
        "Do not access sessionStorage directly. Use sessionStorageSignals() from signals/external/session-storage.ts instead.",
    },
  },
  create(context) {
    return {
      MemberExpression(node: TSESTree.MemberExpression) {
        if (isSessionStorage(node.object)) {
          context.report({
            node,
            messageId: "noDirectSessionStorage",
          });
        }
      },
    };
  },
});
