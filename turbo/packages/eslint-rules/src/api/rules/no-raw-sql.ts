import {
  AST_NODE_TYPES,
  ASTUtils,
  type TSESTree,
} from "@typescript-eslint/utils";

import { createRule } from "../utils.ts";

export const noRawSql = createRule({
  name: "no-raw-sql",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Prevent hand-written raw SQL through the Drizzle sql escape hatch in application query code",
      recommended: true,
      requiresTypeChecking: false,
    },
    schema: [],
    messages: {
      rawSql:
        "Hand-written raw SQL is not schema-checked and its `sql<...>` generic performs no runtime decoding. Use schema-aware Drizzle query builders and operators, or add this file to the raw-SQL allowlist in eslint.config.mjs with a justification (see issue #22106).",
    },
  },
  create(context) {
    function isDrizzleSqlBinding(identifier: TSESTree.Identifier): boolean {
      const variable = ASTUtils.findVariable(
        context.sourceCode.getScope(identifier),
        identifier,
      );
      const definition = variable?.defs.find((candidate) => {
        return candidate.type === "ImportBinding";
      });
      if (
        !definition ||
        definition.parent.type !== AST_NODE_TYPES.ImportDeclaration ||
        definition.parent.source.value !== "drizzle-orm" ||
        definition.parent.importKind === "type"
      ) {
        return false;
      }

      const specifier = definition.node;
      if (specifier.type === AST_NODE_TYPES.ImportNamespaceSpecifier) {
        return identifier.parent.type === AST_NODE_TYPES.MemberExpression
          ? memberName(identifier.parent) === "sql"
          : false;
      }
      if (
        specifier.type !== AST_NODE_TYPES.ImportSpecifier ||
        specifier.importKind === "type"
      ) {
        return false;
      }
      return (
        (specifier.imported.type === AST_NODE_TYPES.Identifier &&
          specifier.imported.name === "sql") ||
        (specifier.imported.type === AST_NODE_TYPES.Literal &&
          specifier.imported.value === "sql")
      );
    }

    return {
      Identifier(node: TSESTree.Identifier): void {
        if (!isReferencePosition(node) || !isDrizzleSqlBinding(node)) {
          return;
        }
        context.report({
          node,
          messageId: "rawSql",
        });
      },
    };
  },
});

function memberName(node: TSESTree.MemberExpression): string | null {
  if (!node.computed && node.property.type === AST_NODE_TYPES.Identifier) {
    return node.property.name;
  }
  if (node.computed && node.property.type === AST_NODE_TYPES.Literal) {
    return typeof node.property.value === "string" ? node.property.value : null;
  }
  return null;
}

function isReferencePosition(node: TSESTree.Identifier): boolean {
  const parent = node.parent;
  if (
    parent.type === AST_NODE_TYPES.ImportSpecifier ||
    parent.type === AST_NODE_TYPES.ImportNamespaceSpecifier ||
    parent.type === AST_NODE_TYPES.ImportDefaultSpecifier
  ) {
    return false;
  }
  if (
    parent.type === AST_NODE_TYPES.MemberExpression &&
    parent.property === node &&
    !parent.computed
  ) {
    return false;
  }
  return true;
}
