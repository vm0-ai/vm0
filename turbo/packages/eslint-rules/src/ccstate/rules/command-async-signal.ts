/**
 * ESLint rule: command-async-signal
 *
 * Async commands must accept `signal: AbortSignal` as their last parameter.
 * This ensures proper cancellation support for all async operations.
 *
 * Good:
 *   command(async ({ get, set }, signal: AbortSignal) => { ... })
 *   command(async ({ get, set }, value: string, signal: AbortSignal) => { ... })
 *   command(({ get, set }) => { ... })  // sync — no signal needed
 *
 * Bad:
 *   command(async ({ get, set }) => { ... })  // missing signal
 *   command(async ({ get, set }, value: string) => { ... })  // last param is not signal
 */

import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";

export default createRule({
  name: "command-async-signal",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Async commands must accept AbortSignal as their last parameter",
      requiresTypeChecking: false,
    },
    schema: [],
    messages: {
      missingSignal:
        "Async command must accept `signal: AbortSignal` as its last parameter for cancellation support",
      signalNotLast:
        "The `signal: AbortSignal` parameter must be the last parameter of an async command",
    },
  },

  create(context) {
    function isAbortSignalAnnotation(param: TSESTree.Parameter): boolean {
      if (param.type !== AST_NODE_TYPES.Identifier) {
        return false;
      }
      const ann = param.typeAnnotation?.typeAnnotation;
      return (
        ann !== undefined &&
        ann.type === AST_NODE_TYPES.TSTypeReference &&
        ann.typeName.type === AST_NODE_TYPES.Identifier &&
        ann.typeName.name === "AbortSignal"
      );
    }

    function checkCommandCallback(
      node: TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression,
    ) {
      if (!node.async) {
        return;
      }

      // command callback always has destructured { get, set } as first param,
      // so user params start at index 1
      const userParams = node.params.slice(1);

      if (userParams.length === 0) {
        context.report({ node, messageId: "missingSignal" });
        return;
      }

      const lastParam = userParams[userParams.length - 1];
      if (!isAbortSignalAnnotation(lastParam)) {
        context.report({ node: lastParam, messageId: "signalNotLast" });
      }
    }

    return {
      CallExpression(node: TSESTree.CallExpression) {
        if (
          node.callee.type !== AST_NODE_TYPES.Identifier ||
          node.callee.name !== "command"
        ) {
          return;
        }

        const callback = node.arguments[0];
        if (!callback) {
          return;
        }

        if (
          callback.type === AST_NODE_TYPES.ArrowFunctionExpression ||
          callback.type === AST_NODE_TYPES.FunctionExpression
        ) {
          checkCommandCallback(callback);
        }
      },
    };
  },
});
