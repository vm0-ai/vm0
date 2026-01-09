/**
 * ESLint rule: no-get-signal
 *
 * Prevents getting AbortSignal from state/computed.
 * AbortSignal should be passed as parameter, not stored in state.
 *
 * Good:
 *   command(async ({ get }, signal: AbortSignal) => {
 *     // use signal directly
 *   })
 *
 * Bad:
 *   const signal$ = state<AbortSignal>(new AbortController().signal);
 *   command(({ get }) => {
 *     const signal = get(signal$); // BAD - getting signal from state
 *   })
 */

import {
  AST_NODE_TYPES,
  ESLintUtils,
  type TSESTree,
} from "@typescript-eslint/utils";
import type { Type } from "typescript";
import { createRule } from "../utils.ts";

export default createRule({
  name: "no-get-signal",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "AbortSignal should not be get by state, use signal parameter instead.",
      recommended: true,
      requiresTypeChecking: true,
    },
    schema: [],
    messages: {
      noGetSignal:
        "AbortSignal should not be get by state, use signal parameter instead.",
    },
  },
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();

    const typeCache = new WeakMap<Type, boolean>();

    function isSignalType(type: Type): boolean {
      const cached = typeCache.get(type);
      if (cached !== undefined) {
        return cached;
      }

      const typeString = checker.typeToString(type);

      const isStateOrComputed = /^(State|Computed)<.*>$/.test(typeString);

      if (isStateOrComputed) {
        const symbol = type.getSymbol();
        if (symbol) {
          const declarations = symbol.getDeclarations();
          if (declarations?.length) {
            const sourceFile = declarations[0].getSourceFile();
            const result = sourceFile.fileName.includes("ccstate");
            typeCache.set(type, result);
            return result;
          }
        }
      }

      typeCache.set(type, false);
      return false;
    }

    function hasDirectAbortSignalGeneric(type: Type): boolean {
      const typeString = checker.typeToString(type);

      // Matches：
      // State<AbortSignal>
      // Computed<AbortSignal>
      // State<AbortSignal | undefined>
      // Computed<AbortSignal | undefined>
      // State<Map<string, AbortSignal>>
      // Computed<Map<string, AbortSignal>>
      // State<Map<string, AbortSignal | undefined>>
      // Computed<Map<string, AbortSignal | undefined>>
      // Does not match:
      // State<Map<string, Command<void, [AbortSignal]>>>
      const directAbortSignalPattern =
        /^(State|Computed)<(AbortSignal(\s*\|\s*undefined)?|undefined\s*\|\s*AbortSignal|Map<[^,]+,\s*(AbortSignal(\s*\|\s*undefined)?|undefined\s*\|\s*AbortSignal)>)>$/;
      return directAbortSignalPattern.test(typeString);
    }

    function isStoreGet(node: TSESTree.CallExpression): boolean {
      if (node.callee.type === AST_NODE_TYPES.MemberExpression) {
        const object = node.callee.object;
        const property = node.callee.property;

        return (
          object.type === AST_NODE_TYPES.Identifier &&
          object.name === "store" &&
          property.type === AST_NODE_TYPES.Identifier &&
          property.name === "get"
        );
      }
      return false;
    }

    return {
      CallExpression(node: TSESTree.CallExpression) {
        if (isStoreGet(node)) {
          return;
        }

        if (
          node.callee.type === AST_NODE_TYPES.Identifier &&
          node.callee.name === "get" &&
          node.arguments.length > 0
        ) {
          const firstArg = node.arguments[0];
          const tsNode = services.esTreeNodeToTSNodeMap.get(firstArg);
          const type = checker.getTypeAtLocation(tsNode);

          if (isSignalType(type) && hasDirectAbortSignalGeneric(type)) {
            context.report({
              node,
              messageId: "noGetSignal",
            });
          }
        }
      },
    };
  },
});
