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
import type { TypeChecker } from "typescript";
import { createRule, isMutableObjectType } from "../utils.ts";

interface Options {
  allowedMutableTypes?: TypeOrValueSpecifier[];
}

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

function checkObjectPattern(
  node: TSESTree.ObjectPattern,
  services: ParserServicesWithTypeInformation,
  checker: TypeChecker,
  allowedMutableTypes: TypeOrValueSpecifier[] = [],
): boolean {
  for (const property of node.properties) {
    if (
      property.type === AST_NODE_TYPES.Property &&
      property.value.type === AST_NODE_TYPES.Identifier
    ) {
      const tsNode = services.esTreeNodeToTSNodeMap.get(property.value);
      const type = checker.getTypeAtLocation(tsNode);

      if (isMutableObjectType(type, services, checker, allowedMutableTypes)) {
        return true;
      }
    }
  }
  return false;
}

function checkIdentifier(
  node: TSESTree.Identifier,
  services: ParserServicesWithTypeInformation,
  checker: TypeChecker,
  allowedMutableTypes: TypeOrValueSpecifier[] = [],
): boolean {
  const tsNode = services.esTreeNodeToTSNodeMap.get(node);
  const type = checker.getTypeAtLocation(tsNode);

  return isMutableObjectType(type, services, checker, allowedMutableTypes);
}

function checkArrayPattern(
  node: TSESTree.ArrayPattern,
  services: ParserServicesWithTypeInformation,
  checker: TypeChecker,
  allowedMutableTypes: TypeOrValueSpecifier[] = [],
): boolean {
  for (const element of node.elements) {
    if (!element || element.type !== AST_NODE_TYPES.Identifier) {
      continue;
    }
    const tsNode = services.esTreeNodeToTSNodeMap.get(element);
    const type = checker.getTypeAtLocation(tsNode);

    if (isMutableObjectType(type, services, checker, allowedMutableTypes)) {
      return true;
    }
  }
  return false;
}

function checkDeclarator(
  declarator: TSESTree.VariableDeclarator,
  services: ParserServicesWithTypeInformation,
  checker: TypeChecker,
  allowedMutableTypes: TypeOrValueSpecifier[] = [],
): boolean {
  if (declarator.id.type === AST_NODE_TYPES.ObjectPattern) {
    return checkObjectPattern(
      declarator.id,
      services,
      checker,
      allowedMutableTypes,
    );
  }
  if (declarator.id.type === AST_NODE_TYPES.ArrayPattern) {
    return checkArrayPattern(
      declarator.id,
      services,
      checker,
      allowedMutableTypes,
    );
  }
  return checkIdentifier(declarator.id, services, checker, allowedMutableTypes);
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

          if (
            checkDeclarator(declarator, services, checker, allowedMutableTypes)
          ) {
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
