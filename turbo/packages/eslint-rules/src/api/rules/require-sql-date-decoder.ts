import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../utils.ts";

function containsDateType(node: TSESTree.TypeNode): boolean {
  switch (node.type) {
    case AST_NODE_TYPES.TSTypeReference:
      return (
        node.typeName.type === AST_NODE_TYPES.Identifier &&
        node.typeName.name === "Date"
      );
    case AST_NODE_TYPES.TSUnionType:
    case AST_NODE_TYPES.TSIntersectionType:
      return node.types.some(containsDateType);
    default:
      return false;
  }
}

function memberName(node: TSESTree.MemberExpression): string | null {
  if (!node.computed && node.property.type === AST_NODE_TYPES.Identifier) {
    return node.property.name;
  }
  if (node.computed && node.property.type === AST_NODE_TYPES.Literal) {
    return typeof node.property.value === "string" ? node.property.value : null;
  }
  return null;
}

function hasMapWithCall(node: TSESTree.TaggedTemplateExpression): boolean {
  let current: TSESTree.Node = node;

  while (current.parent) {
    const member: TSESTree.Node = current.parent;
    if (
      member.type !== AST_NODE_TYPES.MemberExpression ||
      member.object !== current
    ) {
      return false;
    }

    const call: TSESTree.Node | undefined = member.parent;
    if (
      call?.type !== AST_NODE_TYPES.CallExpression ||
      call.callee !== member
    ) {
      return false;
    }
    if (memberName(member) === "mapWith") {
      return true;
    }
    current = call;
  }

  return false;
}

export const requireSqlDateDecoder = createRule({
  name: "require-sql-date-decoder",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Require a runtime decoder for Date-valued Drizzle sql expressions",
      recommended: true,
      requiresTypeChecking: false,
    },
    schema: [],
    messages: {
      missingDecoder:
        "`sql<Date>` only declares a static type. Call `.mapWith(...)` with a timestamp column decoder before using the expression.",
    },
  },
  create(context) {
    const sqlIdentifiers = new Set<string>();
    const drizzleNamespaces = new Set<string>();

    function isDrizzleSqlTag(tag: TSESTree.Expression): boolean {
      if (tag.type === AST_NODE_TYPES.Identifier) {
        return sqlIdentifiers.has(tag.name);
      }
      return (
        tag.type === AST_NODE_TYPES.MemberExpression &&
        tag.object.type === AST_NODE_TYPES.Identifier &&
        drizzleNamespaces.has(tag.object.name) &&
        memberName(tag) === "sql"
      );
    }

    return {
      ImportDeclaration(node: TSESTree.ImportDeclaration): void {
        if (node.source.value !== "drizzle-orm") {
          return;
        }

        for (const specifier of node.specifiers) {
          if (specifier.type === AST_NODE_TYPES.ImportNamespaceSpecifier) {
            drizzleNamespaces.add(specifier.local.name);
            continue;
          }
          if (
            specifier.type === AST_NODE_TYPES.ImportSpecifier &&
            ((specifier.imported.type === AST_NODE_TYPES.Identifier &&
              specifier.imported.name === "sql") ||
              (specifier.imported.type === AST_NODE_TYPES.Literal &&
                specifier.imported.value === "sql"))
          ) {
            sqlIdentifiers.add(specifier.local.name);
          }
        }
      },
      TaggedTemplateExpression(node: TSESTree.TaggedTemplateExpression): void {
        const typeArgument = node.typeArguments?.params[0];
        if (
          !typeArgument ||
          !containsDateType(typeArgument) ||
          !isDrizzleSqlTag(node.tag) ||
          hasMapWithCall(node)
        ) {
          return;
        }

        context.report({
          node,
          messageId: "missingDecoder",
        });
      },
    };
  },
});
