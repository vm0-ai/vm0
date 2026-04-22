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

import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";

interface Options {
  allowedConstructors?: string[];
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

/**
 * Returns true if the type annotation on a declarator indicates the value is
 * explicitly declared as readonly, e.g.:
 *   const x: Readonly<Record<K, V>> = {...}
 *   const x: readonly Foo[] = [...]
 */
function isReadonlyAnnotated(declarator: TSESTree.VariableDeclarator): boolean {
  if (
    declarator.id.type !== AST_NODE_TYPES.Identifier ||
    declarator.id.typeAnnotation === null ||
    declarator.id.typeAnnotation === undefined
  ) {
    return false;
  }
  const typeNode = declarator.id.typeAnnotation.typeAnnotation;
  // readonly Foo[] or readonly [...]
  if (
    typeNode.type === AST_NODE_TYPES.TSTypeOperator &&
    typeNode.operator === "readonly"
  ) {
    return true;
  }
  // Readonly<...>
  if (
    typeNode.type === AST_NODE_TYPES.TSTypeReference &&
    typeNode.typeName.type === AST_NODE_TYPES.Identifier &&
    typeNode.typeName.name === "Readonly"
  ) {
    return true;
  }
  return false;
}

function isMutableInit(
  init: TSESTree.Expression,
  allowedConstructors: ReadonlySet<string>,
): boolean {
  if (init.type === AST_NODE_TYPES.NewExpression) {
    const callee = init.callee;
    if (callee.type === AST_NODE_TYPES.Identifier) {
      return !allowedConstructors.has(callee.name);
    }
    return true; // complex new expression — flag
  }
  if (init.type === AST_NODE_TYPES.ArrayExpression) {
    return true;
  }
  if (init.type === AST_NODE_TYPES.ObjectExpression) {
    return true;
  }
  return false;
}

export default createRule<[Options] | [], "noPackageVariable">({
  name: "no-package-variable",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description: "Prevent using package scope variables",
      recommended: true,
      requiresTypeChecking: false,
    },
    schema: [
      {
        type: "object",
        properties: {
          allowedConstructors: {
            type: "array",
            items: { type: "string" },
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
    const allowedConstructors = new Set<string>(
      options?.allowedConstructors ?? [],
    );

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
            declarator.id.type === AST_NODE_TYPES.ObjectPattern ||
            declarator.id.type === AST_NODE_TYPES.ArrayPattern
          ) {
            continue;
          }

          if (isReadonlyAnnotated(declarator)) {
            continue;
          }

          if (isMutableInit(declarator.init, allowedConstructors)) {
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
