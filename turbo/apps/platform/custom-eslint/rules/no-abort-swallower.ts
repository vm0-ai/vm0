/**
 * ESLint rule: no-abort-swallower
 *
 * Disallows rejection handlers that silently swallow promise failures —
 * handlers that satisfy `@typescript-eslint/no-floating-promises` by
 * "handling" the promise while silently discarding the rejection. The
 * promise escapes `clearAllDetached()` tracking and real errors become
 * invisible.
 *
 * Patterns caught:
 *   - `.catch(throwIfNotAbort)` — named AbortError-only swallower
 *   - `.then(_, throwIfNotAbort)` — same, via .then's second arg
 *   - `.then(_, () => {})` — empty rejection handler; swallows every
 *     rejection from the input promise and resolves the chain to
 *     undefined, so any outer `detach` tracker sees no error. `.then`'s
 *     narrower scope (only input rejection, not onSuccess) does not
 *     change the fact that the input's rejection is silenced.
 *
 * `.catch(() => {})` is handled by the separate `no-empty-promise-catch`
 * rule.
 *
 * Use `detach(promise, Reason.DomCallback)` from DOM callbacks, or
 * `await promise` in an async context where a parent signal propagates
 * the abort. See turbo/docs/no-floating-promise.md for the full recipe
 * list.
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
        "Disallow rejection handlers that silently swallow promise failures",
    },
    schema: [],
    messages: {
      noAbortSwallower:
        "Do not use `{{handler}}` as a promise rejection handler. It silently swallows AbortError and escapes the clearAllDetached() tracker. Use `detach(<expr>, Reason.DomCallback)` from DOM callbacks, or `await` with a parent signal. See turbo/docs/no-floating-promise.md#why-not-catchthrowifnotabort.",
      noEmptyThenReject:
        "Do not use an empty rejection handler in `.then(_, () => {})`. It swallows the input promise's rejection and resolves the chain to undefined, so any outer `detach` sees no error. Use `detach(<expr>, Reason.DomCallback)` to track the rejection, or restructure so `useLoadableSet` owns the error path without a second silencer.",
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
