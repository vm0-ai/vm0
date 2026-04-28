/**
 * ESLint rule: no-react-class-component
 *
 * Prevents adding new React class components. Existing class components must
 * carry a local eslint-disable with an issue link tracking the refactor.
 */

import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";

const REACT_COMPONENT_BASES = new Set(["Component", "PureComponent"]);

type ClassNode = TSESTree.ClassDeclaration | TSESTree.ClassExpression;

export default createRule({
  name: "no-react-class-component",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow React class components. Use function components with hooks instead.",
      recommended: true,
    },
    schema: [],
    messages: {
      noReactClassComponent:
        "React class components are not allowed. Use a function component with hooks instead.",
    },
  },
  create(context) {
    const componentBaseNames = new Set<string>();
    const reactNamespaceNames = new Set<string>();

    function isReactClassSuperClass(superClass: TSESTree.Expression): boolean {
      if (
        superClass.type === AST_NODE_TYPES.Identifier &&
        componentBaseNames.has(superClass.name)
      ) {
        return true;
      }

      if (superClass.type !== AST_NODE_TYPES.MemberExpression) {
        return false;
      }

      if (
        superClass.object.type !== AST_NODE_TYPES.Identifier ||
        !reactNamespaceNames.has(superClass.object.name)
      ) {
        return false;
      }

      if (superClass.property.type === AST_NODE_TYPES.Identifier) {
        return REACT_COMPONENT_BASES.has(superClass.property.name);
      }

      return (
        superClass.computed &&
        superClass.property.type === AST_NODE_TYPES.Literal &&
        typeof superClass.property.value === "string" &&
        REACT_COMPONENT_BASES.has(superClass.property.value)
      );
    }

    function checkClass(node: ClassNode): void {
      if (!node.superClass || !isReactClassSuperClass(node.superClass)) {
        return;
      }

      context.report({
        node,
        messageId: "noReactClassComponent",
      });
    }

    return {
      ImportDeclaration(node: TSESTree.ImportDeclaration): void {
        if (node.source.value !== "react") {
          return;
        }

        if (node.importKind === "type") {
          return;
        }

        for (const specifier of node.specifiers) {
          if (
            specifier.type === AST_NODE_TYPES.ImportSpecifier &&
            specifier.importKind === "type"
          ) {
            continue;
          }

          if (specifier.type === AST_NODE_TYPES.ImportDefaultSpecifier) {
            reactNamespaceNames.add(specifier.local.name);
            continue;
          }

          if (specifier.type === AST_NODE_TYPES.ImportNamespaceSpecifier) {
            reactNamespaceNames.add(specifier.local.name);
            continue;
          }

          if (
            specifier.imported.type === AST_NODE_TYPES.Identifier &&
            REACT_COMPONENT_BASES.has(specifier.imported.name)
          ) {
            componentBaseNames.add(specifier.local.name);
          }
        }
      },
      ClassDeclaration: checkClass,
      ClassExpression: checkClass,
    };
  },
});
