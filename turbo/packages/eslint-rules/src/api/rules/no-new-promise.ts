import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../utils.ts";

export const noNewPromise = createRule({
  name: "no-new-promise",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow direct Promise construction and Promise.withResolvers()",
      recommended: true,
    },
    schema: [],
    messages: {
      noNewPromise:
        "`new Promise()` is not allowed. Use signal-aware helpers such as createDeferredPromise(), delay(), or an existing abstraction instead.",
      noPromiseWithResolvers:
        "`Promise.withResolvers()` is not allowed. Use createDeferredPromise(signal) so the deferred inherits its owner signal.",
    },
  },
  create(context) {
    return {
      NewExpression(node: TSESTree.NewExpression): void {
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
      CallExpression(node: TSESTree.CallExpression): void {
        if (
          node.callee.type === AST_NODE_TYPES.MemberExpression &&
          node.callee.object.type === AST_NODE_TYPES.Identifier &&
          node.callee.object.name === "Promise" &&
          node.callee.property.type === AST_NODE_TYPES.Identifier &&
          node.callee.property.name === "withResolvers"
        ) {
          context.report({
            node,
            messageId: "noPromiseWithResolvers",
          });
        }
      },
    };
  },
});
