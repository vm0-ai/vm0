/**
 * ESLint rule: no-new-abort-controller
 *
 * Prevents direct instantiation of AbortController.
 * Use pageSignal$, rootSignal$, or resetSignal() from the ccstate
 * signal hierarchy instead. See /ccstate documentation for correct patterns.
 *
 * Good:
 *   const signal = useGet(pageSignal$);
 *   const [reset$, resetSignal$] = resetSignal(pageSignal);
 *
 * Bad:
 *   const controller = new AbortController();
 *   const signal = new AbortController().signal;
 */

import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";

export default createRule({
  name: "no-new-abort-controller",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `new AbortController()`. Use pageSignal$/rootSignal$/resetSignal() from the ccstate signal hierarchy instead.",
      recommended: true,
    },
    schema: [],
    messages: {
      noNewAbortController:
        "`new AbortController()` is an anti-pattern. AbortSignals must cascade from the parent signal hierarchy (pageSignal$, rootSignal$, resetSignal()). Check the /ccstate documentation for correct patterns.",
    },
  },
  create(context) {
    return {
      NewExpression(node: TSESTree.NewExpression) {
        if (
          node.callee.type === AST_NODE_TYPES.Identifier &&
          node.callee.name === "AbortController"
        ) {
          context.report({
            node,
            messageId: "noNewAbortController",
          });
        }
      },
    };
  },
});
