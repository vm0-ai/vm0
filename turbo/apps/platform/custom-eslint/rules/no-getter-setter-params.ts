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

import {
  AST_NODE_TYPES,
  ESLintUtils,
  type TSESTree,
} from "@typescript-eslint/utils";
import type { Type } from "typescript";
import { createRule } from "../utils.ts";

export default createRule({
  name: "no-getter-setter-params",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Functions must not accept ccstate Getter or Setter types as parameters — use command() instead",
      requiresTypeChecking: true,
    },
    schema: [],
    messages: {
      noGetterSetterParam:
        "Parameter '{{name}}' has type '{{type}}' from ccstate. Use command() instead of passing Getter/Setter to functions.",
    },
  },

  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();

    function isCCStateGetterOrSetter(type: Type): boolean {
      const symbol = type.aliasSymbol ?? type.getSymbol();
      if (!symbol) {
        return false;
      }

      const name = symbol.getName();
      if (name !== "Getter" && name !== "Setter") {
        return false;
      }

      const declarations = symbol.getDeclarations();
      if (!declarations?.length) {
        return false;
      }

      return declarations.some((d) =>
        d.getSourceFile().fileName.includes("ccstate"),
      );
    }

    function checkParam(param: TSESTree.Parameter) {
      if (param.type !== AST_NODE_TYPES.Identifier) {
        return;
      }

      const tsNode = services.esTreeNodeToTSNodeMap.get(param);
      const type = checker.getTypeAtLocation(tsNode);

      if (isCCStateGetterOrSetter(type)) {
        const typeName = checker.typeToString(type);
        context.report({
          node: param,
          messageId: "noGetterSetterParam",
          data: { name: param.name, type: typeName },
        });
      }
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
