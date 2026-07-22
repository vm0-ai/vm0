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
