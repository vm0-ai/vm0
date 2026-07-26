import {
  AST_NODE_TYPES,
  type ParserServicesWithTypeInformation,
  type TSESTree,
} from "@typescript-eslint/utils";
import {
  isImportDeclaration,
  isImportSpecifier,
  isNamespaceImport,
  isStringLiteral,
  type Node,
  type TypeChecker,
} from "typescript";

function importSource(node: Node): string | undefined {
  let current: Node | undefined = node;
  while (current !== undefined && !isImportDeclaration(current)) {
    current = current.parent;
  }
  return current !== undefined && isStringLiteral(current.moduleSpecifier)
    ? current.moduleSpecifier.text.replaceAll("\\", "/")
    : undefined;
}

function isRawRowsModule(source: string | undefined): boolean {
  return (
    source !== undefined &&
    /^(?:\.\.?\/)+lib\/db-raw-rows(?:\.[cm]?[jt]s)?$/.test(source)
  );
}

function memberName(node: TSESTree.MemberExpression): string | undefined {
  if (!node.computed && node.property.type === AST_NODE_TYPES.Identifier) {
    return node.property.name;
  }
  if (
    node.computed &&
    node.property.type === AST_NODE_TYPES.Literal &&
    typeof node.property.value === "string"
  ) {
    return node.property.value;
  }
  return undefined;
}

export function createExecuteRawRowsMatcher(
  program: TSESTree.Program,
  checker: TypeChecker,
  services: ParserServicesWithTypeInformation,
): (node: TSESTree.Expression) => boolean {
  const directBindings = new Set<string>();
  const namespaces = new Set<string>();

  for (const statement of program.body) {
    if (
      statement.type !== AST_NODE_TYPES.ImportDeclaration ||
      typeof statement.source.value !== "string" ||
      !isRawRowsModule(statement.source.value)
    ) {
      continue;
    }
    for (const specifier of statement.specifiers) {
      if (
        specifier.type === AST_NODE_TYPES.ImportSpecifier &&
        ((specifier.imported.type === AST_NODE_TYPES.Identifier &&
          specifier.imported.name === "executeRawRows") ||
          (specifier.imported.type === AST_NODE_TYPES.Literal &&
            specifier.imported.value === "executeRawRows"))
      ) {
        directBindings.add(specifier.local.name);
      } else if (specifier.type === AST_NODE_TYPES.ImportNamespaceSpecifier) {
        namespaces.add(specifier.local.name);
      }
    }
  }

  return (node: TSESTree.Expression): boolean => {
    if (node.type === AST_NODE_TYPES.Identifier) {
      if (!directBindings.has(node.name)) {
        return false;
      }
      const tsNode = services.esTreeNodeToTSNodeMap.get(node);
      return (
        checker
          .getSymbolAtLocation(tsNode)
          ?.declarations?.some((declaration) => {
            return (
              isImportSpecifier(declaration) &&
              (declaration.propertyName?.text ?? declaration.name.text) ===
                "executeRawRows" &&
              isRawRowsModule(importSource(declaration))
            );
          }) === true
      );
    }

    if (
      node.type !== AST_NODE_TYPES.MemberExpression ||
      memberName(node) !== "executeRawRows" ||
      node.object.type !== AST_NODE_TYPES.Identifier ||
      !namespaces.has(node.object.name)
    ) {
      return false;
    }
    const tsObject = services.esTreeNodeToTSNodeMap.get(node.object);
    return (
      checker
        .getSymbolAtLocation(tsObject)
        ?.declarations?.some((declaration) => {
          return (
            isNamespaceImport(declaration) &&
            isRawRowsModule(importSource(declaration))
          );
        }) === true
    );
  };
}
