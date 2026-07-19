import {
  AST_NODE_TYPES,
  ASTUtils,
  type TSESTree,
} from "@typescript-eslint/utils";

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
        "Prevent Date-valued Drizzle sql type assertions without a runtime decoder",
      recommended: true,
      requiresTypeChecking: false,
    },
    schema: [],
    messages: {
      missingDecoder:
        "`sql<Date>` does not decode database values. Select a Drizzle column or helper directly, call `.mapWith(...)` for a returned raw expression, or remove the Date generic when the SQL is not returned.",
    },
  },
  create(context) {
    function drizzleImportKind(
      identifier: TSESTree.Identifier,
    ): "namespace" | "sql" | null {
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
        return null;
      }

      const specifier = definition.node;
      if (specifier.type === AST_NODE_TYPES.ImportNamespaceSpecifier) {
        return "namespace";
      }
      if (
        specifier.type !== AST_NODE_TYPES.ImportSpecifier ||
        specifier.importKind === "type"
      ) {
        return null;
      }
      if (
        (specifier.imported.type === AST_NODE_TYPES.Identifier &&
          specifier.imported.name === "sql") ||
        (specifier.imported.type === AST_NODE_TYPES.Literal &&
          specifier.imported.value === "sql")
      ) {
        return "sql";
      }
      return null;
    }

    function isDrizzleSqlTag(tag: TSESTree.Expression): boolean {
      if (tag.type === AST_NODE_TYPES.Identifier) {
        return drizzleImportKind(tag) === "sql";
      }
      return (
        tag.type === AST_NODE_TYPES.MemberExpression &&
        tag.object.type === AST_NODE_TYPES.Identifier &&
        drizzleImportKind(tag.object) === "namespace" &&
        memberName(tag) === "sql"
      );
    }

    return {
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
