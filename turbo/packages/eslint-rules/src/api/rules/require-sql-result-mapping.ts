import {
  AST_NODE_TYPES,
  ESLintUtils,
  type TSESTree,
} from "@typescript-eslint/utils";
import {
  IndexKind,
  SymbolFlags,
  TypeFlags,
  type Declaration,
  type Node,
  type Symbol as TypeScriptSymbol,
  type Type,
  type TypeChecker,
} from "typescript";

import { createRule } from "../utils.ts";

const RESULT_FIELD_ARGUMENT = new Map<string, number>([
  ["returning", 0],
  ["select", 0],
  ["selectDistinct", 0],
  ["selectDistinctOn", 1],
]);

const TERMINAL_TYPE_FLAGS =
  TypeFlags.Any |
  TypeFlags.Unknown |
  TypeFlags.StringLike |
  TypeFlags.NumberLike |
  TypeFlags.BigIntLike |
  TypeFlags.BooleanLike |
  TypeFlags.ESSymbolLike |
  TypeFlags.Null |
  TypeFlags.Undefined |
  TypeFlags.Void |
  TypeFlags.Never;

function memberName(node: TSESTree.MemberExpression): string | null {
  if (!node.computed && node.property.type === AST_NODE_TYPES.Identifier) {
    return node.property.name;
  }
  if (node.computed && node.property.type === AST_NODE_TYPES.Literal) {
    return typeof node.property.value === "string" ? node.property.value : null;
  }
  return null;
}

function isDrizzleDeclaration(node: Declaration): boolean {
  const sourcePath = node.getSourceFile().fileName.replaceAll("\\", "/");
  return sourcePath.includes("/node_modules/drizzle-orm/");
}

function resolvedSymbol(
  checker: TypeChecker,
  symbol: TypeScriptSymbol | undefined,
): TypeScriptSymbol | undefined {
  if (symbol === undefined) {
    return undefined;
  }
  return (symbol.flags & SymbolFlags.Alias) === 0
    ? symbol
    : checker.getAliasedSymbol(symbol);
}

function isDrizzleSymbol(
  checker: TypeChecker,
  symbol: TypeScriptSymbol | undefined,
): boolean {
  return (
    resolvedSymbol(checker, symbol)?.declarations?.some(
      isDrizzleDeclaration,
    ) === true
  );
}

function propertyType(
  checker: TypeChecker,
  type: Type,
  name: string,
  location: Node,
): Type | undefined {
  const symbol = checker.getPropertyOfType(type, name);
  return symbol === undefined
    ? undefined
    : checker.getTypeOfSymbolAtLocation(symbol, location);
}

function sqlOutputType(
  checker: TypeChecker,
  type: Type,
  location: Node,
): Type | null {
  const metadataSymbol = checker.getPropertyOfType(type, "_");
  if (
    metadataSymbol === undefined ||
    metadataSymbol.declarations?.some(isDrizzleDeclaration) !== true
  ) {
    return null;
  }

  const metadataType = propertyType(checker, type, "_", location);
  if (metadataType === undefined) {
    return null;
  }
  const brandType = propertyType(checker, metadataType, "brand", location);
  if (
    brandType === undefined ||
    !brandType.isStringLiteral() ||
    (brandType.value !== "SQL" && brandType.value !== "SQL.Aliased")
  ) {
    return null;
  }

  return propertyType(checker, metadataType, "type", location) ?? null;
}

function isUntrustedOutput(type: Type): boolean {
  return (type.flags & (TypeFlags.Any | TypeFlags.Unknown)) !== 0;
}

function isDrizzleWrapper(checker: TypeChecker, type: Type): boolean {
  return isDrizzleSymbol(checker, checker.getPropertyOfType(type, "getSQL"));
}

function containsUntrustedSql(
  checker: TypeChecker,
  type: Type,
  location: Node,
  visited: Set<Type>,
): boolean {
  if (visited.has(type)) {
    return false;
  }
  visited.add(type);

  if (type.isUnionOrIntersection()) {
    return type.types.some((member) => {
      return containsUntrustedSql(checker, member, location, visited);
    });
  }

  const outputType = sqlOutputType(checker, type, location);
  if (outputType !== null) {
    return isUntrustedOutput(outputType);
  }

  if (
    (type.flags & TERMINAL_TYPE_FLAGS) !== 0 ||
    isDrizzleWrapper(checker, type) ||
    checker.isArrayType(type) ||
    checker.isTupleType(type) ||
    type.getCallSignatures().length > 0
  ) {
    return false;
  }

  for (const property of checker.getPropertiesOfType(type)) {
    const propertyType = checker.getTypeOfSymbolAtLocation(property, location);
    if (containsUntrustedSql(checker, propertyType, location, visited)) {
      return true;
    }
  }

  const stringValueType = checker.getIndexTypeOfType(type, IndexKind.String);
  if (
    stringValueType !== undefined &&
    containsUntrustedSql(checker, stringValueType, location, visited)
  ) {
    return true;
  }
  const numberValueType = checker.getIndexTypeOfType(type, IndexKind.Number);
  return (
    numberValueType !== undefined &&
    containsUntrustedSql(checker, numberValueType, location, visited)
  );
}

export const requireSqlResultMapping = createRule({
  name: "require-sql-result-mapping",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Require runtime mapping for raw SQL values in structured Drizzle results",
      recommended: true,
      requiresTypeChecking: true,
    },
    schema: [],
    messages: {
      sqlTypeArgument:
        "Drizzle sql<T> is compile-only. Remove the type argument; map selected values with a matching runtime decoder.",
      sqlTypeReference:
        "A generic Drizzle SQL type is compile-only. Use unparameterized SQL for composition and derive selected output from runtime mapping.",
      sqlAliasTypeArgument:
        'Generic SQL .as<T>(...) changes only the TypeScript type. Use .as("alias") after runtime mapping.',
      sqlAssertion:
        "A TypeScript assertion cannot establish a raw SQL runtime result contract.",
      unmappedResult:
        "Raw SQL in a structured Drizzle result must derive a concrete output from .mapWith(...) or a trusted schema-aware helper.",
    },
  },
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();

    function symbolAt(node: TSESTree.Node): TypeScriptSymbol | undefined {
      const tsNode = services.esTreeNodeToTSNodeMap.get(node);
      return checker.getSymbolAtLocation(tsNode);
    }

    function isDrizzleSqlTag(node: TSESTree.Expression): boolean {
      if (node.type === AST_NODE_TYPES.Identifier) {
        const symbol = resolvedSymbol(checker, symbolAt(node));
        return symbol?.getName() === "sql" && isDrizzleSymbol(checker, symbol);
      }
      if (
        node.type === AST_NODE_TYPES.MemberExpression &&
        memberName(node) === "sql"
      ) {
        const symbol = resolvedSymbol(checker, symbolAt(node.property));
        return symbol?.getName() === "sql" && isDrizzleSymbol(checker, symbol);
      }
      return false;
    }

    function nodeContainsUntrustedSql(node: TSESTree.Node): boolean {
      const tsNode = services.esTreeNodeToTSNodeMap.get(node);
      return containsUntrustedSql(
        checker,
        checker.getTypeAtLocation(tsNode),
        tsNode,
        new Set<Type>(),
      );
    }

    function collectUnmappedSelections(
      node: TSESTree.Node,
      unmapped: TSESTree.Node[],
    ): void {
      if (node.type === AST_NODE_TYPES.ObjectExpression) {
        for (const property of node.properties) {
          if (property.type === AST_NODE_TYPES.SpreadElement) {
            collectUnmappedSelections(property.argument, unmapped);
          } else {
            collectUnmappedSelections(property.value, unmapped);
          }
        }
        return;
      }
      if (nodeContainsUntrustedSql(node)) {
        unmapped.push(node);
      }
    }

    function resultFieldArgument(
      node: TSESTree.CallExpression,
    ): TSESTree.Expression | null {
      if (node.callee.type !== AST_NODE_TYPES.MemberExpression) {
        return null;
      }
      const name = memberName(node.callee);
      if (name === null) {
        return null;
      }
      const argumentIndex = RESULT_FIELD_ARGUMENT.get(name);
      if (argumentIndex === undefined) {
        return null;
      }
      const argument = node.arguments[argumentIndex];
      if (
        argument === undefined ||
        argument.type === AST_NODE_TYPES.SpreadElement
      ) {
        return null;
      }
      return argument;
    }

    function isGenericDrizzleSqlAlias(node: TSESTree.CallExpression): boolean {
      if (
        node.typeArguments?.params.length !== 1 ||
        node.callee.type !== AST_NODE_TYPES.MemberExpression ||
        memberName(node.callee) !== "as" ||
        !isDrizzleSymbol(checker, symbolAt(node.callee.property))
      ) {
        return false;
      }
      const receiver = node.callee.object;
      const tsReceiver = services.esTreeNodeToTSNodeMap.get(receiver);
      return (
        sqlOutputType(
          checker,
          checker.getTypeAtLocation(tsReceiver),
          tsReceiver,
        ) !== null
      );
    }

    function checkAssertion(
      node: TSESTree.TSAsExpression | TSESTree.TSTypeAssertion,
    ): void {
      if (
        !nodeContainsUntrustedSql(node) &&
        nodeContainsUntrustedSql(node.expression)
      ) {
        context.report({ node, messageId: "sqlAssertion" });
      }
    }

    return {
      TaggedTemplateExpression(node: TSESTree.TaggedTemplateExpression): void {
        if (node.typeArguments?.params.length && isDrizzleSqlTag(node.tag)) {
          context.report({ node, messageId: "sqlTypeArgument" });
        }
      },
      TSTypeReference(node: TSESTree.TSTypeReference): void {
        const symbol = resolvedSymbol(checker, symbolAt(node.typeName));
        if (
          node.typeArguments?.params.length &&
          (symbol?.getName() === "SQL" || symbol?.getName() === "Aliased") &&
          isDrizzleSymbol(checker, symbol)
        ) {
          context.report({ node, messageId: "sqlTypeReference" });
        }
      },
      CallExpression(node: TSESTree.CallExpression): void {
        if (isGenericDrizzleSqlAlias(node)) {
          context.report({ node, messageId: "sqlAliasTypeArgument" });
        }
        const fields = resultFieldArgument(node);
        if (fields === null) {
          return;
        }
        const unmapped: TSESTree.Node[] = [];
        collectUnmappedSelections(fields, unmapped);
        if (
          unmapped.length === 0 ||
          node.callee.type !== AST_NODE_TYPES.MemberExpression ||
          !isDrizzleSymbol(checker, symbolAt(node.callee.property))
        ) {
          return;
        }
        for (const field of unmapped) {
          context.report({ node: field, messageId: "unmappedResult" });
        }
      },
      TSAsExpression(node: TSESTree.TSAsExpression): void {
        checkAssertion(node);
      },
      TSTypeAssertion(node: TSESTree.TSTypeAssertion): void {
        checkAssertion(node);
      },
    };
  },
});
