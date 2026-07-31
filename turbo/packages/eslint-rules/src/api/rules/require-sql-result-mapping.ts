import {
  AST_NODE_TYPES,
  ESLintUtils,
  type TSESTree,
  type TSESLint,
} from "@typescript-eslint/utils";
import {
  IndexKind,
  isAsExpression,
  isCallExpression,
  isElementAccessExpression,
  isExpression,
  isFunctionDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNonNullExpression,
  isObjectLiteralExpression,
  isParameter,
  isParenthesizedExpression,
  isPropertyAssignment,
  isPropertyAccessExpression,
  isSatisfiesExpression,
  isSpreadElement,
  isTypeAssertionExpression,
  isVariableDeclaration,
  isVariableDeclarationList,
  NodeFlags,
  TypeFlags,
  type Expression,
  type Node,
  type Symbol as TypeScriptSymbol,
  type Type,
  type TypeChecker,
  type VariableDeclaration,
} from "typescript";

import {
  isDrizzleColumnType,
  isDrizzleDeclaration,
  isDrizzleSqlTag as isDrizzleSqlTagExpression,
  isDrizzleSymbol,
  isDrizzleWrapperType,
  isNamedDrizzleSignature,
  resolvedSymbol,
} from "../drizzle.ts";
import { createRule } from "../utils.ts";

const RESULT_FIELD_ARGUMENT = new Map<string, number>([
  ["returning", 0],
  ["select", 0],
  ["selectDistinct", 0],
  ["selectDistinctOn", 1],
]);

const RELATIONAL_RESULT_METHODS = new Set(["findFirst", "findMany"]);

const RESULT_METHOD_NAMES = [
  ...RESULT_FIELD_ARGUMENT.keys(),
  ...RELATIONAL_RESULT_METHODS,
];
const RESULT_METHOD_HINTS = RESULT_METHOD_NAMES.map((name) => {
  return name.toLowerCase();
});

const SHARED_DECODER_SOURCE_SUFFIX =
  "/turbo/apps/api/src/lib/db-structured-result.ts";
const VALIDATING_DECODER_FACTORIES = new Set([
  "zodDriverValueDecoder",
  "zodEnumDriverValueDecoder",
]);
const NULLABLE_DECODER_FACTORY = "nullableDriverValueDecoder";
const MAX_DECODER_PROVENANCE_STEPS = 64;

type SelectionTypeStatus = "safe" | "unmapped" | "uninspectable";

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
  return isDrizzleWrapperType(checker, type);
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

function combineSelectionTypeStatus(
  current: SelectionTypeStatus,
  next: SelectionTypeStatus,
): SelectionTypeStatus {
  if (current === "unmapped" || next === "unmapped") {
    return "unmapped";
  }
  if (current === "uninspectable" || next === "uninspectable") {
    return "uninspectable";
  }
  return "safe";
}

function selectionTypeStatus(
  checker: TypeChecker,
  type: Type,
  location: Node,
  visited: Set<Type>,
): SelectionTypeStatus {
  if (visited.has(type)) {
    return "safe";
  }
  visited.add(type);

  if (type.isUnion()) {
    return type.types.reduce<SelectionTypeStatus>((status, member) => {
      return combineSelectionTypeStatus(
        status,
        selectionTypeStatus(checker, member, location, visited),
      );
    }, "safe");
  }

  const outputType = sqlOutputType(checker, type, location);
  if (outputType !== null) {
    return isUntrustedOutput(outputType) ? "unmapped" : "safe";
  }
  if (hasUntrustedSqlMetadata(checker, type, location)) {
    return "unmapped";
  }
  if (isDrizzleWrapper(checker, type)) {
    return "safe";
  }

  if ((type.flags & (TypeFlags.Any | TypeFlags.Unknown)) !== 0) {
    return "uninspectable";
  }
  if ((type.flags & TERMINAL_TYPE_FLAGS) !== 0) {
    return "safe";
  }

  if ((type.flags & TypeFlags.TypeParameter) !== 0) {
    const constraint = checker.getBaseConstraintOfType(type);
    return constraint === undefined
      ? "uninspectable"
      : selectionTypeStatus(checker, constraint, location, visited);
  }

  if (
    checker.isArrayType(type) ||
    checker.isTupleType(type) ||
    type.getCallSignatures().length > 0
  ) {
    return "uninspectable";
  }

  let status: SelectionTypeStatus = "safe";
  let inspectedMember = false;
  for (const property of checker.getPropertiesOfType(type)) {
    inspectedMember = true;
    const propertyType = checker.getTypeOfSymbolAtLocation(property, location);
    status = combineSelectionTypeStatus(
      status,
      selectionTypeStatus(checker, propertyType, location, visited),
    );
  }

  const stringValueType = checker.getIndexTypeOfType(type, IndexKind.String);
  if (stringValueType !== undefined) {
    inspectedMember = true;
    status = combineSelectionTypeStatus(
      status,
      selectionTypeStatus(checker, stringValueType, location, visited),
    );
  }
  const numberValueType = checker.getIndexTypeOfType(type, IndexKind.Number);
  if (numberValueType !== undefined) {
    inspectedMember = true;
    status = combineSelectionTypeStatus(
      status,
      selectionTypeStatus(checker, numberValueType, location, visited),
    );
  }

  return inspectedMember ? status : "uninspectable";
}

function selectionResultTypeStatus(
  checker: TypeChecker,
  type: Type,
  location: Node,
): SelectionTypeStatus {
  const signatures = type.getCallSignatures();
  if (signatures.length === 0) {
    return selectionTypeStatus(checker, type, location, new Set<Type>());
  }
  return signatures.reduce<SelectionTypeStatus>((status, signature) => {
    return combineSelectionTypeStatus(
      status,
      selectionTypeStatus(
        checker,
        checker.getReturnTypeOfSignature(signature),
        location,
        new Set<Type>(),
      ),
    );
  }, "safe");
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
      uninspectableResultSelection:
        "Structured-result fields must be inspectable so raw SQL runtime mapping can be enforced. Use an inline object, a local const selection, or a type with concrete selected-field members.",
      uninspectableRelationalConfig:
        "Relational query config must be an inline object or a local variable so raw SQL extras can be inspected.",
      unmappedResult:
        "Raw SQL in a structured Drizzle result must derive a concrete output from .mapWith(...) or a trusted schema-aware helper.",
      uninspectableResultDecoder:
        "Drizzle .mapWith(...) must use an inspectable schema column or reviewed runtime decoder.",
    },
  },
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();
    const resultMethodNameByType = new Map<Type, string | null>();
    const resultMethodHintByVariable = new Map<
      TSESLint.Scope.Variable,
      boolean
    >();
    const resultMethodHintVariablesInProgress =
      new Set<TSESLint.Scope.Variable>();
    const decoderProvenanceByNode = new WeakMap<Node, boolean>();
    const schemaTableCallByNode = new WeakMap<Node, boolean>();

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

    function localVariableDeclaration(
      node: TSESTree.Node,
    ): VariableDeclaration | null {
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
        declaration.getSourceFile() !== tsNode.getSourceFile()
      ) {
        return null;
      }
      return declaration;
    }

    function isConstVariable(declaration: VariableDeclaration): boolean {
      return (
        isVariableDeclarationList(declaration.parent) &&
        (declaration.parent.flags & NodeFlags.Const) !== 0
      );
    }

    function isSharedDecoderDeclaration(node: Node): boolean {
      return node
        .getSourceFile()
        .fileName.replaceAll("\\", "/")
        .endsWith(SHARED_DECODER_SOURCE_SUFFIX);
    }

    function expressionSymbol(node: Expression): TypeScriptSymbol | undefined {
      if (isIdentifier(node)) {
        return resolvedSymbol(checker, checker.getSymbolAtLocation(node));
      }
      if (isPropertyAccessExpression(node)) {
        return resolvedSymbol(checker, checker.getSymbolAtLocation(node.name));
      }
      if (isElementAccessExpression(node)) {
        return resolvedSymbol(
          checker,
          checker.getSymbolAtLocation(node.argumentExpression),
        );
      }
      return undefined;
    }

    function transparentDecoderExpression(
      node: Expression,
    ): Expression | undefined {
      return isParenthesizedExpression(node) || isSatisfiesExpression(node)
        ? node.expression
        : undefined;
    }

    function reviewedDecoderFactorySymbol(
      node: Expression,
      state: DecoderProvenanceState,
      visited: Set<TypeScriptSymbol>,
    ): TypeScriptSymbol | undefined {
      state.steps += 1;
      if (state.steps > MAX_DECODER_PROVENANCE_STEPS) {
        return undefined;
      }
      const transparent = transparentDecoderExpression(node);
      if (transparent !== undefined) {
        return reviewedDecoderFactorySymbol(transparent, state, visited);
      }
      if (
        isAsExpression(node) ||
        isTypeAssertionExpression(node) ||
        isNonNullExpression(node)
      ) {
        return undefined;
      }
      const symbol = expressionSymbol(node);
      if (
        symbol?.declarations?.some((declaration) => {
          return (
            isFunctionDeclaration(declaration) &&
            isSharedDecoderDeclaration(declaration)
          );
        }) === true
      ) {
        return symbol;
      }
      if (symbol === undefined || visited.has(symbol)) {
        return undefined;
      }
      const declaration = symbol.valueDeclaration;
      if (
        declaration === undefined ||
        !isVariableDeclaration(declaration) ||
        !isConstVariable(declaration) ||
        declaration.initializer === undefined
      ) {
        return undefined;
      }
      visited.add(symbol);
      const target = reviewedDecoderFactorySymbol(
        declaration.initializer,
        state,
        visited,
      );
      visited.delete(symbol);
      return target;
    }

    function isRealDriverValueDecoderType(type: Type, location: Node): boolean {
      const mapFromDriverValue = checker.getPropertyOfType(
        type,
        "mapFromDriverValue",
      );
      return (
        mapFromDriverValue !== undefined &&
        isDrizzleSymbol(checker, mapFromDriverValue) &&
        checker
          .getTypeOfSymbolAtLocation(mapFromDriverValue, location)
          .getCallSignatures().length > 0
      );
    }

    function isGlobalObjectFreezeCall(node: Expression): boolean {
      if (
        !isCallExpression(node) ||
        !isPropertyAccessExpression(node.expression) ||
        node.expression.expression.getText() !== "Object" ||
        node.expression.name.text !== "freeze"
      ) {
        return false;
      }
      const symbol = resolvedSymbol(
        checker,
        checker.getSymbolAtLocation(node.expression.name),
      );
      return (
        symbol?.declarations?.some((declaration) => {
          const source = declaration
            .getSourceFile()
            .fileName.replaceAll("\\", "/");
          return /\/lib\.es\d+(?:\.[^.]+)*\.d\.ts$/.test(source);
        }) === true
      );
    }

    function isReviewedFrozenDecoder(
      declaration: VariableDeclaration,
    ): boolean {
      const initializer = declaration.initializer;
      if (
        !isSharedDecoderDeclaration(declaration) ||
        !isConstVariable(declaration) ||
        initializer === undefined ||
        !isRealDriverValueDecoderType(
          checker.getTypeAtLocation(declaration.name),
          declaration.name,
        ) ||
        !isCallExpression(initializer) ||
        !isGlobalObjectFreezeCall(initializer) ||
        initializer.arguments.length !== 1
      ) {
        return false;
      }
      const value = initializer.arguments[0];
      return (
        value !== undefined &&
        !isSpreadElement(value) &&
        isObjectLiteralExpression(value) &&
        value.properties.some((property) => {
          return (
            isMethodDeclaration(property) &&
            property.name.getText().replaceAll(/["']/g, "") ===
              "mapFromDriverValue"
          );
        })
      );
    }

    interface DecoderProvenanceState {
      steps: number;
      readonly symbols: Set<TypeScriptSymbol>;
    }

    function isSchemaTableCall(node: Expression): boolean {
      const cached = schemaTableCallByNode.get(node);
      if (cached !== undefined) {
        return cached;
      }
      const symbol = isCallExpression(node)
        ? expressionSymbol(node.expression)
        : undefined;
      const inspected =
        symbol !== undefined &&
        (symbol.getName() === "pgTable" || symbol.getName() === "table") &&
        isDrizzleSymbol(checker, symbol);
      schemaTableCallByNode.set(node, inspected);
      return inspected;
    }

    function hasInspectableColumnContainerProvenance(
      node: Expression,
      state: DecoderProvenanceState,
    ): boolean {
      state.steps += 1;
      if (state.steps > MAX_DECODER_PROVENANCE_STEPS) {
        return false;
      }
      const transparent = transparentDecoderExpression(node);
      if (transparent !== undefined) {
        return hasInspectableColumnContainerProvenance(transparent, state);
      }
      if (
        isAsExpression(node) ||
        isTypeAssertionExpression(node) ||
        isNonNullExpression(node)
      ) {
        return false;
      }
      if (isCallExpression(node)) {
        return isSchemaTableCall(node);
      }
      const symbol = expressionSymbol(node);
      const declaration = symbol?.valueDeclaration;
      if (
        declaration !== undefined &&
        isParameter(declaration) &&
        declaration.type === undefined
      ) {
        return true;
      }
      if (
        symbol === undefined ||
        declaration === undefined ||
        !isVariableDeclaration(declaration) ||
        !isConstVariable(declaration) ||
        declaration.initializer === undefined ||
        state.symbols.has(symbol)
      ) {
        return false;
      }
      state.symbols.add(symbol);
      const inspected = hasInspectableColumnContainerProvenance(
        declaration.initializer,
        state,
      );
      state.symbols.delete(symbol);
      return inspected;
    }

    function isSchemaColumnDeclaration(node: Node): boolean {
      if (
        !isPropertyAssignment(node) ||
        !isObjectLiteralExpression(node.parent)
      ) {
        return false;
      }
      const tableCall = node.parent.parent;
      if (
        !isCallExpression(tableCall) ||
        tableCall.arguments[1] !== node.parent
      ) {
        return false;
      }
      return isSchemaTableCall(tableCall);
    }

    function isInspectableSchemaColumn(
      node: Expression,
      state: DecoderProvenanceState,
    ): boolean {
      return (
        (isPropertyAccessExpression(node) || isElementAccessExpression(node)) &&
        isDrizzleColumnType(checker, checker.getTypeAtLocation(node), node) &&
        expressionSymbol(node)?.declarations?.some(
          isSchemaColumnDeclaration,
        ) === true &&
        hasInspectableColumnContainerProvenance(node.expression, state)
      );
    }

    function isReviewedDecoderFactoryCall(
      node: Expression,
      state: DecoderProvenanceState,
    ): boolean {
      if (!isCallExpression(node)) {
        return false;
      }
      const target = reviewedDecoderFactorySymbol(
        node.expression,
        state,
        new Set(),
      );
      if (target === undefined || node.arguments.length !== 1) {
        return false;
      }
      const argument = node.arguments[0];
      if (argument === undefined || isSpreadElement(argument)) {
        return false;
      }
      const name = target.getName();
      if (VALIDATING_DECODER_FACTORIES.has(name)) {
        return true;
      }
      return (
        name === NULLABLE_DECODER_FACTORY &&
        hasInspectableDecoderProvenance(argument, state)
      );
    }

    function hasInspectableDecoderProvenance(
      node: Expression,
      state: DecoderProvenanceState,
    ): boolean {
      const cached = decoderProvenanceByNode.get(node);
      if (cached !== undefined) {
        return cached;
      }
      state.steps += 1;
      if (state.steps > MAX_DECODER_PROVENANCE_STEPS) {
        return false;
      }

      const transparent = transparentDecoderExpression(node);
      let inspected: boolean;
      if (transparent !== undefined) {
        inspected = hasInspectableDecoderProvenance(transparent, state);
      } else if (
        isAsExpression(node) ||
        isTypeAssertionExpression(node) ||
        isNonNullExpression(node)
      ) {
        inspected = false;
      } else if (isInspectableSchemaColumn(node, state)) {
        inspected = true;
      } else if (isCallExpression(node)) {
        inspected = isReviewedDecoderFactoryCall(node, state);
      } else {
        const symbol = expressionSymbol(node);
        const declaration = symbol?.valueDeclaration;
        if (
          symbol === undefined ||
          declaration === undefined ||
          !isVariableDeclaration(declaration) ||
          !isConstVariable(declaration) ||
          declaration.initializer === undefined ||
          state.symbols.has(symbol)
        ) {
          inspected = false;
        } else if (isReviewedFrozenDecoder(declaration)) {
          inspected = true;
        } else {
          state.symbols.add(symbol);
          inspected = hasInspectableDecoderProvenance(
            declaration.initializer,
            state,
          );
          state.symbols.delete(symbol);
        }
      }
      decoderProvenanceByNode.set(node, inspected);
      return inspected;
    }

    function isDrizzleMapWithCall(node: TSESTree.CallExpression): boolean {
      if (
        node.callee.type !== AST_NODE_TYPES.MemberExpression ||
        resolvedMemberName(node.callee) !== "mapWith"
      ) {
        return false;
      }
      return isDrizzleSymbol(checker, symbolAt(node.callee.property));
    }

    function checkResultDecoder(node: TSESTree.CallExpression): void {
      if (!isDrizzleMapWithCall(node)) {
        return;
      }
      const argument = node.arguments[0];
      if (
        node.arguments.length !== 1 ||
        argument === undefined ||
        argument.type === AST_NODE_TYPES.SpreadElement
      ) {
        context.report({ node, messageId: "uninspectableResultDecoder" });
        return;
      }
      const tsArgument = services.esTreeNodeToTSNodeMap.get(argument);
      if (
        !isExpression(tsArgument) ||
        !hasInspectableDecoderProvenance(tsArgument, {
          steps: 0,
          symbols: new Set(),
        })
      ) {
        context.report({
          node: argument,
          messageId: "uninspectableResultDecoder",
        });
      }
    }

    function localVariableInitializer(
      node: TSESTree.Node,
    ): TSESTree.Node | null {
      const declaration = localVariableDeclaration(node);
      if (
        declaration === null ||
        !isConstVariable(declaration) ||
        declaration.initializer === undefined
      ) {
        return null;
      }
      return services.tsNodeToESTreeNodeMap.get(declaration.initializer);
    }

    function isSelectionContainerType(type: Type, location: Node): boolean {
      if (type.isUnionOrIntersection()) {
        return type.types.some((member) => {
          return isSelectionContainerType(member, location);
        });
      }
      return (
        (type.flags & TypeFlags.Object) !== 0 &&
        sqlOutputType(checker, type, location) === null &&
        !isDrizzleWrapper(checker, type)
      );
    }

    function isMutableLocalSelectionContainer(node: TSESTree.Node): boolean {
      const declaration = localVariableDeclaration(node);
      if (declaration === null || isConstVariable(declaration)) {
        return false;
      }
      const tsNode = services.esTreeNodeToTSNodeMap.get(node);
      return isSelectionContainerType(
        checker.getTypeAtLocation(tsNode),
        tsNode,
      );
    }

    function isDrizzleSqlTag(node: TSESTree.Expression): boolean {
      return isDrizzleSqlTagExpression(checker, services, node);
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

    function nodeSelectionTypeStatus(node: TSESTree.Node): SelectionTypeStatus {
      const tsNode = services.esTreeNodeToTSNodeMap.get(node);
      return selectionTypeStatus(
        checker,
        checker.getTypeAtLocation(tsNode),
        tsNode,
        new Set<Type>(),
      );
    }

    function nodeSelectionResultTypeStatus(
      node: TSESTree.Node,
    ): SelectionTypeStatus {
      const tsNode = services.esTreeNodeToTSNodeMap.get(node);
      return selectionResultTypeStatus(
        checker,
        checker.getTypeAtLocation(tsNode),
        tsNode,
      );
    }

    function collectUnmappedSelections(
      node: TSESTree.Node,
      unmapped: TSESTree.Node[],
      uninspectable: TSESTree.Node[],
      visited: Set<TSESTree.Node>,
    ): void {
      if (visited.has(node)) {
        return;
      }
      visited.add(node);

      if (
        (node.type === AST_NODE_TYPES.TSAsExpression ||
          node.type === AST_NODE_TYPES.TSTypeAssertion) &&
        isUnsafeSqlAssertion(node)
      ) {
        return;
      }

      const initializer = localVariableInitializer(node);
      if (initializer !== null) {
        collectUnmappedSelections(
          initializer,
          unmapped,
          uninspectable,
          visited,
        );
        return;
      }
      const expression = transparentExpression(node);
      if (expression !== null) {
        collectUnmappedSelections(expression, unmapped, uninspectable, visited);
        return;
      }
      if (node.type === AST_NODE_TYPES.ConditionalExpression) {
        collectUnmappedSelections(
          node.consequent,
          unmapped,
          uninspectable,
          visited,
        );
        collectUnmappedSelections(
          node.alternate,
          unmapped,
          uninspectable,
          visited,
        );
        return;
      }
      if (node.type === AST_NODE_TYPES.LogicalExpression) {
        collectUnmappedSelections(node.left, unmapped, uninspectable, visited);
        collectUnmappedSelections(node.right, unmapped, uninspectable, visited);
        return;
      }
      if (node.type === AST_NODE_TYPES.SequenceExpression) {
        const selectedExpression = node.expressions.at(-1);
        if (selectedExpression !== undefined) {
          collectUnmappedSelections(
            selectedExpression,
            unmapped,
            uninspectable,
            visited,
          );
        }
        return;
      }
      if (node.type === AST_NODE_TYPES.ObjectExpression) {
        for (const property of node.properties) {
          if (property.type === AST_NODE_TYPES.SpreadElement) {
            collectUnmappedSelections(
              property.argument,
              unmapped,
              uninspectable,
              visited,
            );
          } else if (property.kind === "get") {
            const status = nodeSelectionResultTypeStatus(property.value);
            if (status === "unmapped") {
              unmapped.push(property.value);
            } else if (status === "uninspectable") {
              uninspectable.push(property.value);
            }
          } else {
            collectUnmappedSelections(
              property.value,
              unmapped,
              uninspectable,
              visited,
            );
          }
        }
        return;
      }

      if (isMutableLocalSelectionContainer(node)) {
        uninspectable.push(node);
        return;
      }

      const status = nodeSelectionTypeStatus(node);
      if (status === "unmapped") {
        unmapped.push(node);
      } else if (status === "uninspectable") {
        uninspectable.push(node);
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
      uninspectable: TSESTree.Node[],
      visited: Set<TSESTree.Node>,
    ): void {
      if (visited.has(node)) {
        return;
      }
      visited.add(node);

      const initializer = localVariableInitializer(node);
      if (initializer !== null) {
        collectUnmappedExtras(initializer, unmapped, uninspectable, visited);
        return;
      }
      const expression = transparentExpression(node);
      if (expression !== null) {
        collectUnmappedExtras(expression, unmapped, uninspectable, visited);
        return;
      }
      if (node.type === AST_NODE_TYPES.ConditionalExpression) {
        collectUnmappedExtras(
          node.consequent,
          unmapped,
          uninspectable,
          visited,
        );
        collectUnmappedExtras(node.alternate, unmapped, uninspectable, visited);
        return;
      }
      if (node.type === AST_NODE_TYPES.LogicalExpression) {
        collectUnmappedExtras(node.left, unmapped, uninspectable, visited);
        collectUnmappedExtras(node.right, unmapped, uninspectable, visited);
        return;
      }
      if (node.type === AST_NODE_TYPES.SequenceExpression) {
        const selectedExpression = node.expressions.at(-1);
        if (selectedExpression !== undefined) {
          collectUnmappedExtras(
            selectedExpression,
            unmapped,
            uninspectable,
            visited,
          );
        }
        return;
      }
      if (node.type === AST_NODE_TYPES.ObjectExpression) {
        collectUnmappedSelections(
          node,
          unmapped,
          uninspectable,
          new Set<TSESTree.Node>(),
        );
        return;
      }
      if (
        node.type === AST_NODE_TYPES.ArrowFunctionExpression &&
        node.body.type !== AST_NODE_TYPES.BlockStatement
      ) {
        collectUnmappedExtras(node.body, unmapped, uninspectable, visited);
        return;
      }
      if (isMutableLocalSelectionContainer(node)) {
        uninspectable.push(node);
        return;
      }
      const status = nodeSelectionResultTypeStatus(node);
      if (status === "unmapped") {
        unmapped.push(node);
      } else if (status === "uninspectable") {
        uninspectable.push(node);
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
          collectUnmappedExtras(
            property.value,
            unmapped,
            uninspectable,
            visited.extras,
          );
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
      name: string,
    ): TSESTree.Expression | null {
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

    function isResultMethod(
      name: string,
      symbol: TypeScriptSymbol | undefined,
      type: Type,
    ): boolean {
      return (
        isRelationalResultMethod(name, symbol, type) ||
        isStructuredSelectionMethod(name, symbol, type)
      );
    }

    function hasResultMethodHint(text: string): boolean {
      const normalizedText = text.toLowerCase();
      return RESULT_METHOD_HINTS.some((hint) => {
        return normalizedText.includes(hint);
      });
    }

    function isReflectedResultMethod(node: TSESTree.Node): boolean {
      if (
        node.type !== AST_NODE_TYPES.CallExpression ||
        node.callee.type !== AST_NODE_TYPES.MemberExpression ||
        node.callee.object.type !== AST_NODE_TYPES.Identifier ||
        node.callee.object.name !== "Reflect" ||
        resolvedMemberName(node.callee) !== "get"
      ) {
        return false;
      }
      const key = node.arguments[1];
      if (key === undefined || key.type === AST_NODE_TYPES.SpreadElement) {
        return false;
      }
      const name =
        key.type === AST_NODE_TYPES.Literal && typeof key.value === "string"
          ? key.value
          : staticStringValue(key);
      return (
        name !== null &&
        (RESULT_FIELD_ARGUMENT.has(name) || RELATIONAL_RESULT_METHODS.has(name))
      );
    }

    function variableInScope(
      node: TSESTree.Node,
      name: string,
    ): TSESLint.Scope.Variable | null {
      let scope: TSESLint.Scope.Scope | null =
        context.sourceCode.getScope(node);
      while (scope !== null) {
        const variable = scope.set.get(name);
        if (variable !== undefined) {
          return variable;
        }
        scope = scope.upper;
      }
      return null;
    }

    function variableHasResultMethodHint(
      variable: TSESLint.Scope.Variable,
    ): boolean {
      const cachedResult = resultMethodHintByVariable.get(variable);
      if (cachedResult !== undefined) {
        return cachedResult;
      }
      if (resultMethodHintVariablesInProgress.has(variable)) {
        return false;
      }
      const isOutermostAnalysis =
        resultMethodHintVariablesInProgress.size === 0;
      resultMethodHintVariablesInProgress.add(variable);

      for (const definition of variable.defs) {
        if (
          definition.node.type !== AST_NODE_TYPES.TSTypeAliasDeclaration &&
          definition.node.type !== AST_NODE_TYPES.TSInterfaceDeclaration &&
          definition.node.type !== AST_NODE_TYPES.VariableDeclarator
        ) {
          continue;
        }
        if (hasResultMethodHint(context.sourceCode.getText(definition.node))) {
          resultMethodHintByVariable.set(variable, true);
          resultMethodHintVariablesInProgress.delete(variable);
          return true;
        }
        for (const token of context.sourceCode.getTokens(definition.node)) {
          const referencedVariable = variableInScope(
            definition.node,
            token.value,
          );
          if (
            referencedVariable !== null &&
            variableHasResultMethodHint(referencedVariable)
          ) {
            resultMethodHintByVariable.set(variable, true);
            resultMethodHintVariablesInProgress.delete(variable);
            return true;
          }
        }
      }
      resultMethodHintVariablesInProgress.delete(variable);
      if (isOutermostAnalysis) {
        resultMethodHintByVariable.set(variable, false);
      }
      return false;
    }

    function typeAnnotationHasResultMethodHint(node: TSESTree.Node): boolean {
      if (hasResultMethodHint(context.sourceCode.getText(node))) {
        return true;
      }
      return context.sourceCode.getTokens(node).some((token) => {
        const variable = variableInScope(node, token.value);
        return variable !== null && variableHasResultMethodHint(variable);
      });
    }

    function identifierCanBeResultMethodAlias(
      node: TSESTree.Identifier,
    ): boolean {
      const variable = variableInScope(node, node.name);
      if (variable === null) {
        return false;
      }
      return variable.defs.some((definition) => {
        const typeAnnotation =
          "typeAnnotation" in definition.name
            ? definition.name.typeAnnotation
            : undefined;
        if (
          typeAnnotation !== undefined &&
          typeAnnotationHasResultMethodHint(typeAnnotation)
        ) {
          return true;
        }
        return (
          definition.node.type === AST_NODE_TYPES.VariableDeclarator &&
          definition.node.init !== null &&
          isReflectedResultMethod(definition.node.init)
        );
      });
    }

    function canBeResultMethodAlias(node: TSESTree.Expression): boolean {
      if (node.type === AST_NODE_TYPES.MemberExpression) {
        return (
          node.object.type === AST_NODE_TYPES.Identifier &&
          identifierCanBeResultMethodAlias(node.object)
        );
      }
      if (node.type !== AST_NODE_TYPES.Identifier) {
        return isReflectedResultMethod(node);
      }
      return identifierCanBeResultMethodAlias(node);
    }

    function resultMethodName(node: TSESTree.Expression): string | null {
      if (node.type === AST_NODE_TYPES.MemberExpression) {
        const name = resolvedMemberName(node);
        if (
          name !== null &&
          (RESULT_FIELD_ARGUMENT.has(name) ||
            RELATIONAL_RESULT_METHODS.has(name))
        ) {
          const tsNode = services.esTreeNodeToTSNodeMap.get(node);
          const type = checker.getTypeAtLocation(tsNode);
          return isResultMethod(name, symbolAt(node.property), type)
            ? name
            : null;
        }
      }
      if (!canBeResultMethodAlias(node)) {
        return null;
      }

      const tsNode = services.esTreeNodeToTSNodeMap.get(node);
      const type = checker.getTypeAtLocation(tsNode);
      const cachedName = resultMethodNameByType.get(type);
      if (cachedName !== undefined) {
        return cachedName;
      }
      for (const name of RESULT_METHOD_NAMES) {
        if (
          type.getCallSignatures().some((signature) => {
            return isNamedDrizzleSignature(signature, name);
          }) &&
          isResultMethod(name, undefined, type)
        ) {
          resultMethodNameByType.set(type, name);
          return name;
        }
      }
      resultMethodNameByType.set(type, null);
      return null;
    }

    function isResultMethodMember(node: TSESTree.MemberExpression): boolean {
      return resultMethodName(node) !== null;
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

    function isUnsafeSqlAssertion(
      node: TSESTree.TSAsExpression | TSESTree.TSTypeAssertion,
    ): boolean {
      return (
        nodeContainsUntrustedSql(node.expression) &&
        !nodeContainsUntrustedSql(node)
      );
    }

    function checkAssertion(
      node: TSESTree.TSAsExpression | TSESTree.TSTypeAssertion,
    ): void {
      if (isUnsafeSqlAssertion(node)) {
        context.report({ node, messageId: "sqlAssertion" });
      }
    }

    function containsReportedResultMethodReference(
      node: TSESTree.Node,
      visited: Set<TSESTree.Node>,
    ): boolean {
      if (visited.has(node)) {
        return false;
      }
      visited.add(node);

      const initializer = localVariableInitializer(node);
      if (initializer !== null) {
        return containsReportedResultMethodReference(initializer, visited);
      }
      const expression = transparentExpression(node);
      if (expression !== null) {
        return containsReportedResultMethodReference(expression, visited);
      }
      if (node.type === AST_NODE_TYPES.MemberExpression) {
        return (
          isResultMethodMember(node) ||
          containsReportedResultMethodReference(node.object, visited) ||
          (node.computed &&
            containsReportedResultMethodReference(node.property, visited))
        );
      }
      if (node.type === AST_NODE_TYPES.CallExpression) {
        if (containsReportedResultMethodReference(node.callee, visited)) {
          return true;
        }
        return node.arguments.some((argument) => {
          return containsReportedResultMethodReference(
            argument.type === AST_NODE_TYPES.SpreadElement
              ? argument.argument
              : argument,
            visited,
          );
        });
      }
      if (
        node.type === AST_NODE_TYPES.ConditionalExpression ||
        node.type === AST_NODE_TYPES.LogicalExpression
      ) {
        return (
          containsReportedResultMethodReference(
            node.type === AST_NODE_TYPES.ConditionalExpression
              ? node.consequent
              : node.left,
            visited,
          ) ||
          containsReportedResultMethodReference(
            node.type === AST_NODE_TYPES.ConditionalExpression
              ? node.alternate
              : node.right,
            visited,
          )
        );
      }
      if (node.type === AST_NODE_TYPES.SequenceExpression) {
        return node.expressions.some((item) => {
          return containsReportedResultMethodReference(item, visited);
        });
      }
      return false;
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
      TSClassImplements(node: TSESTree.TSClassImplements): void {
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
        checkResultDecoder(node);
        if (
          node.typeArguments?.params.length === 1 &&
          isDrizzleSqlTag(node.callee)
        ) {
          context.report({ node, messageId: "sqlTypeArgument" });
        } else if (isGenericDrizzleSqlAlias(node)) {
          context.report({ node, messageId: "sqlAliasTypeArgument" });
        }

        let methodName: string;
        if (node.callee.type === AST_NODE_TYPES.MemberExpression) {
          const directName = resolvedMemberName(node.callee);
          if (
            directName !== null &&
            (RESULT_FIELD_ARGUMENT.has(directName) ||
              RELATIONAL_RESULT_METHODS.has(directName))
          ) {
            methodName = directName;
          } else {
            const aliasName = resultMethodName(node.callee);
            if (aliasName === null) {
              return;
            }
            context.report({
              node: node.callee,
              messageId: "resultMethodReference",
            });
            return;
          }
        } else {
          const aliasName = resultMethodName(node.callee);
          if (aliasName === null) {
            return;
          }
          const initializer = localVariableInitializer(node.callee);
          if (
            initializer === null ||
            !containsReportedResultMethodReference(
              initializer,
              new Set<TSESTree.Node>(),
            )
          ) {
            context.report({
              node: node.callee,
              messageId: "resultMethodReference",
            });
          }
          return;
        }

        const hasSpreadArgument = node.arguments.some(
          (argument) => argument.type === AST_NODE_TYPES.SpreadElement,
        );
        if (hasSpreadArgument) {
          if (!isResultMethodMember(node.callee)) {
            return;
          }
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

        if (RELATIONAL_RESULT_METHODS.has(methodName)) {
          if (!isResultMethodMember(node.callee)) {
            return;
          }
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

        const fields = resultFieldArgument(node, methodName);
        if (fields === null) {
          return;
        }
        const unmapped: TSESTree.Node[] = [];
        const uninspectable: TSESTree.Node[] = [];
        collectUnmappedSelections(
          fields,
          unmapped,
          uninspectable,
          new Set<TSESTree.Node>(),
        );
        if (
          (unmapped.length === 0 && uninspectable.length === 0) ||
          !isResultMethodMember(node.callee)
        ) {
          return;
        }
        for (const field of unmapped) {
          context.report({ node: field, messageId: "unmappedResult" });
        }
        for (const field of uninspectable) {
          context.report({
            node: field,
            messageId: "uninspectableResultSelection",
          });
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
