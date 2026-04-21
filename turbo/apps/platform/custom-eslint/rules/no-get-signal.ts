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

    // Matches:
    // State<AbortSignal>, Computed<AbortSignal>
    // State<AbortSignal | undefined>, Computed<AbortSignal | undefined>
    // State<Map<string, AbortSignal>>, etc.
    // Does not match: State<Map<string, Command<void, [AbortSignal]>>>
    const directAbortSignalPattern =
      /^(State|Computed)<(AbortSignal(\s*\|\s*undefined)?|undefined\s*\|\s*AbortSignal|Map<[^,]+,\s*(AbortSignal(\s*\|\s*undefined)?|undefined\s*\|\s*AbortSignal)>)>$/;

    // Combined cache: for each unique Type object, stores whether it is a ccstate
    // State/Computed signal that holds AbortSignal. TypeScript canonicalizes generic
    // types, so the same Type object is returned for all references to the same variable,
    // meaning typeToString is called at most once per distinct type.
    const abortSignalSignalCache = new WeakMap<Type, boolean>();

    function isAbortSignalSignal(type: Type): boolean {
      const cached = abortSignalSignalCache.get(type);
      if (cached !== undefined) {
        return cached;
      }

      const typeString = checker.typeToString(type);

      // Fast exit: must be State<...> or Computed<...> to be relevant at all
      if (!/^(State|Computed)</.test(typeString)) {
        abortSignalSignalCache.set(type, false);
        return false;
      }

      // Check if it holds AbortSignal before the expensive symbol lookup
      if (!directAbortSignalPattern.test(typeString)) {
        abortSignalSignalCache.set(type, false);
        return false;
      }

      // Confirm it's from ccstate (not a user-defined State/Computed type)
      const symbol = type.getSymbol();
      if (symbol) {
        const declarations = symbol.getDeclarations();
        if (declarations?.length) {
          const result = declarations[0]
            .getSourceFile()
            .fileName.includes("ccstate");
          abortSignalSignalCache.set(type, result);
          return result;
        }
      }

      abortSignalSignalCache.set(type, false);
      return false;
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

          if (isAbortSignalSignal(type)) {
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
