/**
 * ESLint rule: no-computed-signal
 *
 * Computed callbacks must not consume ccstate's lifecycle options. Requests
 * started by a computed are allowed to finish after the computed invalidates.
 *
 * Good:
 *   computed(async (get) => load(get(id$)))
 *
 * Bad:
 *   computed(async (get, { signal }) => load(get(id$), signal))
 */

import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";

export default createRule({
  name: "no-computed-signal",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow the lifecycle options parameter in computed callbacks",
      recommended: true,
      requiresTypeChecking: false,
    },
    schema: [],
    messages: {
      noComputedSignal:
        "Computed callbacks must not accept lifecycle options. Remove the second callback parameter.",
    },
  },
  create(context) {
    function checkComputedCallback(node: TSESTree.CallExpression): void {
      if (
        node.callee.type !== AST_NODE_TYPES.Identifier ||
        node.callee.name !== "computed"
      ) {
        return;
      }

      const callback = node.arguments[0];
      if (
        callback?.type !== AST_NODE_TYPES.ArrowFunctionExpression &&
        callback?.type !== AST_NODE_TYPES.FunctionExpression
      ) {
        return;
      }

      const lifecycleOptions = callback.params[1];
      if (!lifecycleOptions) {
        return;
      }

      context.report({
        node: lifecycleOptions,
        messageId: "noComputedSignal",
      });
    }

    return {
      CallExpression: checkComputedCallback,
    };
  },
});
