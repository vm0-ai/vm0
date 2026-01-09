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
 */

import {
  AST_NODE_TYPES,
  ESLintUtils,
  type TSESTree,
} from "@typescript-eslint/utils";
import type { Type } from "typescript";
import { createRule } from "../utils.ts";

export default createRule({
  name: "no-store-in-params",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description: "Prevent Store type in function parameters",
      recommended: true,
      requiresTypeChecking: true,
    },
    schema: [],
    messages: {
      noStoreInParams:
        "Function parameters should not accept Store type: {{param}}",
      noStoreInObjectParams:
        "Function parameters should not contain Store type in object properties: {{param}}.{{property}}",
    },
  },

  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();

    function isStoreType(type: Type): boolean {
      const typeString = checker.typeToString(type);
      if (!typeString.includes("Store")) {
        return false;
      }

      const symbol = type.getSymbol();
      if (!symbol || symbol.getName() !== "Store") {
        return false;
      }
      const declarations = symbol.getDeclarations();
      if (!declarations?.length) {
        return false;
      }
      const sourceFile = declarations[0].getSourceFile();
      return sourceFile.fileName.includes("ccstate");
    }

    function checkTypeRecursively(
      type: Type,
      paramName: string,
      node: TSESTree.Node,
      path: string[] = [],
      visitedTypes = new Set<Type>(),
    ): void {
      if (visitedTypes.has(type)) {
        return;
      }
      visitedTypes.add(type);

      if (path.length > 3) {
        return;
      }
      if (isStoreType(type)) {
        if (path.length === 0) {
          context.report({
            node,
            messageId: "noStoreInParams",
            data: { param: paramName },
          });
        } else {
          context.report({
            node,
            messageId: "noStoreInObjectParams",
            data: {
              param: paramName,
              property: path.join("."),
            },
          });
        }
        return;
      }
      if (type.isUnion() || type.isIntersection()) {
        for (const subType of type.types) {
          checkTypeRecursively(subType, paramName, node, path, visitedTypes);
        }
        return;
      }
      const typeAsString = checker.typeToString(type);
      if (
        typeAsString.includes("Store[]") ||
        typeAsString.includes("Array<Store")
      ) {
        const numberIndexType = checker.getIndexTypeOfType(
          type,
          1 /* IndexKind.Number */,
        );
        if (numberIndexType) {
          checkTypeRecursively(
            numberIndexType,
            paramName,
            node,
            [...path, "[]"],
            visitedTypes,
          );
        }
        return;
      }

      if (
        path.length <= 1 &&
        (type.isClassOrInterface() ||
          type.getFlags() & 524_288) /* TypeFlags.Object */
      ) {
        const properties = type.getProperties();
        const propsToCheck = properties.slice(0, 10);
        for (const prop of propsToCheck) {
          const propDeclaration = prop.valueDeclaration;
          if (propDeclaration) {
            const propType = checker.getTypeOfSymbolAtLocation(
              prop,
              propDeclaration,
            );
            const propTypeString = checker.typeToString(propType);
            if (propTypeString.includes("Store")) {
              checkTypeRecursively(
                propType,
                paramName,
                node,
                [...path, prop.getName()],
                visitedTypes,
              );
            }
          }
        }
      }
    }

    function checkParameter(param: TSESTree.Parameter) {
      if (param.type !== AST_NODE_TYPES.Identifier) {
        return;
      }
      const tsNode = services.esTreeNodeToTSNodeMap.get(param);
      const type = checker.getTypeAtLocation(tsNode);

      const typeFlags = type.getFlags();
      if (
        typeFlags &
        (16 /* TypeFlags.Boolean */ |
          32 /* TypeFlags.String */ |
          64 /* TypeFlags.Number */ |
          1024 /* TypeFlags.Null */ |
          2048 /* TypeFlags.Undefined */ |
          4096) /* TypeFlags.Void */
      ) {
        return;
      }
      checkTypeRecursively(type, param.name, param);
    }

    function checkFunctionParams(params: TSESTree.Parameter[]) {
      for (const param of params) {
        checkParameter(param);
      }
    }

    return {
      "FunctionDeclaration, ArrowFunctionExpression"(
        node: TSESTree.FunctionDeclaration | TSESTree.ArrowFunctionExpression,
      ) {
        checkFunctionParams(node.params);
      },
      "FunctionExpression:not(MethodDefinition > FunctionExpression)"(
        node: TSESTree.FunctionExpression,
      ) {
        checkFunctionParams(node.params);
      },
      MethodDefinition(node) {
        if (node.value.type === AST_NODE_TYPES.FunctionExpression) {
          checkFunctionParams(node.value.params);
        }
      },
    };
  },
});
