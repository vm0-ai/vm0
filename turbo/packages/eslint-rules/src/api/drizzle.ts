import {
  AST_NODE_TYPES,
  type ParserServicesWithTypeInformation,
  type TSESTree,
} from "@typescript-eslint/utils";
import {
  forEachChild,
  isAsExpression,
  isArrowFunction,
  isBlock,
  isCallExpression,
  isCallSignatureDeclaration,
  isComputedPropertyName,
  isFunctionExpression,
  isIdentifier,
  isInterfaceDeclaration,
  isNonNullExpression,
  isNumericLiteral,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isReturnStatement,
  isSatisfiesExpression,
  isSpreadAssignment,
  isStringLiteralLike,
  isTypeAssertionExpression,
  isVariableDeclaration,
  isVariableDeclarationList,
  NodeFlags,
  SymbolFlags,
  SyntaxKind,
  TypeFlags,
  type CallExpression,
  type Declaration,
  type Node,
  type PropertyName,
  type Signature,
  type Symbol as TypeScriptSymbol,
  type Type,
  type TypeChecker,
} from "typescript";

export function isDrizzleDeclaration(node: Declaration): boolean {
  const sourcePath = node.getSourceFile().fileName.replaceAll("\\", "/");
  return sourcePath.includes("/node_modules/drizzle-orm/");
}

export function resolvedSymbol(
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

export function isDrizzleSymbol(
  checker: TypeChecker,
  symbol: TypeScriptSymbol | undefined,
): boolean {
  return (
    resolvedSymbol(checker, symbol)?.declarations?.some(
      isDrizzleDeclaration,
    ) === true
  );
}

export function isNamedDrizzleSignature(
  signature: Signature,
  name: string,
): boolean {
  const declaration = signature.declaration;
  return (
    declaration !== undefined &&
    "name" in declaration &&
    declaration.name?.getText() === name &&
    isDrizzleDeclaration(declaration)
  );
}

interface RuntimeColumnDefinition {
  readonly databaseName: string;
  readonly propertyName: string;
}

interface StableDrizzleTableOrigin {
  readonly columns: readonly RuntimeColumnDefinition[] | undefined;
}

function unwrapTransparentExpression(node: Node): Node {
  let current = node;
  while (
    isAsExpression(current) ||
    isNonNullExpression(current) ||
    isParenthesizedExpression(current) ||
    isSatisfiesExpression(current) ||
    isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function unwrapStableOriginExpression(node: Node): Node {
  let current = node;
  while (
    isNonNullExpression(current) ||
    isParenthesizedExpression(current) ||
    isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function sameRuntimeColumns(
  left: readonly RuntimeColumnDefinition[] | undefined,
  right: readonly RuntimeColumnDefinition[] | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return (
    left.length === right.length &&
    left.every((column, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        column.databaseName === other.databaseName &&
        column.propertyName === other.propertyName
      );
    })
  );
}

function stableDrizzleTableSymbol(
  checker: TypeChecker,
  symbol: TypeScriptSymbol,
  visited: Set<TypeScriptSymbol>,
): StableDrizzleTableOrigin | undefined {
  const resolved = resolvedSymbol(checker, symbol);
  if (
    resolved === undefined ||
    visited.has(resolved) ||
    resolved.declarations === undefined ||
    resolved.declarations.length === 0
  ) {
    return undefined;
  }
  visited.add(resolved);
  const orders = resolved.declarations.map((declaration) => {
    // A `let`, destructuring default, or object property can resolve to a
    // different same-typed table by the time the query executes.
    if (
      !isVariableDeclaration(declaration) ||
      !isVariableDeclarationList(declaration.parent) ||
      (declaration.parent.flags & NodeFlags.Const) === 0 ||
      declaration.initializer === undefined
    ) {
      return undefined;
    }
    return stableDrizzleTableOrigin(checker, declaration.initializer, visited);
  });
  visited.delete(resolved);
  const first = orders[0];
  return first !== undefined &&
    orders.every((order) => {
      return (
        order !== undefined && sameRuntimeColumns(order.columns, first.columns)
      );
    })
    ? first
    : undefined;
}

function staticPropertyName(name: PropertyName): string | undefined {
  if (isIdentifier(name) || isStringLiteralLike(name)) {
    return name.text;
  }
  if (isNumericLiteral(name)) {
    const value = Number(name.text.replaceAll("_", ""));
    return Number.isFinite(value) ? String(value) : undefined;
  }
  if (!isComputedPropertyName(name)) {
    return undefined;
  }
  const expression = unwrapTransparentExpression(name.expression);
  if (isStringLiteralLike(expression)) {
    return expression.text;
  }
  if (isNumericLiteral(expression)) {
    const value = Number(expression.text.replaceAll("_", ""));
    return Number.isFinite(value) ? String(value) : undefined;
  }
  return undefined;
}

function runtimeColumnOrder(
  definitions: readonly RuntimeColumnDefinition[],
): readonly RuntimeColumnDefinition[] {
  // Drizzle builds table columns with Object.entries(...). Let the runtime
  // apply the same integer-index ordering and overwrite semantics.
  const properties: Record<string, RuntimeColumnDefinition> = {};
  for (const definition of definitions) {
    properties[definition.propertyName] = definition;
  }
  return Object.keys(properties).flatMap((propertyName) => {
    const definition = properties[propertyName];
    return definition === undefined ? [] : [definition];
  });
}

function containsTypeAssertion(node: Node): boolean {
  if (isAsExpression(node) || isTypeAssertionExpression(node)) {
    return true;
  }
  let found = false;
  function visit(current: Node): void {
    if (!found) {
      found = containsTypeAssertion(current);
    }
  }
  forEachChild(node, visit);
  return found;
}

function stableStringValue(
  checker: TypeChecker,
  node: Node,
  visited: Set<TypeScriptSymbol> = new Set(),
): string | undefined {
  const expression = unwrapStableOriginExpression(node);
  if (isStringLiteralLike(expression)) {
    return expression.text;
  }
  if (!isIdentifier(expression)) {
    return undefined;
  }
  const symbol = resolvedSymbol(
    checker,
    checker.getSymbolAtLocation(expression),
  );
  if (
    symbol === undefined ||
    visited.has(symbol) ||
    symbol.declarations === undefined ||
    symbol.declarations.length === 0
  ) {
    return undefined;
  }
  visited.add(symbol);
  const values = symbol.declarations.map((declaration) => {
    return isVariableDeclaration(declaration) &&
      isVariableDeclarationList(declaration.parent) &&
      (declaration.parent.flags & NodeFlags.Const) !== 0 &&
      declaration.initializer !== undefined
      ? stableStringValue(checker, declaration.initializer, visited)
      : undefined;
  });
  visited.delete(symbol);
  const first = values[0];
  return first !== undefined &&
    values.every((value) => {
      return value === first;
    })
    ? first
    : undefined;
}

// A Drizzle-declared call signature can be attached to a different runtime
// function. Follow immutable aliases and Drizzle-produced factories instead
// of treating the signature itself as runtime provenance.
function hasStableDrizzleRuntimeSymbol(
  checker: TypeChecker,
  symbol: TypeScriptSymbol,
  visited: Set<TypeScriptSymbol>,
): boolean {
  const resolved = resolvedSymbol(checker, symbol);
  if (resolved === undefined || visited.has(resolved)) {
    return false;
  }
  if (isDrizzleSymbol(checker, resolved)) {
    return true;
  }
  if (
    resolved.declarations === undefined ||
    resolved.declarations.length === 0
  ) {
    return false;
  }
  visited.add(resolved);
  const stable = resolved.declarations.every((declaration) => {
    return (
      isVariableDeclaration(declaration) &&
      isVariableDeclarationList(declaration.parent) &&
      (declaration.parent.flags & NodeFlags.Const) !== 0 &&
      declaration.initializer !== undefined &&
      hasStableDrizzleRuntimeOrigin(checker, declaration.initializer, visited)
    );
  });
  visited.delete(resolved);
  return stable;
}

function hasStableDrizzleRuntimeOrigin(
  checker: TypeChecker,
  node: Node,
  visited: Set<TypeScriptSymbol>,
): boolean {
  const expression = unwrapStableOriginExpression(node);
  if (isIdentifier(expression)) {
    const symbol = checker.getSymbolAtLocation(expression);
    return (
      symbol !== undefined &&
      hasStableDrizzleRuntimeSymbol(checker, symbol, visited)
    );
  }
  if (isPropertyAccessExpression(expression)) {
    const property = checker.getSymbolAtLocation(expression.name);
    return (
      isDrizzleSymbol(checker, property) &&
      hasStableDrizzleRuntimeOrigin(checker, expression.expression, visited)
    );
  }
  if (!isCallExpression(expression)) {
    return false;
  }
  const signature = checker.getResolvedSignature(expression);
  return (
    signature?.declaration !== undefined &&
    isDrizzleDeclaration(signature.declaration) &&
    hasStableDrizzleRuntimeOrigin(checker, expression.expression, visited)
  );
}

function hasDirectDrizzleCallOrigin(checker: TypeChecker, node: Node): boolean {
  const expression = unwrapStableOriginExpression(node);
  if (!isCallExpression(expression)) {
    return false;
  }
  const signature = checker.getResolvedSignature(expression);
  if (
    signature?.declaration === undefined ||
    !isDrizzleDeclaration(signature.declaration)
  ) {
    return false;
  }
  const callee = unwrapStableOriginExpression(expression.expression);
  if (isCallExpression(callee)) {
    return hasStableDrizzleRuntimeOrigin(checker, callee, new Set());
  }
  if (!isPropertyAccessExpression(callee)) {
    return hasStableDrizzleRuntimeOrigin(checker, callee, new Set());
  }
  const receiver = unwrapStableOriginExpression(callee.expression);
  return isDrizzleColumnBuilderType(
    checker,
    checker.getTypeAtLocation(receiver),
    receiver,
  )
    ? freshDrizzleColumnBuilderName(checker, receiver) !== undefined
    : hasStableDrizzleRuntimeOrigin(checker, callee, new Set());
}

function initialColumnBuilderCall(
  checker: TypeChecker,
  node: Node,
): CallExpression | undefined {
  const expression = unwrapStableOriginExpression(node);
  if (!isCallExpression(expression)) {
    return undefined;
  }
  const callee = unwrapStableOriginExpression(expression.expression);
  if (!isPropertyAccessExpression(callee)) {
    return expression;
  }
  const receiver = unwrapStableOriginExpression(callee.expression);
  return isDrizzleColumnBuilderType(
    checker,
    checker.getTypeAtLocation(receiver),
    receiver,
  )
    ? initialColumnBuilderCall(checker, receiver)
    : expression;
}

function runtimeColumnBuilderName(
  checker: TypeChecker,
  call: CallExpression,
): string | undefined {
  const firstArgument = call.arguments[0];
  if (firstArgument === undefined) {
    return "";
  }
  if (firstArgument.kind === SyntaxKind.SpreadElement) {
    return undefined;
  }
  const argument = unwrapStableOriginExpression(firstArgument);
  if (isObjectLiteralExpression(argument)) {
    return "";
  }
  const argumentType = checker.getTypeAtLocation(argument);
  return (argumentType.flags & TypeFlags.Undefined) !== 0
    ? ""
    : stableStringValue(checker, argument);
}

function freshDrizzleColumnBuilderName(
  checker: TypeChecker,
  node: Node,
): string | undefined {
  // Column builders are mutable. A stored builder may have been reused or
  // mutated through an ignored fluent return, leaving its static metadata out
  // of sync with the columns that pgTable(...) builds at runtime.
  const expression = unwrapStableOriginExpression(node);
  if (
    !isCallExpression(expression) ||
    !hasDirectDrizzleCallOrigin(checker, expression)
  ) {
    return undefined;
  }
  const type = checker.getTypeAtLocation(expression);
  const staticName = drizzleColumnBuilderName(checker, type, expression);
  const initialCall = initialColumnBuilderCall(checker, expression);
  const runtimeName =
    initialCall === undefined
      ? undefined
      : runtimeColumnBuilderName(checker, initialCall);
  return staticName !== undefined && runtimeName === staticName
    ? runtimeName
    : undefined;
}

function staticRuntimeColumns(
  checker: TypeChecker,
  node: Node,
): readonly RuntimeColumnDefinition[] | undefined {
  const expression = unwrapStableOriginExpression(node);
  if (!isObjectLiteralExpression(expression)) {
    return undefined;
  }

  const definitions: RuntimeColumnDefinition[] = [];
  for (const property of expression.properties) {
    if (isSpreadAssignment(property)) {
      const spreadDefinitions = staticRuntimeColumns(
        checker,
        property.expression,
      );
      if (spreadDefinitions === undefined) {
        return undefined;
      }
      definitions.push(...spreadDefinitions);
      continue;
    }
    if (!isPropertyAssignment(property)) {
      return undefined;
    }
    const propertyName = staticPropertyName(property.name);
    const builderName = freshDrizzleColumnBuilderName(
      checker,
      property.initializer,
    );
    // `__proto__` has special object-literal semantics and is not a normal own
    // property in every supported spelling.
    if (
      propertyName === undefined ||
      propertyName === "__proto__" ||
      builderName === undefined
    ) {
      return undefined;
    }
    definitions.push({
      databaseName: builderName === "" ? propertyName : builderName,
      propertyName,
    });
  }
  return runtimeColumnOrder(definitions);
}

function tableColumnDefinition(node: Node): Node | undefined {
  const expression = unwrapTransparentExpression(node);
  if (!isArrowFunction(expression) && !isFunctionExpression(expression)) {
    return expression;
  }
  if (!isBlock(expression.body)) {
    return expression.body;
  }
  if (
    expression.body.statements.length !== 1 ||
    !isReturnStatement(expression.body.statements[0])
  ) {
    return undefined;
  }
  return expression.body.statements[0].expression;
}

function isPgTableFactorySignature(signature: Signature): boolean {
  const declaration = signature.declaration;
  return (
    declaration !== undefined &&
    isCallSignatureDeclaration(declaration) &&
    isInterfaceDeclaration(declaration.parent) &&
    declaration.parent.name.text === "PgTableFn" &&
    isDrizzleDeclaration(declaration)
  );
}

function stableDrizzleTableOrigin(
  checker: TypeChecker,
  node: Node,
  visited: Set<TypeScriptSymbol>,
): StableDrizzleTableOrigin | undefined {
  // A type assertion can expose another table's column metadata while leaving
  // the runtime table unchanged. That makes builder column mapping unprovable.
  const expression = unwrapStableOriginExpression(node);
  if (isCallExpression(expression)) {
    const signature = checker.getResolvedSignature(expression);
    const columns = expression.arguments[1];
    if (
      signature === undefined ||
      !isPgTableFactorySignature(signature) ||
      !hasStableDrizzleRuntimeOrigin(
        checker,
        expression.expression,
        new Set(),
      ) ||
      columns === undefined ||
      !isDrizzleTableType(
        checker,
        checker.getTypeAtLocation(expression),
        expression,
      )
    ) {
      return undefined;
    }
    const definition = tableColumnDefinition(columns);
    return {
      columns:
        definition === undefined || containsTypeAssertion(columns)
          ? undefined
          : staticRuntimeColumns(checker, definition),
    };
  }

  const symbol = checker.getSymbolAtLocation(expression);
  return symbol === undefined
    ? undefined
    : stableDrizzleTableSymbol(checker, symbol, visited);
}

export function isDrizzleSqlTag(
  checker: TypeChecker,
  services: ParserServicesWithTypeInformation,
  node: TSESTree.Expression,
): boolean {
  let symbol: TypeScriptSymbol | undefined;
  if (node.type === AST_NODE_TYPES.Identifier) {
    const tsNode = services.esTreeNodeToTSNodeMap.get(node);
    symbol = resolvedSymbol(checker, checker.getSymbolAtLocation(tsNode));
  } else if (node.type === AST_NODE_TYPES.MemberExpression) {
    const tsProperty = services.esTreeNodeToTSNodeMap.get(node.property);
    symbol = resolvedSymbol(checker, checker.getSymbolAtLocation(tsProperty));
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

export function isDrizzleWrapperType(
  checker: TypeChecker,
  type: Type,
): boolean {
  if ((type.flags & TypeFlags.TypeParameter) !== 0) {
    const constraint = checker.getBaseConstraintOfType(type);
    return (
      constraint !== undefined && isDrizzleWrapperType(checker, constraint)
    );
  }
  if (isDrizzleSymbol(checker, checker.getPropertyOfType(type, "getSQL"))) {
    return true;
  }
  return (
    type.isUnion() &&
    type.types.every((member) => {
      return isDrizzleWrapperType(checker, member);
    })
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

function drizzleBrand(
  checker: TypeChecker,
  type: Type,
  location: Node,
): string | undefined {
  const metadataType = propertyType(checker, type, "_", location);
  if (metadataType === undefined) {
    return undefined;
  }
  const brandType = propertyType(checker, metadataType, "brand", location);
  return brandType?.isStringLiteral() === true ? brandType.value : undefined;
}

function everyConcreteType(
  checker: TypeChecker,
  type: Type,
  predicate: (member: Type) => boolean,
): boolean {
  if (type.isUnion()) {
    return type.types.every((member) => {
      return everyConcreteType(checker, member, predicate);
    });
  }
  if ((type.flags & TypeFlags.TypeParameter) !== 0) {
    const constraint = checker.getBaseConstraintOfType(type);
    return (
      constraint !== undefined &&
      everyConcreteType(checker, constraint, predicate)
    );
  }
  return predicate(type);
}

export function isDrizzleColumnType(
  checker: TypeChecker,
  type: Type,
  location: Node,
): boolean {
  return everyConcreteType(checker, type, (member) => {
    return (
      isDrizzleWrapperType(checker, member) &&
      drizzleBrand(checker, member, location) === "Column"
    );
  });
}

export function isDrizzleTableType(
  checker: TypeChecker,
  type: Type,
  location: Node,
): boolean {
  return everyConcreteType(checker, type, (member) => {
    return (
      isDrizzleWrapperType(checker, member) &&
      drizzleBrand(checker, member, location) === "Table"
    );
  });
}

function isDrizzleColumnBuilderType(
  checker: TypeChecker,
  type: Type,
  location: Node,
): boolean {
  return everyConcreteType(checker, type, (member) => {
    return drizzleBrand(checker, member, location) === "ColumnBuilder";
  });
}

function drizzleColumnBuilderName(
  checker: TypeChecker,
  type: Type,
  location: Node,
): string | undefined {
  if (type.isUnion()) {
    const names = type.types.map((member) => {
      return drizzleColumnBuilderName(checker, member, location);
    });
    const first = names[0];
    return first !== undefined &&
      names.every((name) => {
        return name === first;
      })
      ? first
      : undefined;
  }
  if ((type.flags & TypeFlags.TypeParameter) !== 0) {
    const constraint = checker.getBaseConstraintOfType(type);
    return constraint === undefined
      ? undefined
      : drizzleColumnBuilderName(checker, constraint, location);
  }
  if (!isDrizzleColumnBuilderType(checker, type, location)) {
    return undefined;
  }
  const metadataType = propertyType(checker, type, "_", location);
  return metadataType === undefined
    ? undefined
    : exactStringProperty(checker, metadataType, "name", location);
}

export interface DrizzleTableColumnMetadata {
  readonly databaseName: string;
  readonly hasDefault: boolean;
  readonly isEmittedOnInsert: boolean;
  readonly isWritable: boolean;
  readonly propertyName: string;
  readonly propertySymbol: TypeScriptSymbol;
  readonly tableName: string;
}

export interface DrizzleTableMetadata {
  readonly columns: ReadonlyMap<string, DrizzleTableColumnMetadata>;
  readonly hasDirectTableConfig: boolean;
  readonly hasRuntimeColumnOrder: boolean;
  readonly name: string;
  readonly schema: string | undefined;
}

export interface StableDrizzleColumnOrigin {
  readonly column: DrizzleTableColumnMetadata;
  readonly table: DrizzleTableMetadata;
}

interface DrizzleColumnMetadata {
  readonly databaseName: string;
  readonly isEmittedOnInsert: boolean;
  readonly tableName: string;
}

function exactStringProperty(
  checker: TypeChecker,
  type: Type,
  name: string,
  location: Node,
): string | undefined {
  const value = propertyType(checker, type, name, location);
  return value?.isStringLiteral() === true ? value.value : undefined;
}

function exactBooleanProperty(
  checker: TypeChecker,
  type: Type,
  name: string,
  location: Node,
): boolean | undefined {
  const value = propertyType(checker, type, name, location);
  if (value === undefined || (value.flags & TypeFlags.BooleanLiteral) === 0) {
    return undefined;
  }
  return checker.isTypeAssignableTo(value, checker.getTrueType());
}

function concreteDrizzleColumnMetadata(
  checker: TypeChecker,
  type: Type,
  location: Node,
): (DrizzleColumnMetadata & { readonly hasDefault: boolean }) | undefined {
  if (
    !isDrizzleWrapperType(checker, type) ||
    drizzleBrand(checker, type, location) !== "Column"
  ) {
    return undefined;
  }
  const metadataType = propertyType(checker, type, "_", location);
  if (metadataType === undefined) {
    return undefined;
  }
  const databaseName = exactStringProperty(
    checker,
    metadataType,
    "name",
    location,
  );
  const tableName = exactStringProperty(
    checker,
    metadataType,
    "tableName",
    location,
  );
  const hasDefault = exactBooleanProperty(
    checker,
    metadataType,
    "hasDefault",
    location,
  );
  const dialect = exactStringProperty(
    checker,
    metadataType,
    "dialect",
    location,
  );
  const generated = propertyType(checker, metadataType, "generated", location);
  const generatedType =
    generated === undefined
      ? undefined
      : exactStringProperty(checker, generated, "type", location);
  const isEmittedOnInsert =
    generated === undefined
      ? undefined
      : (generated.flags & TypeFlags.Undefined) !== 0
        ? true
        : generatedType === "always"
          ? false
          : generatedType === "byDefault"
            ? true
            : undefined;
  return databaseName === undefined ||
    tableName === undefined ||
    hasDefault === undefined ||
    dialect !== "pg" ||
    isEmittedOnInsert === undefined
    ? undefined
    : { databaseName, hasDefault, isEmittedOnInsert, tableName };
}

function sameColumnMetadata(
  left: DrizzleColumnMetadata & { readonly hasDefault: boolean },
  right: DrizzleColumnMetadata & { readonly hasDefault: boolean },
): boolean {
  return (
    left.databaseName === right.databaseName &&
    left.hasDefault === right.hasDefault &&
    left.isEmittedOnInsert === right.isEmittedOnInsert &&
    left.tableName === right.tableName
  );
}

function drizzleColumnMetadata(
  checker: TypeChecker,
  type: Type,
  location: Node,
): (DrizzleColumnMetadata & { readonly hasDefault: boolean }) | undefined {
  if (type.isUnion()) {
    const members = type.types.map((member) => {
      return drizzleColumnMetadata(checker, member, location);
    });
    const first = members[0];
    return first !== undefined &&
      members.every((member) => {
        return member !== undefined && sameColumnMetadata(first, member);
      })
      ? first
      : undefined;
  }
  if ((type.flags & TypeFlags.TypeParameter) !== 0) {
    const constraint = checker.getBaseConstraintOfType(type);
    return constraint === undefined
      ? undefined
      : drizzleColumnMetadata(checker, constraint, location);
  }
  return concreteDrizzleColumnMetadata(checker, type, location);
}

function exactSchemaName(
  checker: TypeChecker,
  metadataType: Type,
  location: Node,
): string | null | undefined {
  const schemaType = propertyType(checker, metadataType, "schema", location);
  if (schemaType === undefined) {
    return undefined;
  }
  if ((schemaType.flags & TypeFlags.Undefined) !== 0) {
    return null;
  }
  return schemaType.isStringLiteral() ? schemaType.value : undefined;
}

function concreteDrizzleTableMetadata(
  checker: TypeChecker,
  type: Type,
  location: Node,
): DrizzleTableMetadata | undefined {
  if (
    !isDrizzleWrapperType(checker, type) ||
    drizzleBrand(checker, type, location) !== "Table"
  ) {
    return undefined;
  }
  const metadataType = propertyType(checker, type, "_", location);
  if (metadataType === undefined) {
    return undefined;
  }
  const name = exactStringProperty(checker, metadataType, "name", location);
  const schema = exactSchemaName(checker, metadataType, location);
  const configType = propertyType(checker, metadataType, "config", location);
  const columnsType = propertyType(checker, metadataType, "columns", location);
  const insertType = propertyType(
    checker,
    metadataType,
    "inferInsert",
    location,
  );
  if (
    name === undefined ||
    schema === undefined ||
    configType === undefined ||
    columnsType === undefined ||
    insertType === undefined
  ) {
    return undefined;
  }
  const insertProperties = new Set(
    checker.getPropertiesOfType(insertType).map((property) => {
      return property.getName();
    }),
  );
  const columnProperties = checker.getPropertiesOfType(columnsType);
  if (
    [...insertProperties].some((propertyName) => {
      return !columnProperties.some((property) => {
        return property.getName() === propertyName;
      });
    })
  ) {
    return undefined;
  }
  const columns = new Map<string, DrizzleTableColumnMetadata>();
  for (const property of columnProperties) {
    const propertyName = property.getName();
    const directProperty = checker.getPropertyOfType(type, propertyName);
    const column = drizzleColumnMetadata(
      checker,
      checker.getTypeOfSymbolAtLocation(property, location),
      location,
    );
    if (
      directProperty === undefined ||
      column === undefined ||
      // pgTable(...) assigns this runtime method after assigning columns, so
      // the same-named schema property is not a directly accessible column.
      propertyName === "enableRLS" ||
      column.tableName !== name ||
      columns.has(column.databaseName)
    ) {
      return undefined;
    }
    columns.set(column.databaseName, {
      ...column,
      isWritable: insertProperties.has(propertyName),
      propertyName,
      propertySymbol: resolvedSymbol(checker, directProperty) ?? directProperty,
    });
  }
  return {
    columns,
    hasDirectTableConfig: configType.aliasSymbol === undefined,
    hasRuntimeColumnOrder: false,
    name,
    schema: schema ?? undefined,
  };
}

function sameTableMetadata(
  left: DrizzleTableMetadata,
  right: DrizzleTableMetadata,
): boolean {
  if (
    left.name !== right.name ||
    left.schema !== right.schema ||
    left.hasDirectTableConfig !== right.hasDirectTableConfig ||
    left.hasRuntimeColumnOrder !== right.hasRuntimeColumnOrder ||
    left.columns.size !== right.columns.size
  ) {
    return false;
  }
  const rightColumns = [...right.columns];
  let index = 0;
  for (const [databaseName, column] of left.columns) {
    const otherEntry = rightColumns[index];
    index += 1;
    if (otherEntry === undefined) {
      return false;
    }
    const [otherDatabaseName, other] = otherEntry;
    if (
      databaseName !== otherDatabaseName ||
      column.hasDefault !== other.hasDefault ||
      column.isEmittedOnInsert !== other.isEmittedOnInsert ||
      column.isWritable !== other.isWritable ||
      column.propertyName !== other.propertyName ||
      column.tableName !== other.tableName
    ) {
      return false;
    }
  }
  return true;
}

function getDrizzleTableMetadata(
  checker: TypeChecker,
  type: Type,
  location: Node,
): DrizzleTableMetadata | undefined {
  if (type.isUnion()) {
    const members = type.types.map((member) => {
      return getDrizzleTableMetadata(checker, member, location);
    });
    const first = members[0];
    return first !== undefined &&
      members.every((member) => {
        return member !== undefined && sameTableMetadata(first, member);
      })
      ? first
      : undefined;
  }
  if ((type.flags & TypeFlags.TypeParameter) !== 0) {
    const constraint = checker.getBaseConstraintOfType(type);
    return constraint === undefined
      ? undefined
      : getDrizzleTableMetadata(checker, constraint, location);
  }
  return concreteDrizzleTableMetadata(checker, type, location);
}

export function getStableDrizzleTableMetadata(
  checker: TypeChecker,
  node: Node,
): DrizzleTableMetadata | undefined {
  const metadata = getDrizzleTableMetadata(
    checker,
    checker.getTypeAtLocation(node),
    node,
  );
  const origin = stableDrizzleTableOrigin(checker, node, new Set());
  if (metadata === undefined || origin === undefined) {
    return undefined;
  }
  const runtimeColumns = origin.columns;
  if (runtimeColumns === undefined) {
    return metadata;
  }
  if (runtimeColumns.length !== metadata.columns.size) {
    return metadata;
  }

  const columnsByProperty = new Map(
    [...metadata.columns.values()].map((column) => {
      return [column.propertyName, column] as const;
    }),
  );
  const columns = new Map<string, DrizzleTableColumnMetadata>();
  for (const runtimeColumn of runtimeColumns) {
    const column = columnsByProperty.get(runtimeColumn.propertyName);
    if (
      column === undefined ||
      column.databaseName !== runtimeColumn.databaseName ||
      columns.has(column.databaseName)
    ) {
      return metadata;
    }
    columns.set(column.databaseName, column);
  }
  return columns.size === metadata.columns.size
    ? { ...metadata, columns, hasRuntimeColumnOrder: true }
    : metadata;
}

export function getStableDrizzleColumnOrigin(
  checker: TypeChecker,
  node: Node,
): StableDrizzleColumnOrigin | undefined {
  const expression = unwrapStableOriginExpression(node);
  if (!isPropertyAccessExpression(expression)) {
    return undefined;
  }
  const table = getStableDrizzleTableMetadata(checker, expression.expression);
  if (table?.hasRuntimeColumnOrder !== true) {
    return undefined;
  }
  const column = [...(table?.columns.values() ?? [])].find((candidate) => {
    return candidate.propertyName === expression.name.text;
  });
  const propertySymbol = resolvedSymbol(
    checker,
    checker.getSymbolAtLocation(expression.name),
  );
  return table !== undefined &&
    column !== undefined &&
    propertySymbol === column.propertySymbol
    ? { column, table }
    : undefined;
}

export function getDrizzleColumnMetadata(
  checker: TypeChecker,
  type: Type,
  location: Node,
):
  | Readonly<
      Omit<
        DrizzleTableColumnMetadata,
        "isWritable" | "propertyName" | "propertySymbol"
      >
    >
  | undefined {
  return drizzleColumnMetadata(checker, type, location);
}

export function isDrizzleArrayParameter(
  checker: TypeChecker,
  services: ParserServicesWithTypeInformation,
  node: TSESTree.Expression,
): boolean {
  if (
    node.type !== AST_NODE_TYPES.CallExpression ||
    node.arguments.length === 0 ||
    node.arguments.some((argument) => {
      return argument.type === AST_NODE_TYPES.SpreadElement;
    })
  ) {
    return false;
  }
  const tsCall = services.esTreeNodeToTSNodeMap.get(node);
  const signature = checker.getResolvedSignature(tsCall);
  const argument = node.arguments[0];
  if (
    signature === undefined ||
    !isNamedDrizzleSignature(signature, "param") ||
    argument === undefined ||
    argument.type === AST_NODE_TYPES.SpreadElement
  ) {
    return false;
  }
  const argumentType = checker.getTypeAtLocation(
    services.esTreeNodeToTSNodeMap.get(argument),
  );
  return everyConcreteType(checker, argumentType, (member) => {
    return checker.isArrayType(member) || checker.isTupleType(member);
  });
}

export function isDrizzleSqlType(
  checker: TypeChecker,
  type: Type,
  location: Node,
): boolean {
  return everyConcreteType(checker, type, (member) => {
    return (
      isDrizzleWrapperType(checker, member) &&
      drizzleBrand(checker, member, location) === "SQL"
    );
  });
}

export function isDrizzleSelectType(
  checker: TypeChecker,
  type: Type,
  location: Node,
): boolean {
  return everyConcreteType(checker, type, (member) => {
    if (!isDrizzleWrapperType(checker, member)) {
      return false;
    }
    const metadataType = propertyType(checker, member, "_", location);
    if (metadataType === undefined) {
      return false;
    }
    const dialectType = propertyType(
      checker,
      metadataType,
      "dialect",
      location,
    );
    const selectModeType = propertyType(
      checker,
      metadataType,
      "selectMode",
      location,
    );
    return (
      dialectType?.isStringLiteral() === true &&
      dialectType.value === "pg" &&
      selectModeType !== undefined
    );
  });
}

export function isDrizzlePatternOperandType(
  checker: TypeChecker,
  type: Type,
  location: Node,
): boolean {
  return everyConcreteType(checker, type, (member) => {
    if (!isDrizzleWrapperType(checker, member)) {
      return false;
    }
    const brand = drizzleBrand(checker, member, location);
    return brand === "Column" || brand === "SQL" || brand === "SQL.Aliased";
  });
}

export function isDrizzleArrayOperandType(
  checker: TypeChecker,
  type: Type,
  location: Node,
): boolean {
  return everyConcreteType(checker, type, (member) => {
    if (!isDrizzleWrapperType(checker, member)) {
      return false;
    }
    const metadataType = propertyType(checker, member, "_", location);
    if (metadataType === undefined) {
      return false;
    }
    const brand = drizzleBrand(checker, member, location);
    const valueType =
      brand === "Column"
        ? propertyType(checker, metadataType, "data", location)
        : brand === "SQL" || brand === "SQL.Aliased"
          ? propertyType(checker, metadataType, "type", location)
          : undefined;
    return (
      valueType !== undefined &&
      (checker.isArrayType(valueType) || checker.isTupleType(valueType))
    );
  });
}
