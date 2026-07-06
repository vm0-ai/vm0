/**
 * ESLint rule: no-new-promise
 *
 * Prevents direct instantiation of Promise.
 * Use existing signal-aware helpers and higher-level abstractions instead.
 */

import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";

export default createRule({
  name: "no-new-promise",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `new Promise()`. Use signal-aware helpers or existing abstractions instead.",
      recommended: true,
    },
    schema: [],
    messages: {
      noNewPromise:
        "`new Promise()` is not allowed. Use signal-aware helpers (for example createDeferredPromise(), never(), delay(), withSignal()) or an existing abstraction instead.",
    },
  },
  create(context) {
    return {
      NewExpression(node: TSESTree.NewExpression) {
        if (
          node.callee.type === AST_NODE_TYPES.Identifier &&
          node.callee.name === "Promise"
        ) {
          context.report({
            node,
            messageId: "noNewPromise",
          });
        }
      },
    };
  },
});
