/**
 * ESLint rule: no-fn-dollar-suffix
 *
 * The `$` suffix is reserved for ccstate signals (state/computed/command).
 * Plain functions and function expressions must not end with `$` — if you
 * need a parameterised signal, use `command()` directly so it accepts its
 * arguments natively, instead of wrapping a `computed()`/`command()` in a
 * factory function.
 *
 * Good:
 *   const counter$ = state(0)
 *   const double$ = computed((get) => get(counter$) * 2)
 *   const reset$ = command(({ set }) => set(counter$, 0))
 *   function helper(arg: string) { ... }
 *
 * Bad:
 *   function fetchUser$(id: string): Computed<User> { ... }
 *   const fetchUser$ = (id: string): Computed<User> => computed(...)
 *   const reset$ = () => store.set(counter$, 0)
 */

import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../utils.ts";

export const noFnDollarSuffix = createRule({
  name: "no-fn-dollar-suffix",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Functions must not end with $ — only state/computed/command results may use the $ suffix",
      requiresTypeChecking: false,
    },
    schema: [],
    messages: {
      functionDeclaration:
        "Function '{{name}}' must not end with $. The $ suffix is reserved for state/computed/command. Use command() with arguments directly instead of a factory function.",
      arrowOrFunctionExpression:
        "Variable '{{name}}' is bound to a function but ends with $. The $ suffix is reserved for state/computed/command results.",
    },
  },
  create(context) {
    function endsWithDollar(name: string): boolean {
      return name.endsWith("$");
    }

    return {
      FunctionDeclaration(node: TSESTree.FunctionDeclaration) {
        const name = node.id?.name;
        if (name && endsWithDollar(name)) {
          context.report({
            node: node.id ?? node,
            messageId: "functionDeclaration",
            data: { name },
          });
        }
      },
      VariableDeclarator(node: TSESTree.VariableDeclarator) {
        if (node.id.type !== AST_NODE_TYPES.Identifier) {
          return;
        }
        const name = node.id.name;
        if (!endsWithDollar(name)) {
          return;
        }
        const init = node.init;
        if (
          init &&
          (init.type === AST_NODE_TYPES.ArrowFunctionExpression ||
            init.type === AST_NODE_TYPES.FunctionExpression)
        ) {
          context.report({
            node: node.id,
            messageId: "arrowOrFunctionExpression",
            data: { name },
          });
        }
      },
    };
  },
});
