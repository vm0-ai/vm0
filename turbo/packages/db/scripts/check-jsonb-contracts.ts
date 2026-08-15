#!/usr/bin/env tsx

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.join(dirname, "..");
const schemaDir = path.join(packageDir, "src/schema");
const contractImportPrefixes = [
  "../jsonb-contracts/",
  "@okouai/db/jsonb-contracts/",
];

interface Violation {
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

function schemaFiles(dir: string): readonly string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...schemaFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

function moduleSpecifierText(node: ts.ImportDeclaration): string | undefined {
  if (!ts.isStringLiteral(node.moduleSpecifier)) {
    return undefined;
  }
  return node.moduleSpecifier.text;
}

function importedContractTypeNames(
  sourceFile: ts.SourceFile,
): ReadonlySet<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    const moduleSpecifier = moduleSpecifierText(statement);
    if (
      !moduleSpecifier ||
      !contractImportPrefixes.some((prefix) => {
        return moduleSpecifier.startsWith(prefix);
      })
    ) {
      continue;
    }
    const importClause = statement.importClause;
    const namedBindings = importClause?.namedBindings;
    if (!namedBindings || !ts.isNamedImports(namedBindings)) {
      continue;
    }
    for (const element of namedBindings.elements) {
      if (importClause.isTypeOnly || element.isTypeOnly) {
        names.add(element.name.text);
      }
    }
  }
  return names;
}

function isJsonbCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "jsonb"
  );
}

function parentContinuesChain(
  node: ts.Expression,
): ts.CallExpression | ts.PropertyAccessExpression | undefined {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
    return parent;
  }
  if (ts.isCallExpression(parent) && parent.expression === node) {
    return parent;
  }
  return undefined;
}

function chainRoot(node: ts.CallExpression): ts.Expression {
  let current: ts.Expression = node;
  let parent = parentContinuesChain(current);
  while (parent) {
    current = parent;
    parent = parentContinuesChain(current);
  }
  return current;
}

function typeCallFromChain(root: ts.Node): ts.CallExpression | undefined {
  let found: ts.CallExpression | undefined;
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "$type"
    ) {
      found = node;
    }
    ts.forEachChild(node, visit);
  }
  visit(root);
  return found;
}

function namedTypeArgument(node: ts.TypeNode): string | undefined {
  if (!ts.isTypeReferenceNode(node) || !ts.isIdentifier(node.typeName)) {
    return undefined;
  }
  return node.typeName.text;
}

function location(
  sourceFile: ts.SourceFile,
  node: ts.Node,
): Pick<Violation, "line" | "column"> {
  const position = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile),
  );
  return { line: position.line + 1, column: position.character + 1 };
}

function violation(
  sourceFile: ts.SourceFile,
  node: ts.Node,
  message: string,
): Violation {
  const relativePath = path.relative(packageDir, sourceFile.fileName);
  return { filePath: relativePath, ...location(sourceFile, node), message };
}

function fileViolations(filePath: string): readonly Violation[] {
  const sourceText = fs.readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const contractTypes = importedContractTypeNames(sourceFile);
  const violations: Violation[] = [];

  function visit(node: ts.Node): void {
    if (!isJsonbCall(node)) {
      ts.forEachChild(node, visit);
      return;
    }

    const root = chainRoot(node);
    const typeCall = typeCallFromChain(root);
    if (!typeCall) {
      violations.push(
        violation(
          sourceFile,
          node,
          "jsonb field must call .$type<ContractType>() with a type imported from src/jsonb-contracts/.",
        ),
      );
      return;
    }

    const [typeArgument] = typeCall.typeArguments ?? [];
    if (!typeArgument) {
      violations.push(
        violation(
          sourceFile,
          typeCall,
          "jsonb .$type call must provide a named contract type argument.",
        ),
      );
      return;
    }

    const typeName = namedTypeArgument(typeArgument);
    if (!typeName) {
      violations.push(
        violation(
          sourceFile,
          typeArgument,
          "jsonb .$type argument must be a named type imported from src/jsonb-contracts/, not an inline type.",
        ),
      );
      return;
    }

    if (!contractTypes.has(typeName)) {
      violations.push(
        violation(
          sourceFile,
          typeArgument,
          `jsonb contract type ${typeName} must be imported with import type from src/jsonb-contracts/.`,
        ),
      );
    }
  }

  visit(sourceFile);
  return violations;
}

const violations = schemaFiles(schemaDir).flatMap((filePath) => {
  return [...fileViolations(filePath)];
});

if (violations.length > 0) {
  console.error("Persistent JSONB contract lint failed.");
  console.error("");
  console.error(
    "Every Drizzle jsonb field must use a named type from src/jsonb-contracts/.",
  );
  console.error(
    "When that directory changes, review production compatibility, read-time normalization, data migration, and legacy fixture coverage.",
  );
  console.error("");
  for (const item of violations) {
    console.error(
      `${item.filePath}:${item.line}:${item.column} - ${item.message}`,
    );
  }
  process.exit(1);
}

console.log("JSONB contract lint passed.");
