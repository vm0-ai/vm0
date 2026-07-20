import {
  AST_NODE_TYPES,
  ESLintUtils,
  type TSESTree,
} from "@typescript-eslint/utils";
import {
  IndexKind,
  isVariableDeclaration,
  SymbolFlags,
  TypeFlags,
  type Declaration,
  type Node,
  type Signature,
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

const RELATIONAL_RESULT_METHODS = new Set(["findFirst", "findMany"]);

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

function propertyName(node: TSESTree.Property): string | null {
  if (!node.computed && node.key.type === AST_NODE_TYPES.Identifier) {
    return node.key.name;
  }
  if (node.key.type === AST_NODE_TYPES.Literal) {
    return typeof node.key.value === "string" ? node.key.value : null;
  }
  return null;
}

function isDrizzleDeclaration(node: Declaration): boolean {
  const sourcePath = node.getSourceFile().fileName.replaceAll("\\", "/");
  return sourcePath.includes("/node_modules/drizzle-orm/");
}

function isNamedDrizzleSignature(signature: Signature, name: string): boolean {
  const declaration = signature.declaration;
  return (
    declaration !== undefined &&
    "name" in declaration &&
    declaration.name?.getText() === name &&
    isDrizzleDeclaration(declaration)
  );
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
  const metadataDeclarations = metadataSymbol?.declarations;
  if (
    metadataSymbol === undefined ||
    metadataDeclarations === undefined ||
    metadataDeclarations.length === 0 ||
    !metadataDeclarations.every(isDrizzleDeclaration)
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

function hasUntrustedSqlMetadata(
  checker: TypeChecker,
  type: Type,
  location: Node,
): boolean {
  if (
    checker.getPropertyOfType(type, "_") === undefined ||
    !isDrizzleWrapper(checker, type)
  ) {
    return false;
  }
  const metadataType = propertyType(checker, type, "_", location);
  if (metadataType === undefined) {
    return false;
  }
  const brandType = propertyType(checker, metadataType, "brand", location);
  return (
    brandType?.isStringLiteral() === true &&
    (brandType.value === "SQL" || brandType.value === "SQL.Aliased")
  );
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
  if (hasUntrustedSqlMetadata(checker, type, location)) {
    return true;
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

function containsUntrustedSqlResult(
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
      return containsUntrustedSqlResult(checker, member, location, visited);
    });
  }

  const signatures = type.getCallSignatures();
  if (signatures.length > 0) {
    return signatures.some((signature) => {
      return containsUntrustedSql(
        checker,
        checker.getReturnTypeOfSignature(signature),
        location,
        new Set<Type>(),
      );
    });
  }

  return containsUntrustedSql(checker, type, location, new Set<Type>());
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
      resultMethodReference:
        "Do not alias or bind a Drizzle structured-result method. Call it directly so raw SQL result mapping can be enforced.",
      uninspectableResultArguments:
        "Do not spread arguments into a Drizzle structured-result method. Pass them explicitly so raw SQL result mapping can be enforced.",
      uninspectableRelationalConfig:
        "Relational query config must be an inline object or a local variable so raw SQL extras can be inspected.",
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

    function staticStringValue(node: TSESTree.Node): string | null {
      const tsNode = services.esTreeNodeToTSNodeMap.get(node);
      const type = checker.getTypeAtLocation(tsNode);
      return type.isStringLiteral() ? type.value : null;
    }

    function resolvedMemberName(
      node: TSESTree.MemberExpression,
    ): string | null {
      return (
        memberName(node) ??
        (node.computed ? staticStringValue(node.property) : null)
      );
    }

    function resolvedPropertyName(node: TSESTree.Property): string | null {
      return (
        propertyName(node) ??
        (node.computed ? staticStringValue(node.key) : null)
      );
    }

    function localVariableInitializer(
      node: TSESTree.Node,
    ): TSESTree.Node | null {
      if (node.type !== AST_NODE_TYPES.Identifier) {
        return null;
      }
      const tsNode = services.esTreeNodeToTSNodeMap.get(node);
      const declaration = resolvedSymbol(
        checker,
        symbolAt(node),
      )?.valueDeclaration;
      if (
        declaration === undefined ||
        !isVariableDeclaration(declaration) ||
        declaration.initializer === undefined ||
        declaration.getSourceFile() !== tsNode.getSourceFile()
      ) {
        return null;
      }
      return services.tsNodeToESTreeNodeMap.get(declaration.initializer);
    }

    function isDrizzleSqlTag(node: TSESTree.Expression): boolean {
      let symbol: TypeScriptSymbol | undefined;
      if (node.type === AST_NODE_TYPES.Identifier) {
        symbol = resolvedSymbol(checker, symbolAt(node));
      } else if (
        node.type === AST_NODE_TYPES.MemberExpression &&
        resolvedMemberName(node) === "sql"
      ) {
        symbol = resolvedSymbol(checker, symbolAt(node.property));
      }
      if (symbol?.getName() === "sql" && isDrizzleSymbol(checker, symbol)) {
        return true;
      }

      const tsNode = services.esTreeNodeToTSNodeMap.get(node);
      return checker
        .getTypeAtLocation(tsNode)
        .getCallSignatures()
        .some((signature) => {
          return isNamedDrizzleSignature(signature, "sql");
        });
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

    function isDrizzleSqlConstructor(node: TSESTree.Expression): boolean {
      const tsNode = services.esTreeNodeToTSNodeMap.get(node);
      return checker
        .getTypeAtLocation(tsNode)
        .getConstructSignatures()
        .some((signature) => {
          return (
            signature.declaration !== undefined &&
            isDrizzleDeclaration(signature.declaration) &&
            sqlOutputType(
              checker,
              checker.getReturnTypeOfSignature(signature),
              tsNode,
            ) !== null
          );
        });
    }

    function isDrizzleSqlTypeName(node: TSESTree.Node): boolean {
      const symbol = resolvedSymbol(checker, symbolAt(node));
      return (
        (symbol?.getName() === "SQL" || symbol?.getName() === "Aliased") &&
        isDrizzleSymbol(checker, symbol)
      );
    }

    function nodeContainsUntrustedSqlResult(node: TSESTree.Node): boolean {
      const tsNode = services.esTreeNodeToTSNodeMap.get(node);
      return containsUntrustedSqlResult(
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
          } else if (
            property.kind === "get" &&
            nodeContainsUntrustedSqlResult(property.value)
          ) {
            unmapped.push(property.value);
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

    function transparentExpression(node: TSESTree.Node): TSESTree.Node | null {
      if (
        node.type === AST_NODE_TYPES.TSAsExpression ||
        node.type === AST_NODE_TYPES.TSTypeAssertion ||
        node.type === AST_NODE_TYPES.TSSatisfiesExpression ||
        node.type === AST_NODE_TYPES.TSNonNullExpression ||
        node.type === AST_NODE_TYPES.ChainExpression
      ) {
        return node.expression;
      }
      return null;
    }

    function isSafeRelationalLeaf(node: TSESTree.Node): boolean {
      let isUndefined = false;
      if (
        node.type === AST_NODE_TYPES.Identifier &&
        node.name === "undefined"
      ) {
        const tsNode = services.esTreeNodeToTSNodeMap.get(node);
        isUndefined =
          (checker.getTypeAtLocation(tsNode).flags & TypeFlags.Undefined) !== 0;
      }
      return (
        isUndefined ||
        (node.type === AST_NODE_TYPES.Literal &&
          (node.value === null || typeof node.value === "boolean")) ||
        (node.type === AST_NODE_TYPES.UnaryExpression &&
          node.operator === "void")
      );
    }

    function collectUnmappedExtras(
      node: TSESTree.Node,
      unmapped: TSESTree.Node[],
      visited: Set<TSESTree.Node>,
    ): void {
      if (visited.has(node)) {
        return;
      }
      visited.add(node);

      const initializer = localVariableInitializer(node);
      if (initializer !== null) {
        collectUnmappedExtras(initializer, unmapped, visited);
        return;
      }
      const expression = transparentExpression(node);
      if (expression !== null) {
        collectUnmappedExtras(expression, unmapped, visited);
        return;
      }
      if (node.type === AST_NODE_TYPES.ConditionalExpression) {
        collectUnmappedExtras(node.consequent, unmapped, visited);
        collectUnmappedExtras(node.alternate, unmapped, visited);
        return;
      }
      if (node.type === AST_NODE_TYPES.ObjectExpression) {
        collectUnmappedSelections(node, unmapped);
        return;
      }
      if (
        node.type === AST_NODE_TYPES.ArrowFunctionExpression &&
        node.body.type !== AST_NODE_TYPES.BlockStatement
      ) {
        collectUnmappedExtras(node.body, unmapped, visited);
        return;
      }
      if (nodeContainsUntrustedSqlResult(node)) {
        unmapped.push(node);
      }
    }

    // DBQueryConfig is recursive, so inspect bounded local syntax instead of
    // expanding its full contextual type.
    function collectUnmappedRelationalNode(
      node: TSESTree.Node,
      kind: "config" | "with",
      unmapped: TSESTree.Node[],
      uninspectable: TSESTree.Node[],
      visited: {
        config: Set<TSESTree.Node>;
        extras: Set<TSESTree.Node>;
        with: Set<TSESTree.Node>;
      },
    ): void {
      if (visited[kind].has(node)) {
        return;
      }
      visited[kind].add(node);

      const initializer = localVariableInitializer(node);
      if (initializer !== null) {
        collectUnmappedRelationalNode(
          initializer,
          kind,
          unmapped,
          uninspectable,
          visited,
        );
        return;
      }
      const expression = transparentExpression(node);
      if (expression !== null) {
        collectUnmappedRelationalNode(
          expression,
          kind,
          unmapped,
          uninspectable,
          visited,
        );
        return;
      }
      if (node.type === AST_NODE_TYPES.ConditionalExpression) {
        collectUnmappedRelationalNode(
          node.consequent,
          kind,
          unmapped,
          uninspectable,
          visited,
        );
        collectUnmappedRelationalNode(
          node.alternate,
          kind,
          unmapped,
          uninspectable,
          visited,
        );
        return;
      }
      if (node.type !== AST_NODE_TYPES.ObjectExpression) {
        if (!isSafeRelationalLeaf(node)) {
          uninspectable.push(node);
        }
        return;
      }

      for (const property of node.properties) {
        if (property.type === AST_NODE_TYPES.SpreadElement) {
          collectUnmappedRelationalNode(
            property.argument,
            kind,
            unmapped,
            uninspectable,
            visited,
          );
          continue;
        }
        if (kind === "with") {
          collectUnmappedRelationalNode(
            property.value,
            "config",
            unmapped,
            uninspectable,
            visited,
          );
          continue;
        }

        const name = resolvedPropertyName(property);
        if (name === "extras") {
          collectUnmappedExtras(property.value, unmapped, visited.extras);
        } else if (name === "with") {
          collectUnmappedRelationalNode(
            property.value,
            "with",
            unmapped,
            uninspectable,
            visited,
          );
        }
      }
    }

    function resultFieldArgument(
      node: TSESTree.CallExpression,
    ): TSESTree.Expression | null {
      if (node.callee.type !== AST_NODE_TYPES.MemberExpression) {
        return null;
      }
      const name = resolvedMemberName(node.callee);
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

    function isStructuredSelectionMethod(
      name: string,
      symbol: TypeScriptSymbol | undefined,
      type: Type,
    ): boolean {
      if (!RESULT_FIELD_ARGUMENT.has(name)) {
        return false;
      }
      if (name === "returning") {
        return (
          isDrizzleSymbol(checker, symbol) ||
          methodReturnsDrizzleType(type, "execute")
        );
      }
      return methodReturnsDrizzleType(type, "from");
    }

    function methodReturnsDrizzleType(type: Type, property: string): boolean {
      return type.getCallSignatures().some((signature) => {
        const returnType = checker.getReturnTypeOfSignature(signature);
        return isDrizzleSymbol(
          checker,
          checker.getPropertyOfType(returnType, property),
        );
      });
    }

    function isRelationalResultMethod(
      name: string,
      symbol: TypeScriptSymbol | undefined,
      type: Type,
    ): boolean {
      return (
        RELATIONAL_RESULT_METHODS.has(name) &&
        (isDrizzleSymbol(checker, symbol) ||
          methodReturnsDrizzleType(type, "execute"))
      );
    }

    function isResultMethodMember(node: TSESTree.MemberExpression): boolean {
      const name = resolvedMemberName(node);
      if (
        name === null ||
        (!RESULT_FIELD_ARGUMENT.has(name) &&
          !RELATIONAL_RESULT_METHODS.has(name))
      ) {
        return false;
      }

      const symbol = symbolAt(node.property);
      const tsNode = services.esTreeNodeToTSNodeMap.get(node);
      const type = checker.getTypeAtLocation(tsNode);
      if (isRelationalResultMethod(name, symbol, type)) {
        return true;
      }
      return isStructuredSelectionMethod(name, symbol, type);
    }

    function destructuresResultMethod(node: TSESTree.Property): boolean {
      if (node.parent.type !== AST_NODE_TYPES.ObjectPattern) {
        return false;
      }
      const name = resolvedPropertyName(node);
      if (
        name === null ||
        (!RESULT_FIELD_ARGUMENT.has(name) &&
          !RELATIONAL_RESULT_METHODS.has(name))
      ) {
        return false;
      }

      const tsPattern = services.esTreeNodeToTSNodeMap.get(node.parent);
      const patternType = checker.getTypeAtLocation(tsPattern);
      const symbol = checker.getPropertyOfType(patternType, name);
      if (symbol === undefined) {
        return false;
      }
      const type = checker.getTypeOfSymbolAtLocation(symbol, tsPattern);
      return (
        isRelationalResultMethod(name, symbol, type) ||
        isStructuredSelectionMethod(name, symbol, type)
      );
    }

    function isDrizzleSqlAliasCallee(node: TSESTree.Expression): boolean {
      if (
        node.type === AST_NODE_TYPES.MemberExpression &&
        resolvedMemberName(node) === "as" &&
        isDrizzleSymbol(checker, symbolAt(node.property))
      ) {
        const tsReceiver = services.esTreeNodeToTSNodeMap.get(node.object);
        if (
          sqlOutputType(
            checker,
            checker.getTypeAtLocation(tsReceiver),
            tsReceiver,
          ) !== null
        ) {
          return true;
        }
      }

      const tsCallee = services.esTreeNodeToTSNodeMap.get(node);
      return checker
        .getTypeAtLocation(tsCallee)
        .getCallSignatures()
        .some((signature) => {
          return (
            isNamedDrizzleSignature(signature, "as") &&
            sqlOutputType(
              checker,
              checker.getReturnTypeOfSignature(signature),
              tsCallee,
            ) !== null
          );
        });
    }

    function isGenericDrizzleSqlAlias(node: TSESTree.CallExpression): boolean {
      return (
        node.typeArguments?.params.length === 1 &&
        isDrizzleSqlAliasCallee(node.callee)
      );
    }

    function checkGenericSqlSuperclass(
      node: TSESTree.ClassDeclaration | TSESTree.ClassExpression,
    ): void {
      if (
        node.superTypeArguments?.params.length &&
        node.superClass !== null &&
        isDrizzleSqlConstructor(node.superClass)
      ) {
        context.report({ node, messageId: "sqlTypeReference" });
      }
    }

    function checkAssertion(
      node: TSESTree.TSAsExpression | TSESTree.TSTypeAssertion,
    ): void {
      if (
        nodeContainsUntrustedSql(node.expression) &&
        !nodeContainsUntrustedSql(node)
      ) {
        context.report({ node, messageId: "sqlAssertion" });
      }
    }

    function checkResultMethodReference(node: TSESTree.MemberExpression): void {
      if (
        (node.parent.type === AST_NODE_TYPES.CallExpression &&
          node.parent.callee === node) ||
        !isResultMethodMember(node)
      ) {
        return;
      }
      context.report({ node, messageId: "resultMethodReference" });
    }

    function checkDestructuredResultMethod(node: TSESTree.Property): void {
      if (destructuresResultMethod(node)) {
        context.report({ node, messageId: "resultMethodReference" });
      }
    }

    return {
      TaggedTemplateExpression(node: TSESTree.TaggedTemplateExpression): void {
        if (node.typeArguments?.params.length && isDrizzleSqlTag(node.tag)) {
          context.report({ node, messageId: "sqlTypeArgument" });
        }
      },
      TSTypeReference(node: TSESTree.TSTypeReference): void {
        if (
          node.typeArguments?.params.length &&
          isDrizzleSqlTypeName(node.typeName)
        ) {
          context.report({ node, messageId: "sqlTypeReference" });
        }
      },
      TSImportType(node: TSESTree.TSImportType): void {
        if (
          node.typeArguments?.params.length &&
          node.qualifier !== null &&
          isDrizzleSqlTypeName(node.qualifier)
        ) {
          context.report({ node, messageId: "sqlTypeReference" });
        }
      },
      TSInterfaceHeritage(node: TSESTree.TSInterfaceHeritage): void {
        if (
          node.typeArguments?.params.length &&
          isDrizzleSqlTypeName(node.expression)
        ) {
          context.report({ node, messageId: "sqlTypeReference" });
        }
      },
      TSInstantiationExpression(
        node: TSESTree.TSInstantiationExpression,
      ): void {
        if (node.typeArguments.params.length !== 1) {
          return;
        }
        if (isDrizzleSqlTag(node.expression)) {
          context.report({ node, messageId: "sqlTypeArgument" });
        } else if (isDrizzleSqlAliasCallee(node.expression)) {
          context.report({ node, messageId: "sqlAliasTypeArgument" });
        } else if (isDrizzleSqlConstructor(node.expression)) {
          context.report({ node, messageId: "sqlTypeReference" });
        }
      },
      CallExpression(node: TSESTree.CallExpression): void {
        if (
          node.typeArguments?.params.length === 1 &&
          isDrizzleSqlTag(node.callee)
        ) {
          context.report({ node, messageId: "sqlTypeArgument" });
        } else if (isGenericDrizzleSqlAlias(node)) {
          context.report({ node, messageId: "sqlAliasTypeArgument" });
        }

        const hasSpreadArgument = node.arguments.some(
          (argument) => argument.type === AST_NODE_TYPES.SpreadElement,
        );
        if (
          hasSpreadArgument &&
          node.callee.type === AST_NODE_TYPES.MemberExpression &&
          isResultMethodMember(node.callee)
        ) {
          for (const argument of node.arguments) {
            if (argument.type === AST_NODE_TYPES.SpreadElement) {
              context.report({
                node: argument,
                messageId: "uninspectableResultArguments",
              });
            }
          }
          return;
        }

        if (
          node.callee.type === AST_NODE_TYPES.MemberExpression &&
          RELATIONAL_RESULT_METHODS.has(
            resolvedMemberName(node.callee) ?? "",
          ) &&
          isResultMethodMember(node.callee)
        ) {
          const config = node.arguments[0];
          if (
            config !== undefined &&
            config.type !== AST_NODE_TYPES.SpreadElement
          ) {
            const unmapped: TSESTree.Node[] = [];
            const uninspectable: TSESTree.Node[] = [];
            collectUnmappedRelationalNode(
              config,
              "config",
              unmapped,
              uninspectable,
              {
                config: new Set<TSESTree.Node>(),
                extras: new Set<TSESTree.Node>(),
                with: new Set<TSESTree.Node>(),
              },
            );
            for (const field of unmapped) {
              context.report({ node: field, messageId: "unmappedResult" });
            }
            for (const field of uninspectable) {
              context.report({
                node: field,
                messageId: "uninspectableRelationalConfig",
              });
            }
          }
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
          !isResultMethodMember(node.callee)
        ) {
          return;
        }
        for (const field of unmapped) {
          context.report({ node: field, messageId: "unmappedResult" });
        }
      },
      NewExpression(node: TSESTree.NewExpression): void {
        if (
          node.typeArguments?.params.length &&
          isDrizzleSqlConstructor(node.callee)
        ) {
          context.report({ node, messageId: "sqlTypeReference" });
        }
      },
      ClassDeclaration(node: TSESTree.ClassDeclaration): void {
        checkGenericSqlSuperclass(node);
      },
      ClassExpression(node: TSESTree.ClassExpression): void {
        checkGenericSqlSuperclass(node);
      },
      "MemberExpression[computed=false][property.name='findFirst']":
        checkResultMethodReference,
      "MemberExpression[computed=false][property.name='findMany']":
        checkResultMethodReference,
      "MemberExpression[computed=false][property.name='returning']":
        checkResultMethodReference,
      "MemberExpression[computed=false][property.name='select']":
        checkResultMethodReference,
      "MemberExpression[computed=false][property.name='selectDistinct']":
        checkResultMethodReference,
      "MemberExpression[computed=false][property.name='selectDistinctOn']":
        checkResultMethodReference,
      "MemberExpression[computed=true]": checkResultMethodReference,
      "ObjectPattern > Property": checkDestructuredResultMethod,
      TSAsExpression(node: TSESTree.TSAsExpression): void {
        checkAssertion(node);
      },
      TSTypeAssertion(node: TSESTree.TSTypeAssertion): void {
        checkAssertion(node);
      },
    };
  },
});
