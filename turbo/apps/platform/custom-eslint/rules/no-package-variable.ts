/**
 * ESLint rule: no-package-variable
 *
 * Prevents mutable variables at package (module) scope.
 * Use signals (state/computed) for module-level state instead.
 *
 * Good:
 *   const count$ = state(0);
 *   const config = Object.freeze({ key: 'value' });
 *
 * Bad:
 *   let counter = 0;
 *   const items = [];
 *   const cache = new Map();
 */

import type { TypeOrValueSpecifier } from "@typescript-eslint/type-utils";
import {
  AST_NODE_TYPES,
  ESLintUtils,
  type ParserServicesWithTypeInformation,
  type TSESTree,
} from "@typescript-eslint/utils";
import type { Type, TypeChecker } from "typescript";
import { createRule, isMutableObjectType } from "../utils.ts";

interface Options {
  allowedMutableTypes?: TypeOrValueSpecifier[];
}

// These callee names always return ccstate types that are in allowedMutableTypes.
// Skipping the type check for them eliminates ~60% of checker.getTypeAtLocation calls.
const CCSTATE_PRIMITIVES = new Set(["state", "computed", "command"]);

function isPackageScope(node: TSESTree.Node): boolean {
  let parent = node.parent;
  while (parent) {
    if (
      parent.type === AST_NODE_TYPES.FunctionDeclaration ||
      parent.type === AST_NODE_TYPES.FunctionExpression ||
      parent.type === AST_NODE_TYPES.ArrowFunctionExpression ||
      parent.type === AST_NODE_TYPES.BlockStatement ||
      parent.type === AST_NODE_TYPES.ClassDeclaration
    ) {
      return false;
    }
    parent = parent.parent;
  }
  return true;
}

function isCCStatePrimitiveCall(
  init: TSESTree.Expression | null | undefined,
): boolean {
  if (init === null || init === undefined) {
    return false;
  }
  return (
    init.type === AST_NODE_TYPES.CallExpression &&
    init.callee.type === AST_NODE_TYPES.Identifier &&
    CCSTATE_PRIMITIVES.has(init.callee.name)
  );
}

export default createRule<[Options] | [], "noPackageVariable">({
  name: "no-package-variable",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description: "Prevent using package scope variables",
      recommended: true,
      requiresTypeChecking: true,
    },
    schema: [
      {
        type: "object",
        properties: {
          allowedMutableTypes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                from: {
                  type: "string",
                  enum: ["file", "lib", "package"],
                },
                name: {
                  type: "string",
                },
                package: {
                  type: "string",
                },
              },
              required: ["from", "name"],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      noPackageVariable:
        "Variable & mutable object is not allowed in package scope, use signals instead.",
    },
  },
  create(context) {
    const options = context.options[0];
    const allowedMutableTypes = options?.allowedMutableTypes ?? [];
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();
    // Cache type mutability results — TypeScript reuses Type objects for the same type,
    // so this avoids repeated isTypeReadonly calls for identical types (e.g. State<number>).
    const typeCache = new WeakMap<Type, boolean>();

    function isMutableCached(
      type: Type,
      srv: ParserServicesWithTypeInformation,
      chk: TypeChecker,
    ): boolean {
      const cached = typeCache.get(type);
      if (cached !== undefined) {
        return cached;
      }
      const result = isMutableObjectType(type, srv, chk, allowedMutableTypes);
      typeCache.set(type, result);
      return result;
    }

    function checkObjectPattern(node: TSESTree.ObjectPattern): boolean {
      for (const property of node.properties) {
        if (
          property.type === AST_NODE_TYPES.Property &&
          property.value.type === AST_NODE_TYPES.Identifier
        ) {
          const tsNode = services.esTreeNodeToTSNodeMap.get(property.value);
          const type = checker.getTypeAtLocation(tsNode);
          if (isMutableCached(type, services, checker)) {
            return true;
          }
        }
      }
      return false;
    }

    function checkIdentifier(node: TSESTree.Identifier): boolean {
      const tsNode = services.esTreeNodeToTSNodeMap.get(node);
      const type = checker.getTypeAtLocation(tsNode);
      return isMutableCached(type, services, checker);
    }

    function checkArrayPattern(node: TSESTree.ArrayPattern): boolean {
      for (const element of node.elements) {
        if (!element || element.type !== AST_NODE_TYPES.Identifier) {
          continue;
        }
        const tsNode = services.esTreeNodeToTSNodeMap.get(element);
        const type = checker.getTypeAtLocation(tsNode);
        if (isMutableCached(type, services, checker)) {
          return true;
        }
      }
      return false;
    }

    function checkDeclarator(declarator: TSESTree.VariableDeclarator): boolean {
      // Fast-path: state(), computed(), command() always return allowed ccstate types.
      if (isCCStatePrimitiveCall(declarator.init)) {
        return false;
      }

      if (declarator.id.type === AST_NODE_TYPES.ObjectPattern) {
        return checkObjectPattern(declarator.id);
      }
      if (declarator.id.type === AST_NODE_TYPES.ArrayPattern) {
        return checkArrayPattern(declarator.id);
      }
      return checkIdentifier(declarator.id);
    }

    return {
      VariableDeclaration(node: TSESTree.VariableDeclaration) {
        if (!isPackageScope(node)) {
          return;
        }

        if (node.kind !== "const") {
          context.report({
            node,
            messageId: "noPackageVariable",
          });
          return;
        }

        for (const declarator of node.declarations) {
          if (!declarator.init) {
            continue;
          }

          if (checkDeclarator(declarator)) {
            context.report({
              node: declarator,
              messageId: "noPackageVariable",
            });
          }
        }
      },
    };
  },
});
