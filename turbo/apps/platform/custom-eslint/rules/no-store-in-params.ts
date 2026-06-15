/**
 * ESLint rule: no-store-in-params
 *
 * Prevents Store type in function parameters.
 * Store should be accessed through signals, not passed around.
 *
 * Good:
 *   command(({ get, set }) => { ... });
 *
 * Bad:
 *   function processStore(store: Store) { ... }
 *
 * Options:
 *   allowedFunctions: string[] — function/variable names whose Store
 *     parameters are permitted. Use sparingly for app-boundary bootstrap
 *     functions that must bridge Store into React's provider system
 *     (e.g. "setupRouter").
 *
 * Example config:
 *   "ccstate/no-store-in-params": ["error", { allowedFunctions: ["setupRouter"] }]
 */

import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule, findTypeRefPath } from "../utils.ts";

interface Options {
  allowedFunctions?: string[];
}

type MessageIds = "noStoreInParams" | "noStoreInObjectParams";
const STORE_TYPES = new Set(["Store"]);

export default createRule<[Options?], MessageIds>({
  name: "no-store-in-params",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description: "Prevent Store type in function parameters",
      recommended: true,
      requiresTypeChecking: false,
    },
    schema: [
      {
        type: "object",
        properties: {
          allowedFunctions: {
            type: "array",
            items: { type: "string" },
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      noStoreInParams:
        "Function parameters should not accept Store type: {{param}}",
      noStoreInObjectParams:
        "Function parameters should not contain Store type in object properties: {{param}}.{{property}}",
    },
  },

  create(context) {
    const options = context.options[0] ?? {};
    const allowedFunctions = new Set(options.allowedFunctions ?? []);

    function checkParameter(param: TSESTree.Parameter) {
      if (param.type !== AST_NODE_TYPES.Identifier) {
        return;
      }
      const ann = param.typeAnnotation?.typeAnnotation;
      if (!ann) {
        return;
      }

      const storeRef = findTypeRefPath(ann, STORE_TYPES);
      if (storeRef === null) {
        return;
      }

      if (storeRef.path.length === 0) {
        context.report({
          node: param,
          messageId: "noStoreInParams",
          data: { param: param.name },
        });
      } else {
        context.report({
          node: param,
          messageId: "noStoreInObjectParams",
          data: { param: param.name, property: storeRef.path.join(".") },
        });
      }
    }

    function getFunctionName(
      node:
        | TSESTree.FunctionDeclaration
        | TSESTree.ArrowFunctionExpression
        | TSESTree.FunctionExpression,
    ): string | undefined {
      if (node.type === AST_NODE_TYPES.FunctionDeclaration) {
        return node.id?.name;
      }
      if (
        node.parent?.type === AST_NODE_TYPES.VariableDeclarator &&
        node.parent.id.type === AST_NODE_TYPES.Identifier
      ) {
        return node.parent.id.name;
      }
      return undefined;
    }

    function checkFunctionParams(
      node:
        | TSESTree.FunctionDeclaration
        | TSESTree.ArrowFunctionExpression
        | TSESTree.FunctionExpression,
    ) {
      const name = getFunctionName(node);
      if (name !== undefined && allowedFunctions.has(name)) {
        return;
      }
      for (const param of node.params) {
        checkParameter(param);
      }
    }

    return {
      "FunctionDeclaration, ArrowFunctionExpression"(
        node: TSESTree.FunctionDeclaration | TSESTree.ArrowFunctionExpression,
      ) {
        checkFunctionParams(node);
      },
      "FunctionExpression:not(MethodDefinition > FunctionExpression)"(
        node: TSESTree.FunctionExpression,
      ) {
        checkFunctionParams(node);
      },
      MethodDefinition(node) {
        if (node.value.type === AST_NODE_TYPES.FunctionExpression) {
          checkFunctionParams(node.value);
        }
      },
    };
  },
});
