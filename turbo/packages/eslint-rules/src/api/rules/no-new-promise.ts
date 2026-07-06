import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../utils.ts";

export const noNewPromise = createRule({
  name: "no-new-promise",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description: "Disallow direct Promise construction",
      recommended: true,
    },
    schema: [],
    messages: {
      noNewPromise:
        "`new Promise()` is not allowed. Use signal-aware helpers such as createDeferredPromise(), delay(), or an existing abstraction instead.",
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
    };
  },
});
