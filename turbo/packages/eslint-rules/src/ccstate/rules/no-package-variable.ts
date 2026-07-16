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
 *   Reflect.set(globalThis, "hiddenCache", new Map());
 *   getResource._cache = new Map();
 *   const getResource = createKeyedResourceFactory();
 */

import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";

interface Options {
  allowedConstructors?: string[];
}

type FunctionNode =
  | TSESTree.ArrowFunctionExpression
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression;

const MUTABLE_KEYED_CONSTRUCTORS = new Set([
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
]);

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
    ["Readonly", "ReadonlyMap", "ReadonlySet"].includes(typeNode.typeName.name)
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

function isMutableKeyedCollection(
  node: TSESTree.NewExpression,
  readonlyDeclarator: boolean,
): boolean {
  if (readonlyDeclarator) {
    return false;
  }
  return (
    node.callee.type === AST_NODE_TYPES.Identifier &&
    MUTABLE_KEYED_CONSTRUCTORS.has(node.callee.name)
  );
}

function enclosingFunction(node: TSESTree.Node): FunctionNode | null {
  let parent = node.parent;
  while (parent) {
    if (
      parent.type === AST_NODE_TYPES.FunctionDeclaration ||
      parent.type === AST_NODE_TYPES.FunctionExpression ||
      parent.type === AST_NODE_TYPES.ArrowFunctionExpression
    ) {
      return parent;
    }
    parent = parent.parent;
  }
  return null;
}

function memberPropertyName(node: TSESTree.MemberExpression): string | null {
  if (!node.computed && node.property.type === AST_NODE_TYPES.Identifier) {
    return node.property.name;
  }
  if (
    node.computed &&
    node.property.type === AST_NODE_TYPES.Literal &&
    typeof node.property.value === "string"
  ) {
    return node.property.value;
  }
  return null;
}

function isReflectSetGlobalCache(node: TSESTree.CallExpression): boolean {
  if (
    node.callee.type !== AST_NODE_TYPES.MemberExpression ||
    node.callee.object.type !== AST_NODE_TYPES.Identifier ||
    node.callee.object.name !== "Reflect" ||
    memberPropertyName(node.callee) !== "set"
  ) {
    return false;
  }
  const [target, property] = node.arguments;
  return (
    target?.type === AST_NODE_TYPES.Identifier &&
    target.name === "globalThis" &&
    property?.type === AST_NODE_TYPES.Literal &&
    typeof property.value === "string" &&
    /cache/i.test(property.value)
  );
}

export default createRule<
  [Options] | [],
  | "noFunctionPropertyCache"
  | "noGlobalCache"
  | "noPackageFactoryCache"
  | "noPackageVariable"
>({
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
      noFunctionPropertyCache:
        "Do not hide a cache on a function property. Give the resource an explicit bounded owner instead.",
      noGlobalCache:
        "Do not hide a cache on globalThis. Give the resource an explicit bounded owner instead.",
      noPackageFactoryCache:
        "Calling a factory that owns a mutable keyed collection at package scope creates a package-lifetime cache. Create it in a bounded owner instead.",
      noPackageVariable:
        "Variable & mutable object is not allowed in package scope, use signals instead.",
    },
  },
  create(context) {
    const options = context.options[0];
    const allowedConstructors = new Set<string>(
      options?.allowedConstructors ?? [],
    );
    const packageFunctions = new Map<string, FunctionNode>();
    const functionsWithMutableKeyedCollections = new WeakSet<FunctionNode>();
    const readonlyDeclaratorStack: boolean[] = [];
    const packageFactoryCalls: Array<{
      readonly callee: TSESTree.Expression;
      readonly node: TSESTree.VariableDeclarator;
    }> = [];

    return {
      FunctionDeclaration(node: TSESTree.FunctionDeclaration) {
        if (isPackageScope(node) && node.id !== null) {
          packageFunctions.set(node.id.name, node);
        }
      },
      VariableDeclarator(node: TSESTree.VariableDeclarator) {
        readonlyDeclaratorStack.push(isReadonlyAnnotated(node));
      },
      "VariableDeclarator:exit"() {
        readonlyDeclaratorStack.pop();
      },
      NewExpression(node: TSESTree.NewExpression) {
        if (
          !isMutableKeyedCollection(
            node,
            readonlyDeclaratorStack.at(-1) ?? false,
          )
        ) {
          return;
        }
        const owner = enclosingFunction(node);
        if (owner !== null && isPackageScope(owner)) {
          functionsWithMutableKeyedCollections.add(owner);
        }
      },
      AssignmentExpression(node: TSESTree.AssignmentExpression) {
        if (
          node.left.type === AST_NODE_TYPES.MemberExpression &&
          memberPropertyName(node.left) === "_cache"
        ) {
          context.report({
            node,
            messageId: "noFunctionPropertyCache",
          });
        }
      },
      CallExpression(node: TSESTree.CallExpression) {
        if (isReflectSetGlobalCache(node)) {
          context.report({
            node,
            messageId: "noGlobalCache",
          });
        }
      },
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
            declarator.id.type === AST_NODE_TYPES.Identifier &&
            (declarator.init.type === AST_NODE_TYPES.ArrowFunctionExpression ||
              declarator.init.type === AST_NODE_TYPES.FunctionExpression)
          ) {
            packageFunctions.set(declarator.id.name, declarator.init);
          }

          if (
            declarator.init.type === AST_NODE_TYPES.CallExpression &&
            declarator.init.callee.type !== AST_NODE_TYPES.Super &&
            declarator.init.callee.type !== AST_NODE_TYPES.ImportExpression
          ) {
            packageFactoryCalls.push({
              callee: declarator.init.callee,
              node: declarator,
            });
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
      "Program:exit"() {
        for (const { callee, node } of packageFactoryCalls) {
          const factory =
            callee.type === AST_NODE_TYPES.Identifier
              ? packageFunctions.get(callee.name)
              : callee.type === AST_NODE_TYPES.ArrowFunctionExpression ||
                  callee.type === AST_NODE_TYPES.FunctionExpression
                ? callee
                : undefined;
          if (
            factory !== undefined &&
            functionsWithMutableKeyedCollections.has(factory)
          ) {
            context.report({
              node,
              messageId: "noPackageFactoryCache",
            });
          }
        }
      },
    };
  },
});
