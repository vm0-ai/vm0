/**
 * ESLint rule: computed-const-args-package-scope
 *
 * Enforces that functions returning constant types (like Computed/Command)
 * with literal arguments must be called at package scope, not at runtime.
 *
 * Good:
 *   const theme$ = localStorageSignal('theme'); // At package scope
 *
 * Bad:
 *   function setup() {
 *     const theme$ = localStorageSignal('theme'); // Inside function
 *   }
 */

import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";

function isConstantTypeRef(typeNode: TSESTree.TypeNode): boolean {
  if (typeNode.type === AST_NODE_TYPES.TSTypeReference) {
    const name = typeNode.typeName;
    if (name.type === AST_NODE_TYPES.Identifier) {
      return name.name === "Computed" || name.name === "Command";
    }
  }
  if (
    typeNode.type === AST_NODE_TYPES.TSUnionType ||
    typeNode.type === AST_NODE_TYPES.TSIntersectionType
  ) {
    return typeNode.types.some(isConstantTypeRef);
  }
  return false;
}

function isConstantValue(node: TSESTree.Node): boolean {
  if (node.type === AST_NODE_TYPES.Literal) {
    return true;
  }
  if (node.type === AST_NODE_TYPES.TemplateLiteral) {
    return node.expressions.length === 0;
  }
  if (node.type === AST_NODE_TYPES.UnaryExpression) {
    return node.operator === "-" && isConstantValue(node.argument);
  }
  if (node.type === AST_NODE_TYPES.ArrayExpression) {
    return node.elements.every((el) => el !== null && isConstantValue(el));
  }
  if (node.type === AST_NODE_TYPES.ObjectExpression) {
    return node.properties.every((prop) => {
      if (prop.type === AST_NODE_TYPES.Property) {
        return isConstantValue(prop.value);
      }
      return false;
    });
  }
  if (node.type === AST_NODE_TYPES.Identifier) {
    return false;
  }
  if (node.type === AST_NODE_TYPES.MemberExpression) {
    // Heuristic: enum member access like LocalStorageKey.Theme
    const obj = node.object;
    const prop = node.property;
    if (
      obj.type === AST_NODE_TYPES.Identifier &&
      prop.type === AST_NODE_TYPES.Identifier
    ) {
      return /^[A-Z][a-zA-Z]*Key$|^[A-Z][a-zA-Z]*Type$|^[A-Z][a-zA-Z]*$/.test(
        obj.name,
      );
    }
    return false;
  }
  if (
    node.type === AST_NODE_TYPES.ArrowFunctionExpression ||
    node.type === AST_NODE_TYPES.FunctionExpression
  ) {
    if (
      node.type === AST_NODE_TYPES.ArrowFunctionExpression &&
      node.expression
    ) {
      return isConstantValue(node.body);
    }
    if (
      node.body.type === AST_NODE_TYPES.BlockStatement &&
      node.body.body.length === 1 &&
      node.body.body[0].type === AST_NODE_TYPES.ReturnStatement &&
      node.body.body[0].argument !== null &&
      node.body.body[0].argument !== undefined
    ) {
      return isConstantValue(node.body.body[0].argument);
    }
    return false;
  }
  return false;
}

function hasOnlyConstantArguments(node: TSESTree.CallExpression): boolean {
  return node.arguments.every((arg) => {
    if (arg.type === AST_NODE_TYPES.SpreadElement) {
      return false;
    }
    return isConstantValue(arg);
  });
}

export default createRule({
  name: "computed-const-args-package-scope",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Enforce that functions returning constant types with literal arguments must be called at package scope",
      recommended: true,
      requiresTypeChecking: false,
    },
    schema: [],
    messages: {
      mustBePackageScope:
        'Function "{{name}}" returns constant type and has only literal arguments. It must be called at package scope, not at runtime.',
    },
  },
  create(context) {
    // Non-package-scope calls grouped by callee name.
    const deferredCallsByName = new Map<string, TSESTree.CallExpression[]>();

    // Functions known to return Computed/Command: seeded with computed() itself,
    // extended at declaration time for package-scope helper functions.
    const packageScopeConstantFunctions = new Set<string>([
      "computed",
      "command",
    ]);

    function functionDeclarationHasConstantReturn(
      node: TSESTree.FunctionDeclaration,
    ): boolean {
      // 1. Explicit return type annotation: ): Computed<...> or ): Command<...>
      if (
        node.returnType !== null &&
        node.returnType !== undefined &&
        isConstantTypeRef(node.returnType.typeAnnotation)
      ) {
        return true;
      }
      // 2. Return statement directly calls a known constant factory
      return node.body.body.some((stmt) => {
        if (
          stmt.type !== AST_NODE_TYPES.ReturnStatement ||
          stmt.argument === null ||
          stmt.argument === undefined
        ) {
          return false;
        }
        const expr = stmt.argument;
        if (expr.type !== AST_NODE_TYPES.CallExpression) {
          return false;
        }
        if (expr.callee.type !== AST_NODE_TYPES.Identifier) {
          return false;
        }
        return packageScopeConstantFunctions.has(expr.callee.name);
      });
    }

    function processCallsForName(name: string) {
      const calls = deferredCallsByName.get(name);
      if (calls === undefined) {
        return;
      }
      for (const node of calls) {
        if (node.arguments.length === 0) {
          continue;
        }
        if (!hasOnlyConstantArguments(node)) {
          continue;
        }
        context.report({
          node,
          messageId: "mustBePackageScope",
          data: { name },
        });
      }
    }

    // Depth counter for function-like scopes — O(1) alternative to isInPackageScope
    // per-node parent-chain traversal. Incremented on enter, decremented on exit.
    let scopeDepth = 0;

    function enterScope() {
      scopeDepth++;
    }
    function exitScope() {
      scopeDepth--;
    }

    return {
      // Track function declarations that return constant types at package scope.
      // Check depth BEFORE incrementing: depth===0 means the declaration is at package scope.
      FunctionDeclaration(node: TSESTree.FunctionDeclaration) {
        const atPackageScope = scopeDepth === 0 && node.id !== null;
        scopeDepth++;

        if (!atPackageScope) {
          return;
        }

        if (functionDeclarationHasConstantReturn(node) && node.id !== null) {
          packageScopeConstantFunctions.add(node.id.name);
        }
      },
      "FunctionDeclaration:exit": exitScope,

      FunctionExpression: enterScope,
      "FunctionExpression:exit": exitScope,
      ArrowFunctionExpression: enterScope,
      "ArrowFunctionExpression:exit": exitScope,
      MethodDefinition: enterScope,
      "MethodDefinition:exit": exitScope,
      ClassDeclaration: enterScope,
      "ClassDeclaration:exit": exitScope,
      ClassExpression: enterScope,
      "ClassExpression:exit": exitScope,

      CallExpression(node: TSESTree.CallExpression) {
        // Package-scope calls can never be violations — skip immediately (O(1) depth check)
        if (scopeDepth === 0) {
          return;
        }
        // Method calls (obj.method()) are never ccstate factory functions
        if (node.callee.type !== AST_NODE_TYPES.Identifier) {
          return;
        }
        const functionName = node.callee.name;
        // Group by callee name so Program:exit can skip all irrelevant names in O(1)
        let calls = deferredCallsByName.get(functionName);
        if (calls === undefined) {
          calls = [];
          deferredCallsByName.set(functionName, calls);
        }
        calls.push(node);
      },

      // Process all deferred checks after we've seen all function declarations
      "Program:exit"() {
        for (const name of packageScopeConstantFunctions) {
          processCallsForName(name);
        }
      },
    };
  },
});
