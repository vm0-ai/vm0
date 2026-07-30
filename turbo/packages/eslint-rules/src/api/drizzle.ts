import {
  AST_NODE_TYPES,
  type ParserServicesWithTypeInformation,
  type TSESTree,
} from "@typescript-eslint/utils";
import {
  ElementFlags,
  IndexKind,
  isAsExpression,
  isCallExpression,
  isIdentifier,
  isNonNullExpression,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSatisfiesExpression,
  isTypeAssertionExpression,
  isVariableDeclaration,
  isVariableDeclarationList,
  NodeFlags,
  SymbolFlags,
  TypeFlags,
  type Declaration,
  type Node,
  type Signature,
  type Symbol as TypeScriptSymbol,
  type Type,
  type TypeChecker,
  type TupleTypeReference,
} from "typescript";

function drizzleDeclarationSourcePath(node: Declaration): string {
  return node.getSourceFile().fileName.replaceAll("\\", "/");
}

export function isDrizzleDeclaration(node: Declaration): boolean {
  return drizzleDeclarationSourcePath(node).includes(
    "/node_modules/drizzle-orm/",
  );
}

export function isDrizzlePgCoreDeclaration(node: Declaration): boolean {
  return drizzleDeclarationSourcePath(node).includes(
    "/node_modules/drizzle-orm/pg-core/",
  );
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

function drizzleExpressionName(
  checker: TypeChecker,
  node: Node,
  visited: Set<TypeScriptSymbol>,
): string | undefined {
  const expression = unwrapTransparentExpression(node);
  if (isIdentifier(expression)) {
    const symbol = resolvedSymbol(
      checker,
      checker.getSymbolAtLocation(expression),
    );
    if (symbol === undefined || visited.has(symbol)) {
      return undefined;
    }
    if (isDrizzleSymbol(checker, symbol)) {
      return symbol.getName();
    }
    const declaration = symbol.valueDeclaration;
    if (
      declaration === undefined ||
      !isVariableDeclaration(declaration) ||
      !isVariableDeclarationList(declaration.parent) ||
      (declaration.parent.flags & NodeFlags.Const) === 0 ||
      declaration.initializer === undefined
    ) {
      return undefined;
    }
    visited.add(symbol);
    const name = drizzleExpressionName(
      checker,
      declaration.initializer,
      visited,
    );
    visited.delete(symbol);
    return name;
  }
  if (isPropertyAccessExpression(expression)) {
    const symbol = resolvedSymbol(
      checker,
      checker.getSymbolAtLocation(expression.name),
    );
    return symbol !== undefined && isDrizzleSymbol(checker, symbol)
      ? symbol.getName()
      : undefined;
  }
  return undefined;
}

export function drizzleCallName(
  checker: TypeChecker,
  node: Node,
): string | undefined {
  const expression = unwrapTransparentExpression(node);
  if (!isCallExpression(expression)) {
    return undefined;
  }
  const declaration = checker.getResolvedSignature(expression)?.declaration;
  if (declaration === undefined || !isDrizzleDeclaration(declaration)) {
    return undefined;
  }
  return drizzleExpressionName(checker, expression.expression, new Set());
}

interface DrizzleTableDeclaration {
  readonly hasSimpleColumnOrder: boolean;
}

// Write-query linting recognizes normal pgTable(...) and schema.table(...)
// declarations. Runtime column order is assumed only for inline object literals
// with identifier-keyed property assignments; other declarations simply skip
// findings that depend on that order.
function drizzleTableDeclaration(
  checker: TypeChecker,
  node: Node,
  visited: Set<TypeScriptSymbol>,
): DrizzleTableDeclaration | undefined {
  const expression = unwrapTransparentExpression(node);
  if (isCallExpression(expression)) {
    const callName = drizzleExpressionName(
      checker,
      expression.expression,
      new Set(),
    );
    const columns = expression.arguments[1];
    if (
      (callName !== "pgTable" && callName !== "table") ||
      columns === undefined
    ) {
      return undefined;
    }
    const definition = unwrapTransparentExpression(columns);
    return {
      hasSimpleColumnOrder:
        isObjectLiteralExpression(definition) &&
        definition.properties.every((property) => {
          return isPropertyAssignment(property) && isIdentifier(property.name);
        }),
    };
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
    symbol.valueDeclaration === undefined
  ) {
    return undefined;
  }
  const declaration = symbol.valueDeclaration;
  if (
    !isVariableDeclaration(declaration) ||
    !isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & NodeFlags.Const) === 0 ||
    declaration.initializer === undefined
  ) {
    return undefined;
  }
  visited.add(symbol);
  const table = drizzleTableDeclaration(
    checker,
    declaration.initializer,
    visited,
  );
  visited.delete(symbol);
  return table;
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

function collectConstrainedTypeMembers(
  checker: TypeChecker,
  type: Type,
  visited: Set<Type>,
): Type[] | null {
  if ((type.flags & TypeFlags.TypeParameter) !== 0) {
    if (visited.has(type)) {
      return null;
    }
    visited.add(type);
    const constraint = checker.getBaseConstraintOfType(type);
    const members =
      constraint === undefined
        ? null
        : collectConstrainedTypeMembers(checker, constraint, visited);
    visited.delete(type);
    return members;
  }
  if (!type.isUnion()) {
    return [type];
  }
  const members: Type[] = [];
  for (const member of type.types) {
    const constrainedMembers = collectConstrainedTypeMembers(
      checker,
      member,
      visited,
    );
    if (constrainedMembers === null) {
      return null;
    }
    members.push(...constrainedMembers);
  }
  return members;
}

export function constrainedTypeMembers(
  checker: TypeChecker,
  type: Type,
): Type[] | null {
  return collectConstrainedTypeMembers(checker, type, new Set<Type>());
}

function isOptionalDrizzleWrapperType(
  checker: TypeChecker,
  type: Type,
): boolean {
  const members = constrainedTypeMembers(checker, type);
  return (
    members !== null &&
    members.every((member) => {
      return (
        (member.flags & (TypeFlags.Undefined | TypeFlags.Void)) !== 0 ||
        isDrizzleWrapperType(checker, member)
      );
    })
  );
}

function isTupleTypeReference(
  checker: TypeChecker,
  type: Type,
): type is TupleTypeReference {
  return checker.isTupleType(type);
}

function definitelyPresentSpreadCondition(
  checker: TypeChecker,
  type: Type,
): boolean | null {
  const members = constrainedTypeMembers(checker, type);
  if (members === null) {
    return null;
  }
  let everyMemberIsPresent = true;
  for (const member of members) {
    const elementType = checker.getIndexTypeOfType(member, IndexKind.Number);
    if (
      elementType === undefined ||
      !isOptionalDrizzleWrapperType(checker, elementType)
    ) {
      return null;
    }
    everyMemberIsPresent &&=
      isTupleTypeReference(checker, member) &&
      checker.getTypeArguments(member).some((element, index) => {
        return (
          ((member.target.elementFlags[index] ?? 0) & ElementFlags.Required) !==
            0 && isDrizzleWrapperType(checker, element)
        );
      });
  }
  return everyMemberIsPresent;
}

export function isDefinitelyPresentDrizzleBooleanHelper(
  checker: TypeChecker,
  services: ParserServicesWithTypeInformation,
  expression: TSESTree.Expression,
): boolean {
  if (expression.type !== AST_NODE_TYPES.CallExpression) {
    return false;
  }
  const tsExpression = services.esTreeNodeToTSNodeMap.get(expression);
  if (!isCallExpression(tsExpression)) {
    return false;
  }
  const signature = checker.getResolvedSignature(tsExpression);
  if (
    signature === undefined ||
    (!isNamedDrizzleSignature(signature, "and") &&
      !isNamedDrizzleSignature(signature, "or"))
  ) {
    return false;
  }
  let hasPresentCondition = false;
  for (const argument of expression.arguments) {
    if (argument.type === AST_NODE_TYPES.SpreadElement) {
      const tsArgument = services.esTreeNodeToTSNodeMap.get(argument.argument);
      const spreadPresence = definitelyPresentSpreadCondition(
        checker,
        checker.getTypeAtLocation(tsArgument),
      );
      if (spreadPresence === null) {
        return false;
      }
      hasPresentCondition ||= spreadPresence;
      continue;
    }
    const tsArgument = services.esTreeNodeToTSNodeMap.get(argument);
    const type = checker.getTypeAtLocation(tsArgument);
    if (!isOptionalDrizzleWrapperType(checker, type)) {
      return false;
    }
    if (
      isDrizzleWrapperType(checker, type) ||
      isDefinitelyPresentDrizzleBooleanHelper(checker, services, argument)
    ) {
      hasPresentCondition = true;
    }
  }
  return hasPresentCondition;
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
  readonly hasDirectDeclaration: boolean;
  readonly hasSimpleColumnOrder: boolean;
  readonly name: string;
  readonly schema: string | undefined;
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

function drizzleColumnMetadata(
  checker: TypeChecker,
  type: Type,
  location: Node,
): (DrizzleColumnMetadata & { readonly hasDefault: boolean }) | undefined {
  if (type.isUnion()) {
    return undefined;
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
  const columns = new Map<string, DrizzleTableColumnMetadata>();
  for (const property of columnProperties) {
    const propertyName = property.getName();
    const directProperty = checker.getPropertyOfType(type, propertyName);
    const column = drizzleColumnMetadata(
      checker,
      checker.getTypeOfSymbolAtLocation(property, location),
      location,
    );
    if (directProperty === undefined || column === undefined) {
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
    hasDirectDeclaration: false,
    hasSimpleColumnOrder: false,
    name,
    schema: schema ?? undefined,
  };
}

function getDrizzleTableMetadata(
  checker: TypeChecker,
  type: Type,
  location: Node,
): DrizzleTableMetadata | undefined {
  if (type.isUnion()) {
    return undefined;
  }
  if ((type.flags & TypeFlags.TypeParameter) !== 0) {
    const constraint = checker.getBaseConstraintOfType(type);
    return constraint === undefined
      ? undefined
      : getDrizzleTableMetadata(checker, constraint, location);
  }
  return concreteDrizzleTableMetadata(checker, type, location);
}

export function getDrizzleTableMetadataForWrite(
  checker: TypeChecker,
  node: Node,
): DrizzleTableMetadata | undefined {
  const metadata = getDrizzleTableMetadata(
    checker,
    checker.getTypeAtLocation(node),
    node,
  );
  if (metadata === undefined) {
    return undefined;
  }
  const declaration = drizzleTableDeclaration(checker, node, new Set());
  return declaration === undefined
    ? metadata
    : {
        ...metadata,
        hasDirectDeclaration: true,
        hasSimpleColumnOrder: declaration.hasSimpleColumnOrder,
      };
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
