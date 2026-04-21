/**
 * ESLint rule: no-getter-setter-params
 *
 * Regular functions must not accept ccstate Getter or Setter types as parameters.
 * If a function needs get/set access, it should be a command.
 *
 * Good:
 *   const myCommand$ = command(({ get, set }) => { ... });
 *
 * Bad:
 *   function helper(get: Getter, set: Setter, value: string) { ... }
 *   async function doWork(get: Getter, data: Data) { ... }
 */

import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";

export default createRule({
  name: "no-getter-setter-params",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Functions must not accept ccstate Getter or Setter types as parameters — use command() instead",
      requiresTypeChecking: false,
    },
    schema: [],
    messages: {
      noGetterSetterParam:
        "Parameter '{{name}}' has type '{{type}}' from ccstate. Use command() instead of passing Getter/Setter to functions.",
    },
  },

  create(context) {
    // Checks type annotation text only, not symbol origin. False positives are
    // possible for user-defined types named Getter/Setter from non-ccstate
    // packages, but are acceptable in this codebase where these names are
    // ccstate-specific by convention.
    function getGetterSetterName(param: TSESTree.Parameter): string | null {
      if (param.type !== AST_NODE_TYPES.Identifier) {
        return null;
      }
      const ann = param.typeAnnotation?.typeAnnotation;
      if (
        ann === undefined ||
        ann.type !== AST_NODE_TYPES.TSTypeReference ||
        ann.typeName.type !== AST_NODE_TYPES.Identifier
      ) {
        return null;
      }
      const { name } = ann.typeName;
      return name === "Getter" || name === "Setter" ? name : null;
    }

    function checkParam(param: TSESTree.Parameter) {
      const typeName = getGetterSetterName(param);
      if (typeName === null) {
        return;
      }
      context.report({
        node: param,
        messageId: "noGetterSetterParam",
        data: { name: (param as TSESTree.Identifier).name, type: typeName },
      });
    }

    const ccstatePrimitives = new Set(["command", "computed", "state"]);

    function isInsideCCStateCallback(node: TSESTree.Node): boolean {
      let current: TSESTree.Node | undefined = node.parent;
      while (current) {
        if (
          current.type === AST_NODE_TYPES.CallExpression &&
          current.callee.type === AST_NODE_TYPES.Identifier &&
          ccstatePrimitives.has(current.callee.name)
        ) {
          return true;
        }
        current = current.parent;
      }
      return false;
    }

    function checkFunction(
      node:
        | TSESTree.FunctionDeclaration
        | TSESTree.FunctionExpression
        | TSESTree.ArrowFunctionExpression,
    ) {
      if (isInsideCCStateCallback(node)) {
        return;
      }

      for (const param of node.params) {
        checkParam(param);
      }
    }

    return {
      FunctionDeclaration: checkFunction,
      FunctionExpression: checkFunction,
      ArrowFunctionExpression: checkFunction,
    };
  },
});
