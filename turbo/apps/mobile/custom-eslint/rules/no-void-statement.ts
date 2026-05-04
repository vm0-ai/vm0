/**
 * ESLint rule: no-void-statement
 *
 * Disallows statement-level `void <expr>;` — the `void` prefix is
 * almost always used to silence `@typescript-eslint/no-floating-promises`
 * without actually handling the promise. Replace with `await` (if the
 * containing function is async) or `detach(<expr>, Reason.DomCallback)`
 * from DOM callbacks.
 *
 * Bad:
 *   void set(startSkeletonCycling$, signal).catch(throwIfNotAbort);
 *   void updateParams(next);
 *   void fetchExtra(id).then(...);
 *
 * Good:
 *   detach(set(startSkeletonCycling$, signal), Reason.DomCallback);
 *   await updateParams(next);
 *   detach(fetchExtra(id).then(...), Reason.DomCallback);
 *
 * Also rejects `void` wrapping function-call-like expressions via optional
 * chains (`void foo?.()`) for completeness.
 */

import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";

function isCallLike(node: TSESTree.Expression): boolean {
  if (
    node.type === AST_NODE_TYPES.CallExpression ||
    node.type === AST_NODE_TYPES.NewExpression ||
    node.type === AST_NODE_TYPES.AwaitExpression ||
    node.type === AST_NODE_TYPES.MemberExpression
  ) {
    return true;
  }
  if (node.type === AST_NODE_TYPES.ChainExpression) {
    return isCallLike(node.expression);
  }
  return false;
}

export default createRule({
  name: "no-void-statement",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow statement-level `void <call>;` — use detach() or await",
    },
    schema: [],
    messages: {
      noVoidStatement:
        "Do not use statement-level `void` to silence floating promises. Use `detach(<expr>, Reason.DomCallback)` from DOM callbacks, or `await` inside an async context. See turbo/docs/no-floating-promise.md#fix-recipes for the full set of recipes by call site.",
    },
  },
  create(context) {
    return {
      ExpressionStatement(node: TSESTree.ExpressionStatement) {
        const expr = node.expression;
        if (
          expr.type !== AST_NODE_TYPES.UnaryExpression ||
          expr.operator !== "void"
        ) {
          return;
        }
        if (!isCallLike(expr.argument)) {
          return;
        }
        context.report({
          node: expr,
          messageId: "noVoidStatement",
        });
      },
    };
  },
});
