import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../utils.ts";

export const noGetterSetterParams = createRule({
  name: "no-getter-setter-params",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Functions must not accept ccstate Getter or Setter types as parameters",
      requiresTypeChecking: false,
    },
    schema: [],
    messages: {
      noGetterSetterParam:
        "Parameter '{{name}}' has type '{{type}}' from ccstate. Use a computed/command factory instead of passing Getter/Setter to functions.",
    },
  },
  create(context) {
    function getGetterSetterName(param: TSESTree.Parameter): string | null {
      if (param.type !== AST_NODE_TYPES.Identifier) {
        return null;
      }

      const annotation = param.typeAnnotation?.typeAnnotation;
      if (
        annotation?.type !== AST_NODE_TYPES.TSTypeReference ||
        annotation.typeName.type !== AST_NODE_TYPES.Identifier
      ) {
        return null;
      }

      const { name } = annotation.typeName;
      return name === "Getter" || name === "Setter" ? name : null;
    }

    function checkParam(param: TSESTree.Parameter): void {
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

    function isInsideCcstateCallback(node: TSESTree.Node): boolean {
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
    ): void {
      if (isInsideCcstateCallback(node)) {
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
