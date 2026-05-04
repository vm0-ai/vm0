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
import { createRule } from "../utils.ts";

interface Options {
  allowedFunctions?: string[];
}

type MessageIds = "noStoreInParams" | "noStoreInObjectParams";

// Returns the dot-path where Store was found, or null if not found.
// path=[] means Store is the direct type; path=["store"] means { store: Store }.
//
// Note: checks type annotation text only, not symbol origin. False positives are
// possible for user-defined types named Store from non-ccstate packages, but are
// acceptable in this codebase where this name is ccstate-specific by convention.
// Also note: type aliases (e.g. `type MyStore = Store; fn(s: MyStore)`) are not
// detected — only explicit Store annotations are matched.
function findStorePath(
  typeNode: TSESTree.TypeNode,
  path: string[] = [],
  depth = 0,
): string[] | null {
  if (depth > 3) {
    return null;
  }

  switch (typeNode.type) {
    case AST_NODE_TYPES.TSTypeReference: {
      const { typeName } = typeNode;
      if (
        typeName.type === AST_NODE_TYPES.Identifier &&
        typeName.name === "Store"
      ) {
        return path;
      }
      // Recurse into generic type arguments: e.g. Array<Store>, Map<string, Store>
      if (typeNode.typeArguments) {
        for (const arg of typeNode.typeArguments.params) {
          const found = findStorePath(arg, path, depth + 1);
          if (found !== null) {
            return found;
          }
        }
      }
      return null;
    }

    case AST_NODE_TYPES.TSUnionType:
    case AST_NODE_TYPES.TSIntersectionType: {
      for (const t of typeNode.types) {
        const found = findStorePath(t, path, depth + 1);
        if (found !== null) {
          return found;
        }
      }
      return null;
    }

    case AST_NODE_TYPES.TSArrayType: {
      return findStorePath(typeNode.elementType, [...path, "[]"], depth + 1);
    }

    case AST_NODE_TYPES.TSTypeLiteral: {
      for (const member of typeNode.members) {
        if (
          member.type === AST_NODE_TYPES.TSPropertySignature &&
          member.typeAnnotation
        ) {
          const propName =
            member.key.type === AST_NODE_TYPES.Identifier
              ? member.key.name
              : "?";
          const found = findStorePath(
            member.typeAnnotation.typeAnnotation,
            [...path, propName],
            depth + 1,
          );
          if (found !== null) {
            return found;
          }
        }
      }
      return null;
    }

    default: {
      return null;
    }
  }
}

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

      const storePath = findStorePath(ann);
      if (storePath === null) {
        return;
      }

      if (storePath.length === 0) {
        context.report({
          node: param,
          messageId: "noStoreInParams",
          data: { param: param.name },
        });
      } else {
        context.report({
          node: param,
          messageId: "noStoreInObjectParams",
          data: { param: param.name, property: storePath.join(".") },
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
