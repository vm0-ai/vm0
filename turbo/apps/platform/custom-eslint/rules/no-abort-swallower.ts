/**
 * ESLint rule: no-abort-swallower
 *
 * Disallows `.catch(throwIfNotAbort)` and `.then(_, throwIfNotAbort)` —
 * patterns that hand `@typescript-eslint/no-floating-promises` a handler
 * to keep it happy while silently swallowing `AbortError`. The promise
 * escapes `clearAllDetached()` and test teardown can emit unhandled
 * rejections.
 *
 * Use `detach(promise, Reason.DomCallback)` from DOM callbacks, or
 * `await promise` in an async context where a parent signal propagates
 * the abort.
 *
 * Bad:
 *   set(cmd$, signal).catch(throwIfNotAbort);
 *   fetchSomething().then(ok, throwIfNotAbort);
 *
 * Good:
 *   detach(set(cmd$, signal), Reason.DomCallback);
 *   await set(cmd$, signal);
 *
 * See turbo/docs/no-floating-promise.md for the full recipe list.
 */

import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";

const ABORT_SWALLOWERS = new Set(["throwIfNotAbort"]);

function isAbortSwallower(
  node: TSESTree.Expression | TSESTree.SpreadElement,
): boolean {
  return (
    node.type === AST_NODE_TYPES.Identifier && ABORT_SWALLOWERS.has(node.name)
  );
}

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
  name: "no-abort-swallower",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow .catch/.then handlers that only filter AbortError — use detach() or await",
    },
    schema: [],
    messages: {
      noAbortSwallower:
        "Do not use `{{handler}}` as a promise rejection handler. It silently swallows AbortError and escapes the clearAllDetached() tracker. Use `detach(<expr>, Reason.DomCallback)` from DOM callbacks, or `await` with a parent signal. See turbo/docs/no-floating-promise.md#why-not-catchthrowifnotabort.",
      noEmptyThenReject:
        "Do not use an empty rejection handler in `.then(_, () => {})`. This silences floating-promise lint without tracking the rejection. Use `detach(<expr>, Reason.DomCallback)` instead.",
    },
  },
  create(context) {
    return {
      CallExpression(node: TSESTree.CallExpression) {
        if (
          node.callee.type !== AST_NODE_TYPES.MemberExpression ||
          node.callee.property.type !== AST_NODE_TYPES.Identifier
        ) {
          return;
        }
        const method = node.callee.property.name;

        if (method === "catch" && node.arguments.length === 1) {
          const handler = node.arguments[0];
          if (isAbortSwallower(handler)) {
            context.report({
              node,
              messageId: "noAbortSwallower",
              data: {
                handler:
                  handler.type === AST_NODE_TYPES.Identifier
                    ? handler.name
                    : "handler",
              },
            });
          }
          return;
        }

        if (method === "then" && node.arguments.length >= 2) {
          const rejectHandler = node.arguments[1];
          if (isAbortSwallower(rejectHandler)) {
            context.report({
              node,
              messageId: "noAbortSwallower",
              data: {
                handler:
                  rejectHandler.type === AST_NODE_TYPES.Identifier
                    ? rejectHandler.name
                    : "handler",
              },
            });
            return;
          }
          if (isEmptyFunction(rejectHandler)) {
            context.report({
              node,
              messageId: "noEmptyThenReject",
            });
          }
        }
      },
    };
  },
});
