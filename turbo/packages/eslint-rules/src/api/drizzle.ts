import {
  AST_NODE_TYPES,
  type ParserServicesWithTypeInformation,
  type TSESTree,
} from "@typescript-eslint/utils";
import {
  SymbolFlags,
  TypeFlags,
  type Declaration,
  type Node,
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

export interface DrizzleTableColumnMetadata {
  readonly databaseName: string;
  readonly hasDefault: boolean;
  readonly isWritable: boolean;
  readonly propertyName: string;
  readonly propertySymbol: TypeScriptSymbol;
  readonly tableName: string;
}

export interface DrizzleTableMetadata {
  readonly columns: ReadonlyMap<string, DrizzleTableColumnMetadata>;
  readonly name: string;
  readonly schema: string | undefined;
}

interface DrizzleColumnMetadata {
  readonly databaseName: string;
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
  return databaseName === undefined ||
    tableName === undefined ||
    hasDefault === undefined
    ? undefined
    : { databaseName, hasDefault, tableName };
}

function sameColumnMetadata(
  left: DrizzleColumnMetadata & { readonly hasDefault: boolean },
  right: DrizzleColumnMetadata & { readonly hasDefault: boolean },
): boolean {
  return (
    left.databaseName === right.databaseName &&
    left.hasDefault === right.hasDefault &&
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
  return { columns, name, schema: schema ?? undefined };
}

function sameTableMetadata(
  left: DrizzleTableMetadata,
  right: DrizzleTableMetadata,
): boolean {
  if (
    left.name !== right.name ||
    left.schema !== right.schema ||
    left.columns.size !== right.columns.size
  ) {
    return false;
  }
  for (const [databaseName, column] of left.columns) {
    const other = right.columns.get(databaseName);
    if (
      other === undefined ||
      column.hasDefault !== other.hasDefault ||
      column.isWritable !== other.isWritable ||
      column.propertyName !== other.propertyName ||
      column.tableName !== other.tableName
    ) {
      return false;
    }
  }
  return true;
}

export function getDrizzleTableMetadata(
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
