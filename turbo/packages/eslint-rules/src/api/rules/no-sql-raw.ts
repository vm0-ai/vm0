import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { isDrizzleSqlTag, memberName, propertyName } from "../syntax.ts";
import { createRule } from "../utils.ts";

export const noSqlRaw = createRule({
  name: "no-sql-raw",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Drizzle sql.raw because it bypasses parameter binding",
      recommended: true,
    },
    schema: [],
    messages: {
      sqlRaw:
        "Drizzle sql.raw bypasses parameter binding. Compose SQL with the sql tagged template so interpolated values are sent as driver parameters.",
    },
  },
  create(context) {
    function isDrizzleRawMember(node: TSESTree.MemberExpression): boolean {
      return (
        memberName(node) === "raw" &&
        isDrizzleSqlTag(context.sourceCode, node.object)
      );
    }

    function destructuresDrizzleRaw(node: TSESTree.Property): boolean {
      if (
        node.parent.type !== AST_NODE_TYPES.ObjectPattern ||
        propertyName(node) !== "raw"
      ) {
        return false;
      }
      const declarator = node.parent.parent;
      return (
        declarator.type === AST_NODE_TYPES.VariableDeclarator &&
        declarator.id === node.parent &&
        declarator.init !== null &&
        isDrizzleSqlTag(context.sourceCode, declarator.init)
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
