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

import {
  AST_NODE_TYPES,
  ESLintUtils,
  type TSESTree,
} from "@typescript-eslint/utils";
import { SyntaxKind, TypeFlags, type Type, type TypeChecker } from "typescript";
import { createRule, isMutableObjectType } from "../utils.ts";

// Performance optimization: Cache results to avoid repeated type checking
// Note: WeakMap is used so memory is automatically freed when nodes are garbage collected
const enumMemberCache = new WeakMap<TSESTree.MemberExpression, boolean>();
const constantReturnTypeCache = new WeakMap<Type, boolean>();

function isEnumMember(
  node: TSESTree.MemberExpression,
  checker: TypeChecker,
  services: import("@typescript-eslint/utils").ParserServicesWithTypeInformation,
): boolean {
  // Check cache first
  const cached = enumMemberCache.get(node);
  if (cached !== undefined) {
    return cached;
  }

  if (
    node.object.type !== AST_NODE_TYPES.Identifier ||
    node.property.type !== AST_NODE_TYPES.Identifier
  ) {
    enumMemberCache.set(node, false);
    return false;
  }

  try {
    // Check if the object refers to an enum
    const objectTsNode = services.esTreeNodeToTSNodeMap.get(node.object);
    const objectSymbol = checker.getSymbolAtLocation(objectTsNode);

    if (objectSymbol?.valueDeclaration?.kind === SyntaxKind.EnumDeclaration) {
      enumMemberCache.set(node, true);
      return true;
    }

    // Also check the type of the member expression result
    const tsNode = services.esTreeNodeToTSNodeMap.get(node);
    const type = checker.getTypeAtLocation(tsNode);

    // Check if it's a literal type (which enum members are)
    const isLiteralType =
      type.flags &
      (TypeFlags.String |
        TypeFlags.Number |
        TypeFlags.Boolean |
        TypeFlags.StringLiteral |
        TypeFlags.NumberLiteral |
        TypeFlags.BooleanLiteral);

    if (isLiteralType) {
      // Additional check: is the object a known enum-like identifier?
      const objectName = node.object.name;
      const result = objectName
        ? /^[A-Z][a-zA-Z]*Key$|^[A-Z][a-zA-Z]*Type$|^[A-Z][a-zA-Z]*$/.test(
            objectName,
          )
        : false;
      enumMemberCache.set(node, result);
      return result;
    }
  } catch {
    // If type checking fails, fall back to heuristic
    const objectName = node.object.name;
    const result = objectName
      ? /^[A-Z][a-zA-Z]*Key$|^[A-Z][a-zA-Z]*Type$|^[A-Z][a-zA-Z]*$/.test(
          objectName,
        )
      : false;
    enumMemberCache.set(node, result);
    return result;
  }

  enumMemberCache.set(node, false);
  return false;
}

function isConstantValue(
  node: TSESTree.Node,
  checker?: TypeChecker,
  services?: import("@typescript-eslint/utils").ParserServicesWithTypeInformation,
): boolean {
  if (node.type === AST_NODE_TYPES.Literal) {
    return true;
  }
  if (node.type === AST_NODE_TYPES.TemplateLiteral) {
    return node.expressions.length === 0;
  }
  if (node.type === AST_NODE_TYPES.UnaryExpression) {
    return (
      node.operator === "-" && isConstantValue(node.argument, checker, services)
    );
  }
  if (node.type === AST_NODE_TYPES.ArrayExpression) {
    return node.elements.every(
      (el) => el && isConstantValue(el, checker, services),
    );
  }
  if (node.type === AST_NODE_TYPES.ObjectExpression) {
    return node.properties.every((prop) => {
      if (prop.type === AST_NODE_TYPES.Property) {
        return isConstantValue(prop.value, checker, services);
      }
      return false;
    });
  }
  if (node.type === AST_NODE_TYPES.Identifier) {
    return false;
  }
  if (node.type === AST_NODE_TYPES.MemberExpression) {
    // Handle enum member access like LocalStorageKey.Theme
    if (checker && services) {
      return isEnumMember(node, checker, services);
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
      // For arrow functions with expression body: () => 42
      return isConstantValue(node.body, checker, services);
    }
    if (
      node.body.type === AST_NODE_TYPES.BlockStatement &&
      node.body.body.length === 1 &&
      node.body.body[0].type === AST_NODE_TYPES.ReturnStatement &&
      node.body.body[0].argument
    ) {
      return isConstantValue(node.body.body[0].argument, checker, services);
    }
    return false;
  }
  return false;
}

function hasOnlyConstantArguments(
  node: TSESTree.CallExpression,
  checker: TypeChecker,
  services: import("@typescript-eslint/utils").ParserServicesWithTypeInformation,
): boolean {
  return node.arguments.every((arg) => {
    if (arg.type === AST_NODE_TYPES.SpreadElement) {
      return false;
    }
    return isConstantValue(arg, checker, services);
  });
}

function isComputedOrCommandType(typeString: string): boolean {
  return (
    typeString.startsWith("Computed<") ||
    typeString === "Computed" ||
    typeString.startsWith("Command<") ||
    typeString === "Command"
  );
}

function checkObjectProperties(type: Type, checker: TypeChecker): boolean {
  const properties = checker.getPropertiesOfType(type);

  // Optimization: Skip objects with too many properties (likely not signal containers)
  if (properties.length > 20) {
    return false;
  }

  if (properties.length === 0) {
    return false;
  }

  // Check only first few properties for performance
  const propertiesToCheck = properties.slice(0, 10);
  for (const property of propertiesToCheck) {
    try {
      // Quick check: if property name ends with $, it's likely a signal
      if (property.name.endsWith("$")) {
        return true;
      }

      const declaration =
        property.valueDeclaration ?? property.declarations?.[0];
      if (!declaration) {
        continue;
      }
      const propertyType = checker.getTypeOfSymbolAtLocation(
        property,
        declaration,
      );
      const propertyTypeString = checker.typeToString(propertyType);

      // If any property is Computed/Command, consider this type relevant
      if (isComputedOrCommandType(propertyTypeString)) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
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
      requiresTypeChecking: true,
    },
    schema: [],
    messages: {
      mustBePackageScope:
        'Function "{{name}}" returns constant type and has only literal arguments. It must be called at package scope, not at runtime.',
    },
  },
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();

    // Non-package-scope calls grouped by callee name. Using a Map means Program:exit
    // only iterates entries for "computed" and packageScopeConstantFunctions names instead
    // of all ~30K non-package-scope calls.
    const deferredCallsByName = new Map<string, TSESTree.CallExpression[]>();

    // Track functions that return constant types and are defined at package scope
    const packageScopeConstantFunctions = new Set<string>();

    function isConstantReturnType(type: Type): boolean {
      // Check cache first
      const cached = constantReturnTypeCache.get(type);
      if (cached !== undefined) {
        return cached;
      }

      const typeString = checker.typeToString(type);

      // Fast path: Check if it's directly Computed/Command type (string check is fast)
      if (isComputedOrCommandType(typeString)) {
        constantReturnTypeCache.set(type, true);
        return true;
      }

      // Primary condition: if it's not mutable, it's constant (covers all immutable types)
      if (!isMutableObjectType(type, services, checker)) {
        constantReturnTypeCache.set(type, true);
        return true;
      }

      // Special handling for objects that contain Computed/Command properties (even if mutable)
      // This maintains backward compatibility for signal-containing objects
      const hasSignalProperties = checkObjectProperties(type, checker);
      constantReturnTypeCache.set(type, hasSignalProperties);
      return hasSignalProperties;
    }

    function functionReturnsConstant(node: TSESTree.CallExpression): boolean {
      // Early return for known non-constant functions
      if (node.callee.type === AST_NODE_TYPES.Identifier) {
        const name = node.callee.name;
        // Common functions that definitely don't return constants
        const nonConstantFunctions = [
          "setTimeout",
          "setInterval",
          "setImmediate",
          "fetch",
          "Promise",
          "XMLHttpRequest",
          "addEventListener",
          "removeEventListener",
          "Math.random",
          "Date.now",
          "performance.now",
          "requestAnimationFrame",
          "requestIdleCallback",
        ];
        if (nonConstantFunctions.includes(name)) {
          return false;
        }
      }

      const tsNode = services.esTreeNodeToTSNodeMap.get(node);
      const type = checker.getTypeAtLocation(tsNode);

      // Check if the call expression returns a constant type
      return isConstantReturnType(type);
    }

    function processCallsForName(name: string, requiresTypeCheck: boolean) {
      const calls = deferredCallsByName.get(name);
      if (!calls) {
        return;
      }

      for (const node of calls) {
        if (node.arguments.length === 0) {
          continue;
        }
        // packageScopeConstantFunctions entries need a type re-check to filter async
        // wrappers (e.g. Promise<T>) that slip through the declaration-level check.
        if (requiresTypeCheck && !functionReturnsConstant(node)) {
          continue;
        }
        if (!hasOnlyConstantArguments(node, checker, services)) {
          continue;
        }
        context.report({
          node,
          messageId: "mustBePackageScope",
          data: { name },
        });
      }
    }

    function processDeferredCallChecks() {
      // computed() always returns Computed<> — no type check needed
      processCallsForName("computed", false);

      // Package-scope helper functions need a type re-check at the call site
      for (const name of packageScopeConstantFunctions) {
        processCallsForName(name, true);
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

        // Check if this function returns a constant type (immutable or signal-containing)
        const hasConstantReturn = node.body.body.some((stmt) => {
          if (stmt.type === AST_NODE_TYPES.ReturnStatement && stmt.argument) {
            // Check call expressions, object expressions, and other return types
            const tsNode = services.esTreeNodeToTSNodeMap.get(stmt.argument);
            const type = checker.getTypeAtLocation(tsNode);
            return isConstantReturnType(type);
          }
          return false;
        });

        if (hasConstantReturn && node.id) {
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
        // Method calls (obj.method()) are never ccstate factory functions at package scope
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
        processDeferredCallChecks();
        // WeakMap automatically handles memory cleanup when nodes are garbage collected
      },
    };
  },
});
