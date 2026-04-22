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

// Functions that always return a constant ccstate type (Computed/Command).
// No type checker needed — these are well-known ccstate primitives.
const KNOWN_CONSTANT_FUNCTIONS = new Set(["computed", "command"]);

function isKnownConstantCall(node: TSESTree.CallExpression): boolean {
  return (
    node.callee.type === AST_NODE_TYPES.Identifier &&
    KNOWN_CONSTANT_FUNCTIONS.has(node.callee.name)
  );
}

// An object literal is considered a "signal object" when at least one property
// key ends with "$" — the project-wide convention for signal variables.
function isSignalObject(node: TSESTree.ObjectExpression): boolean {
  return node.properties.some(
    (prop) =>
      prop.type === AST_NODE_TYPES.Property &&
      prop.key.type === AST_NODE_TYPES.Identifier &&
      prop.key.name.endsWith("$"),
  );
}

// A top-level return is "constant" if it directly returns computed()/command()
// or an object whose keys follow the $-suffix signal convention.
function isConstantReturnExpression(node: TSESTree.Expression): boolean {
  if (node.type === AST_NODE_TYPES.CallExpression) {
    return isKnownConstantCall(node);
  }
  if (node.type === AST_NODE_TYPES.ObjectExpression) {
    return isSignalObject(node);
  }
  return false;
}

function functionBodyHasConstantReturn(body: TSESTree.BlockStatement): boolean {
  return body.body.some(
    (stmt) =>
      stmt.type === AST_NODE_TYPES.ReturnStatement &&
      stmt.argument !== null &&
      isConstantReturnExpression(stmt.argument),
  );
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
    // Heuristic: PascalCase.Member → likely an enum (e.g. LocalStorageKey.Theme).
    // Matches the project convention; non-standard const patterns are accepted
    // as a known trade-off to avoid the TypeScript language service.
    const obj = node.object;
    const prop = node.property;
    if (
      obj.type === AST_NODE_TYPES.Identifier &&
      prop.type === AST_NODE_TYPES.Identifier
    ) {
      return /^[A-Z][a-zA-Z]*$/.test(obj.name);
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
    // Populated at package scope by FunctionDeclaration visitor.
    // Pre-seeded with known ccstate primitives.
    const packageScopeConstantFunctions = new Set<string>(
      KNOWN_CONSTANT_FUNCTIONS,
    );

    // Non-package-scope calls grouped by callee name so Program:exit only
    // iterates entries that match known constant function names.
    const deferredCallsByName = new Map<string, TSESTree.CallExpression[]>();

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

    // O(1) scope depth counter — avoids per-node parent-chain traversal.
    let scopeDepth = 0;

    function enterScope() {
      scopeDepth++;
    }
    function exitScope() {
      scopeDepth--;
    }

    return {
      // Detect package-scope factory functions by AST shape.
      // Check depth BEFORE incrementing: depth === 0 means the declaration is
      // at package scope.
      FunctionDeclaration(node: TSESTree.FunctionDeclaration) {
        const atPackageScope = scopeDepth === 0 && node.id !== null;
        scopeDepth++;

        if (!atPackageScope) {
          return;
        }

        if (functionBodyHasConstantReturn(node.body) && node.id !== null) {
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
        // Package-scope calls are never violations.
        if (scopeDepth === 0) {
          return;
        }
        // Method calls (obj.method()) are never ccstate factory functions.
        if (node.callee.type !== AST_NODE_TYPES.Identifier) {
          return;
        }
        const name = node.callee.name;
        let calls = deferredCallsByName.get(name);
        if (calls === undefined) {
          calls = [];
          deferredCallsByName.set(name, calls);
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
