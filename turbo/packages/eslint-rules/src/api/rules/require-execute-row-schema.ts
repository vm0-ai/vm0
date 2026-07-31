import {
  AST_NODE_TYPES,
  ESLintUtils,
  type TSESTree,
} from "@typescript-eslint/utils";

import { isDrizzleDeclaration } from "../drizzle.ts";
import { createRule } from "../utils.ts";

function memberName(node: TSESTree.MemberExpression): string | null {
  if (!node.computed && node.property.type === AST_NODE_TYPES.Identifier) {
    return node.property.name;
  }
  if (node.computed && node.property.type === AST_NODE_TYPES.Literal) {
    return typeof node.property.value === "string" ? node.property.value : null;
  }
  return null;
}

function propertyName(node: TSESTree.Property): string | null {
  if (!node.computed && node.key.type === AST_NODE_TYPES.Identifier) {
    return node.key.name;
  }
  if (node.key.type === AST_NODE_TYPES.Literal) {
    return typeof node.key.value === "string" ? node.key.value : null;
  }
  return null;
}

function onlyDestructuresRowCount(pattern: TSESTree.BindingName): boolean {
  if (
    pattern.type !== AST_NODE_TYPES.ObjectPattern ||
    pattern.properties.length !== 1
  ) {
    return false;
  }
  const [property] = pattern.properties;
  return (
    property?.type === AST_NODE_TYPES.Property &&
    propertyName(property) === "rowCount"
  );
}

interface ExecuteUsage {
  readonly kind: "discarded" | "row-count" | "raw-result";
  readonly assertion: TSESTree.Node | null;
}

function resultAssertion(node: TSESTree.CallExpression): TSESTree.Node | null {
  let current: TSESTree.Node = node;

  while (current.parent) {
    const parent: TSESTree.Node = current.parent;
    if (
      (parent.type === AST_NODE_TYPES.AwaitExpression &&
        parent.argument === current) ||
      (parent.type === AST_NODE_TYPES.ChainExpression &&
        parent.expression === current) ||
      (parent.type === AST_NODE_TYPES.TSNonNullExpression &&
        parent.expression === current)
    ) {
      current = parent;
      continue;
    }
    if (
      (parent.type === AST_NODE_TYPES.TSAsExpression ||
        parent.type === AST_NODE_TYPES.TSTypeAssertion) &&
      parent.expression === current
    ) {
      return parent;
    }
    if (
      parent.type === AST_NODE_TYPES.MemberExpression &&
      parent.object === current
    ) {
      current = parent;
      continue;
    }
    if (
      parent.type === AST_NODE_TYPES.CallExpression &&
      parent.callee === current
    ) {
      current = parent;
      continue;
    }
    break;
  }

  return null;
}

function executeUsage(node: TSESTree.CallExpression): ExecuteUsage {
  let current: TSESTree.Node = node;
  const assertion = resultAssertion(node);

  while (current.parent) {
    const parent: TSESTree.Node = current.parent;
    if (
      (parent.type === AST_NODE_TYPES.AwaitExpression &&
        parent.argument === current) ||
      (parent.type === AST_NODE_TYPES.ChainExpression &&
        parent.expression === current) ||
      (parent.type === AST_NODE_TYPES.TSNonNullExpression &&
        parent.expression === current) ||
      ((parent.type === AST_NODE_TYPES.TSAsExpression ||
        parent.type === AST_NODE_TYPES.TSTypeAssertion) &&
        parent.expression === current)
    ) {
      current = parent;
      continue;
    }
    if (
      parent.type === AST_NODE_TYPES.MemberExpression &&
      parent.object === current
    ) {
      return {
        kind: memberName(parent) === "rowCount" ? "row-count" : "raw-result",
        assertion,
      };
    }
    if (
      parent.type === AST_NODE_TYPES.VariableDeclarator &&
      parent.init === current
    ) {
      return {
        kind: onlyDestructuresRowCount(parent.id) ? "row-count" : "raw-result",
        assertion,
      };
    }
    if (
      parent.type === AST_NODE_TYPES.ExpressionStatement &&
      parent.expression === current
    ) {
      return { kind: "discarded", assertion };
    }
    return { kind: "raw-result", assertion };
  }

  return { kind: "raw-result", assertion };
}

export const requireExecuteRowSchema = createRule({
  name: "require-execute-row-schema",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Require runtime schemas for rows returned by Drizzle execute",
      recommended: true,
      requiresTypeChecking: true,
    },
    schema: [],
    messages: {
      rowTypeArgument:
        "Drizzle execute row generics are compile-only. Remove the type argument and use executeRawRows(...) with a runtime schema.",
      rawResult:
        "Do not consume raw rows from Drizzle execute. Use executeRawRows(...) with a runtime schema; direct execute is only for discarded results or rowCount.",
      assertedResult:
        "A TypeScript assertion does not validate a Drizzle execute result. Decode rows with executeRawRows(...) instead.",
      executeReference:
        "Do not alias Drizzle execute. Call it directly so result safety can be enforced.",
    },
  },
  create(context) {
    // ESTree decodes escaped identifiers and string literals, so a backslash
    // may be part of a source spelling of "execute".
    if (
      !context.sourceCode.text.includes("execute") &&
      !context.sourceCode.text.includes("\\")
    ) {
      return {};
    }

    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();

    function isDrizzleExecuteMember(node: TSESTree.MemberExpression): boolean {
      if (memberName(node) !== "execute") {
        return false;
      }
      const tsProperty = services.esTreeNodeToTSNodeMap.get(node.property);
      const symbol = checker.getSymbolAtLocation(tsProperty);
      return (
        symbol?.declarations?.some((declaration) => {
          return isDrizzleDeclaration(declaration);
        }) === true
      );
    }

    function destructuresDrizzleExecute(node: TSESTree.Property): boolean {
      if (
        node.parent.type !== AST_NODE_TYPES.ObjectPattern ||
        propertyName(node) !== "execute"
      ) {
        return false;
      }
      const tsPattern = services.esTreeNodeToTSNodeMap.get(node.parent);
      const patternType = checker.getTypeAtLocation(tsPattern);
      const executeSymbol = checker.getPropertyOfType(patternType, "execute");
      return (
        executeSymbol?.declarations?.some((declaration) => {
          return isDrizzleDeclaration(declaration);
        }) === true
      );
    }

    return {
      CallExpression(node: TSESTree.CallExpression): void {
        if (
          node.callee.type !== AST_NODE_TYPES.MemberExpression ||
          !isDrizzleExecuteMember(node.callee)
        ) {
          return;
        }

        if (node.typeArguments?.params.length) {
          context.report({ node, messageId: "rowTypeArgument" });
        }

        const usage = executeUsage(node);
        if (usage.assertion) {
          context.report({
            node: usage.assertion,
            messageId: "assertedResult",
          });
        }
        if (usage.kind === "raw-result") {
          context.report({ node, messageId: "rawResult" });
        }
      },
      MemberExpression(node: TSESTree.MemberExpression): void {
        if (
          (node.parent.type === AST_NODE_TYPES.CallExpression &&
            node.parent.callee === node) ||
          !isDrizzleExecuteMember(node)
        ) {
          return;
        }
        context.report({ node, messageId: "executeReference" });
      },
      Property(node: TSESTree.Property): void {
        if (destructuresDrizzleExecute(node)) {
          context.report({ node, messageId: "executeReference" });
        }
      },
    };
  },
});
