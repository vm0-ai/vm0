import {
  AST_NODE_TYPES,
  type ParserServicesWithTypeInformation,
  type TSESTree,
} from "@typescript-eslint/utils";
import {
  SymbolFlags,
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

export function isDrizzleColumnType(
  checker: TypeChecker,
  type: Type,
  location: Node,
): boolean {
  if (type.isUnion()) {
    return type.types.every((member) => {
      return isDrizzleColumnType(checker, member, location);
    });
  }
  if (!isDrizzleWrapperType(checker, type)) {
    return false;
  }
  const metadataType = propertyType(checker, type, "_", location);
  if (metadataType === undefined) {
    return false;
  }
  const brandType = propertyType(checker, metadataType, "brand", location);
  return brandType?.isStringLiteral() === true && brandType.value === "Column";
}
