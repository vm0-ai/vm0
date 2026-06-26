import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function parseSource(source: string): ts.SourceFile {
  return ts.createSourceFile(
    "source.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function stringLiteralText(node: ts.Node | undefined): string | null {
  if (
    node === undefined ||
    (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node))
  ) {
    return null;
  }

  return node.text;
}

function importDeclarationHasValue(statement: ts.ImportDeclaration): boolean {
  const clause = statement.importClause;
  if (clause === undefined) {
    return true;
  }
  if (clause.isTypeOnly || clause.name !== undefined) {
    return !clause.isTypeOnly;
  }

  const namedBindings = clause.namedBindings;
  if (namedBindings === undefined || ts.isNamespaceImport(namedBindings)) {
    return true;
  }

  return (
    namedBindings.elements.length === 0 ||
    namedBindings.elements.some((element) => {
      return !element.isTypeOnly;
    })
  );
}

function exportDeclarationHasValue(statement: ts.ExportDeclaration): boolean {
  if (statement.isTypeOnly) {
    return false;
  }

  const exportClause = statement.exportClause;
  if (exportClause === undefined || ts.isNamespaceExport(exportClause)) {
    return true;
  }

  return (
    exportClause.elements.length === 0 ||
    exportClause.elements.some((element) => {
      return !element.isTypeOnly;
    })
  );
}

function staticModuleSpecifiers(
  source: string,
  options: { includeTypeOnly: boolean },
): string[] {
  const specifiers: string[] = [];
  for (const statement of parseSource(source).statements) {
    if (ts.isImportDeclaration(statement)) {
      if (!options.includeTypeOnly && !importDeclarationHasValue(statement)) {
        continue;
      }
      const specifier = stringLiteralText(statement.moduleSpecifier);
      if (specifier !== null) {
        specifiers.push(specifier);
      }
    }
    if (ts.isExportDeclaration(statement)) {
      if (!options.includeTypeOnly && !exportDeclarationHasValue(statement)) {
        continue;
      }
      const specifier = stringLiteralText(statement.moduleSpecifier);
      if (specifier !== null) {
        specifiers.push(specifier);
      }
    }
  }
  return specifiers;
}

function staticValueModuleSpecifiers(source: string): string[] {
  return staticModuleSpecifiers(source, { includeTypeOnly: false });
}

function callModuleSpecifiers(
  source: string,
  predicate: (expression: ts.Expression) => boolean,
): string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && predicate(node.expression)) {
      const specifier = stringLiteralText(node.arguments[0]);
      if (specifier !== null) {
        specifiers.push(specifier);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parseSource(source));
  return specifiers;
}

function dynamicImportSpecifiers(source: string): string[] {
  return callModuleSpecifiers(source, (expression) => {
    return expression.kind === ts.SyntaxKind.ImportKeyword;
  });
}

function requireSpecifiers(source: string): string[] {
  return callModuleSpecifiers(source, (expression) => {
    return ts.isIdentifier(expression) && expression.text === "require";
  });
}

function importTypeSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const specifier = stringLiteralText(node.argument.literal);
      if (specifier !== null) {
        specifiers.push(specifier);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parseSource(source));
  return specifiers;
}

function moduleSpecifiers(source: string): string[] {
  return [
    ...staticModuleSpecifiers(source, { includeTypeOnly: true }),
    ...importTypeSpecifiers(source),
    ...dynamicImportSpecifiers(source),
    ...requireSpecifiers(source),
  ];
}

function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) {
    return false;
  }
  return (
    ts.getModifiers(node)?.some((modifier) => {
      return modifier.kind === ts.SyntaxKind.ExportKeyword;
    }) ?? false
  );
}

function exportedIdentifierNames(source: string): string[] {
  const names: string[] = [];
  for (const statement of parseSource(source).statements) {
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (clause !== undefined && ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          names.push(element.name.text);
        }
      }
      continue;
    }

    if (ts.isFunctionDeclaration(statement) && hasExportModifier(statement)) {
      if (statement.name !== undefined) {
        names.push(statement.name.text);
      }
      continue;
    }

    if (
      (ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)) &&
      hasExportModifier(statement)
    ) {
      names.push(statement.name.text);
      continue;
    }

    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          names.push(declaration.name.text);
        }
      }
    }
  }
  return names;
}

function expectNoGeneratedRuntimeImports(source: string): void {
  for (const specifier of moduleSpecifiers(source)) {
    expect(specifier).not.toMatch(
      /^\.{1,2}\/(?:[^/]+\/)*[a-z0-9][a-z0-9-]*\.generated$/,
    );
  }
}

function isEagerRegistryIndexSpecifier(
  sourceFilePath: string,
  specifier: string,
): boolean {
  if (
    /^@vm0\/connectors\/firewalls(?:\/(?:index(?:\.(?:d\.)?[cm]?[jt]sx?)?)?)?$/.test(
      specifier,
    )
  ) {
    return true;
  }

  if (!specifier.startsWith(".")) {
    return false;
  }

  const firewallsDir = path.resolve(import.meta.dirname, "../firewalls");
  const resolvedSpecifier = path.resolve(
    path.dirname(sourceFilePath),
    specifier,
  );
  const relativeSpecifier = path.relative(firewallsDir, resolvedSpecifier);
  return (
    relativeSpecifier === "" ||
    /^index(?:\.(?:d\.)?[cm]?[jt]sx?)?$/.test(relativeSpecifier)
  );
}

function generatedFirewallSourceFiles(): string[] {
  const firewallsDir = path.resolve(import.meta.dirname, "../firewalls");
  return fs
    .readdirSync(firewallsDir)
    .filter((fileName) => {
      return (
        fileName.endsWith(".generated.ts") &&
        fileName !== "runtime-loader.generated.ts"
      );
    })
    .map((fileName) => {
      return path.join(firewallsDir, fileName);
    })
    .sort(compareStrings);
}

describe("firewall runtime surface", () => {
  it("does not expose the runtime loader package subpath", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(
        path.resolve(import.meta.dirname, "../../package.json"),
        "utf-8",
      ),
    ) as { exports: Record<string, unknown> };
    const rootEntrypoint = fs.readFileSync(
      path.resolve(import.meta.dirname, "../index.ts"),
      "utf-8",
    );

    expect(packageJson.exports).not.toHaveProperty("./firewalls/runtime");
    expect(rootEntrypoint).not.toContain("firewalls/runtime");
    expect(
      fs.existsSync(
        path.resolve(import.meta.dirname, "../firewall-runtime.ts"),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.resolve(
          import.meta.dirname,
          "../firewalls/runtime-loader.generated.ts",
        ),
      ),
    ).toBe(false);
  });

  it("does not expose a firewall selection resolver package subpath", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(
        path.resolve(import.meta.dirname, "../../package.json"),
        "utf-8",
      ),
    ) as { exports: Record<string, unknown> };
    const rootEntrypoint = fs.readFileSync(
      path.resolve(import.meta.dirname, "../index.ts"),
      "utf-8",
    );

    expect(packageJson.exports).not.toHaveProperty(
      "./firewalls/selection-resolver",
    );
    expect(moduleSpecifiers(rootEntrypoint)).not.toContain(
      "./firewalls/selection-resolver",
    );
  });

  it("keeps runtime firewalls out of the package root entrypoint", () => {
    const rootEntrypoint = fs.readFileSync(
      path.resolve(import.meta.dirname, "../index.ts"),
      "utf-8",
    );
    const rootSpecifiers = moduleSpecifiers(rootEntrypoint);

    for (const specifier of rootSpecifiers) {
      expect(specifier).not.toMatch(/^\.\/firewalls(?:\/|$)/);
    }
  });

  it("keeps firewall expander independent from runtime catalog loaders", () => {
    const expanderSource = fs.readFileSync(
      path.resolve(import.meta.dirname, "../firewall-expander.ts"),
      "utf-8",
    );

    expect(dynamicImportSpecifiers(expanderSource)).toStrictEqual([]);
    for (const specifier of moduleSpecifiers(expanderSource)) {
      expect(specifier).not.toMatch(/^\.{1,2}\/firewalls(?:\/|$)/);
      expect(specifier).not.toBe("./firewall-runtime");
    }
    expectNoGeneratedRuntimeImports(expanderSource);
  });

  it("keeps root contract entrypoints from exporting firewall selection APIs", () => {
    const apiContractsRoot = fs.readFileSync(
      path.resolve(
        import.meta.dirname,
        "../../../api-contracts/src/contracts/index.ts",
      ),
      "utf-8",
    );
    const coreRoot = fs.readFileSync(
      path.resolve(import.meta.dirname, "../../../core/src/index.ts"),
      "utf-8",
    );

    for (const exportedName of [
      "resolveFirewallSelections",
      "resolveFirewallConfigSelection",
      "FirewallSelection",
    ]) {
      expect(apiContractsRoot).not.toContain(exportedName);
      expect(coreRoot).not.toContain(exportedName);
    }
  });

  it("blocks eager all-catalog package access", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(
        path.resolve(import.meta.dirname, "../../package.json"),
        "utf-8",
      ),
    ) as { exports: Record<string, unknown> };
    const rootEntrypoint = fs.readFileSync(
      path.resolve(import.meta.dirname, "../index.ts"),
      "utf-8",
    );

    expect(packageJson.exports["./firewalls"]).toBeNull();
    expect(packageJson.exports).not.toHaveProperty("./firewalls/all");
    expect(packageJson.exports["./firewalls/*"]).toBeNull();
    expect(exportedIdentifierNames(rootEntrypoint)).not.toContain(
      "getAllConnectorFirewalls",
    );
    expect(staticValueModuleSpecifiers(rootEntrypoint)).not.toContain(
      "./firewall-runtime-all",
    );
    expect(staticValueModuleSpecifiers(rootEntrypoint)).not.toContain(
      "./firewalls/all",
    );
  });

  it("does not keep an eager runtime entrypoint", () => {
    expect(
      fs.existsSync(path.resolve(import.meta.dirname, "../firewalls/index.ts")),
    ).toBe(false);
  });

  it("keeps generated firewall configs independent from the eager registry index", () => {
    const offenders: string[] = [];
    const generatedFiles = generatedFirewallSourceFiles();

    expect(generatedFiles.length).toBeGreaterThan(0);
    for (const filePath of generatedFiles) {
      const source = fs.readFileSync(filePath, "utf-8");
      const eagerIndexSpecifiers = moduleSpecifiers(source).filter(
        (specifier) => {
          return isEagerRegistryIndexSpecifier(filePath, specifier);
        },
      );
      if (eagerIndexSpecifiers.length > 0) {
        offenders.push(
          `${path.basename(filePath)}: ${eagerIndexSpecifiers.join(", ")}`,
        );
      }
    }

    expect(offenders).toStrictEqual([]);
  });

  it("does not statically import the eager registry or connector runtime modules", () => {
    const helperSource = fs.readFileSync(
      path.resolve(import.meta.dirname, "../firewall-placeholder-expansion.ts"),
      "utf-8",
    );

    expect(
      staticValueModuleSpecifiers(helperSource).sort(compareStrings),
    ).toStrictEqual(["./connector-utils"]);

    expect(helperSource).not.toContain("./index");
    expect(helperSource).not.toContain("@vm0/connectors/firewalls");
    expectNoGeneratedRuntimeImports(helperSource);
  });

  it("does not keep the removed selection resolver source file", () => {
    expect(
      fs.existsSync(
        path.resolve(import.meta.dirname, "../firewall-selection-resolver.ts"),
      ),
    ).toBe(false);
  });

  it("keeps firewall expander limited to validation helpers", () => {
    const expanderSource = fs.readFileSync(
      path.resolve(import.meta.dirname, "../firewall-expander.ts"),
      "utf-8",
    );

    expect(
      exportedIdentifierNames(expanderSource).sort(compareStrings),
    ).toEqual(["collectAndValidatePermissions", "validateRule"]);
  });

  it("keeps generated runtime loader artifacts removed", () => {
    expect(
      fs.existsSync(
        path.resolve(
          import.meta.dirname,
          "../firewalls/runtime-loader.generated.ts",
        ),
      ),
    ).toBe(false);
  });
});
