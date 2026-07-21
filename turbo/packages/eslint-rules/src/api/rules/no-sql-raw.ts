import {
  AST_NODE_TYPES,
  ESLintUtils,
  type TSESTree,
} from "@typescript-eslint/utils";
import { isDrizzleSymbol } from "../drizzle.ts";
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

export const noSqlRaw = createRule({
  name: "no-sql-raw",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Drizzle sql.raw because it bypasses parameter binding",
      recommended: true,
      requiresTypeChecking: true,
    },
    schema: [],
    messages: {
      sqlRaw:
        "Drizzle sql.raw bypasses parameter binding. Compose SQL with the sql tagged template so interpolated values are sent as driver parameters.",
    },
  },
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();

    function isDrizzleRawMember(node: TSESTree.MemberExpression): boolean {
      if (memberName(node) !== "raw") {
        return false;
      }
      const tsProperty = services.esTreeNodeToTSNodeMap.get(node.property);
      const directSymbol = checker.getSymbolAtLocation(tsProperty);
      if (isDrizzleSymbol(checker, directSymbol)) {
        return true;
      }
      const tsObject = services.esTreeNodeToTSNodeMap.get(node.object);
      const objectType = checker.getTypeAtLocation(tsObject);
      return isDrizzleSymbol(
        checker,
        checker.getPropertyOfType(objectType, "raw"),
      );
    }

    function destructuresDrizzleRaw(node: TSESTree.Property): boolean {
      if (
        node.parent.type !== AST_NODE_TYPES.ObjectPattern ||
        propertyName(node) !== "raw"
      ) {
        return false;
      }
      const tsPattern = services.esTreeNodeToTSNodeMap.get(node.parent);
      const patternType = checker.getTypeAtLocation(tsPattern);
      return isDrizzleSymbol(
        checker,
        checker.getPropertyOfType(patternType, "raw"),
      );
    }

    return {
      MemberExpression(node: TSESTree.MemberExpression): void {
        if (isDrizzleRawMember(node)) {
          context.report({ node, messageId: "sqlRaw" });
        }
      },
      Property(node: TSESTree.Property): void {
        if (destructuresDrizzleRaw(node)) {
          context.report({ node, messageId: "sqlRaw" });
        }
      },
    };
  },
});
