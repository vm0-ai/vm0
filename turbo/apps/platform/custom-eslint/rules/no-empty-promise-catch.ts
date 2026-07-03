/**
 * ESLint rule: no-empty-promise-catch
 *
 * Disallows `.catch(() => {})` on promises. This pattern silences the
 * `@typescript-eslint/no-floating-promises` lint error without actually
 * handling the promise — the promise escapes `clearAllDetached()` cleanup
 * in tests and can cause DOMException on teardown.
 *
 * Use `detach(promise, Reason.DomCallback)` instead, which properly tracks
 * the promise for cleanup.
 *
 * Bad:
 *   loadFile(file, signal).catch(() => {});
 *   handleToggle(entry).catch(() => {});
 *
 * Good:
 *   detach(loadFile(file, signal), Reason.DomCallback);
 *   detach(handleToggle(entry), Reason.DomCallback);
 */

import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";

function isEmptyFunction(
  node: TSESTree.Expression | TSESTree.SpreadElement,
): boolean {
  if (
    node.type === AST_NODE_TYPES.ArrowFunctionExpression ||
    node.type === AST_NODE_TYPES.FunctionExpression
  ) {
    return (
      node.body.type === AST_NODE_TYPES.BlockStatement &&
      node.body.body.length === 0
    );
  }
  return false;
}

export default createRule({
  name: "no-empty-promise-catch",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow .catch(() => {}) on promises — use detach() instead",
    },
    schema: [],
    messages: {
      noEmptyPromiseCatch:
        "Do not use .catch(() => {}) to silence floating promises. Use detach(promise, Reason.DomCallback) to properly track the promise for cleanup.",
    },
  },
  create(context) {
    return {
      CallExpression(node: TSESTree.CallExpression) {
        // Match: expr.catch(() => {})
        if (
          node.callee.type !== AST_NODE_TYPES.MemberExpression ||
          node.callee.property.type !== AST_NODE_TYPES.Identifier ||
          node.callee.property.name !== "catch"
        ) {
          return;
        }

        // Must have exactly one argument that is an empty function
        if (
          node.arguments.length !== 1 ||
          !isEmptyFunction(node.arguments[0])
        ) {
          return;
        }

        context.report({
          node,
          messageId: "noEmptyPromiseCatch",
        });
      },
    };
  },
});
