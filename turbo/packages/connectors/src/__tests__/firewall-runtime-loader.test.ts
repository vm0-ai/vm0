import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

import { FIREWALL_PERMISSION_METADATA_SUMMARIES } from "../firewall-metadata";
import {
  isRuntimeFirewallConnectorType,
  loadConnectorFirewall,
  loadConnectorFirewalls,
  RUNTIME_FIREWALL_CONNECTOR_TYPES,
} from "../firewall-runtime";

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

function moduleSpecifiers(source: string): string[] {
  return [
    ...staticModuleSpecifiers(source, { includeTypeOnly: true }),
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

function exportedIdentifierNamesFromModule(
  source: string,
  moduleSpecifier: string,
): string[] {
  const names: string[] = [];
  for (const statement of parseSource(source).statements) {
    if (!ts.isExportDeclaration(statement)) {
      continue;
    }

    if (stringLiteralText(statement.moduleSpecifier) !== moduleSpecifier) {
      continue;
    }

    const clause = statement.exportClause;
    if (clause === undefined || ts.isNamespaceExport(clause)) {
      names.push("*");
      continue;
    }

    for (const element of clause.elements) {
      names.push(element.name.text);
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

describe("firewall runtime loader", () => {
  it("keeps the runtime loader behind an explicit package subpath", () => {
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

    expect(packageJson.exports["./firewalls/runtime"]).toStrictEqual({
      import: "./src/firewall-runtime.ts",
      types: "./src/firewall-runtime.ts",
    });
    expect(rootEntrypoint).not.toContain("firewalls/runtime");
  });

  it("keeps selection resolution behind an explicit runtime package subpath", () => {
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

    expect(packageJson.exports["./firewalls/selection-resolver"]).toStrictEqual(
      {
        import: "./src/firewall-selection-resolver.ts",
        types: "./src/firewall-selection-resolver.ts",
      },
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

  it("keeps root contract entrypoints from exporting runtime selection resolution", () => {
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

    expect(apiContractsRoot).not.toContain("resolveFirewallSelections");
    expect(coreRoot).not.toContain("resolveFirewallSelections");
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

  it("keeps metadata category helpers out of the eager runtime entrypoint", () => {
    const defaultEntrypointSource = fs.readFileSync(
      path.resolve(import.meta.dirname, "../firewalls/index.ts"),
      "utf-8",
    );
    const removedExports = [
      "ConnectorCategories",
      "CONNECTOR_CATEGORIES",
      "getBuiltinConnectorDisplayName",
      "getPermissionCategories",
      "groupPermissionsByCategory",
      "PermissionGroup",
    ];

    expect(
      exportedIdentifierNames(defaultEntrypointSource).filter((name) => {
        return removedExports.includes(name);
      }),
    ).toStrictEqual([]);
    expect(
      exportedIdentifierNamesFromModule(
        defaultEntrypointSource,
        "../firewall-metadata",
      ).sort(compareStrings),
    ).toStrictEqual(
      [
        "FirewallPermissionGrant",
        "FirewallPermissionGrantAction",
        "permissionGrantsToFirewallPolicies",
      ].sort(compareStrings),
    );
  });

  it("does not statically import the eager registry or connector runtime modules", () => {
    const runtimeSource = fs.readFileSync(
      path.resolve(import.meta.dirname, "../firewall-runtime.ts"),
      "utf-8",
    );
    const helperSource = fs.readFileSync(
      path.resolve(import.meta.dirname, "../firewall-placeholder-expansion.ts"),
      "utf-8",
    );

    expect(
      staticValueModuleSpecifiers(runtimeSource).sort(compareStrings),
    ).toStrictEqual(["./firewalls/runtime-loader.generated"]);
    expect(dynamicImportSpecifiers(runtimeSource)).toStrictEqual([
      "./firewall-placeholder-expansion",
    ]);
    expect(
      staticValueModuleSpecifiers(helperSource).sort(compareStrings),
    ).toStrictEqual(["./connector-utils"]);

    for (const source of [runtimeSource, helperSource]) {
      expect(source).not.toContain("./index");
      expect(source).not.toContain("@vm0/connectors/firewalls");
    }
    expectNoGeneratedRuntimeImports(helperSource);
  });

  it("keeps selection resolver on the lazy runtime boundary", () => {
    const resolverSource = fs.readFileSync(
      path.resolve(import.meta.dirname, "../firewall-selection-resolver.ts"),
      "utf-8",
    );

    expect(
      staticValueModuleSpecifiers(resolverSource).sort(compareStrings),
    ).toStrictEqual(["./firewall-expander", "./firewall-runtime"]);
    expect(dynamicImportSpecifiers(resolverSource)).toStrictEqual([]);
    for (const specifier of moduleSpecifiers(resolverSource)) {
      expect(specifier).not.toBe(".");
      expect(specifier).not.toBe("./index");
      expect(specifier).not.toMatch(/^\.{1,2}\/firewalls(?:\/|$)/);
      expect(specifier).not.toBe("@vm0/connectors/firewalls");
      expect(specifier).not.toBe("@vm0/connectors/firewalls/all");
    }
    expectNoGeneratedRuntimeImports(resolverSource);
  });

  it("uses literal dynamic imports in the generated runtime loader", () => {
    const loaderSource = fs.readFileSync(
      path.resolve(
        import.meta.dirname,
        "../firewalls/runtime-loader.generated.ts",
      ),
      "utf-8",
    );
    const dynamicSpecifiers = dynamicImportSpecifiers(loaderSource);

    expect(staticValueModuleSpecifiers(loaderSource)).toStrictEqual([]);
    expect(dynamicSpecifiers).toContain("./slack.generated");
    expect(dynamicSpecifiers).toContain("./github.generated");
    expect(new Set(dynamicSpecifiers).size).toBe(dynamicSpecifiers.length);
    for (const specifier of dynamicSpecifiers) {
      expect(specifier).toMatch(/^\.\/[a-z0-9][a-z0-9-]*\.generated$/);
    }
  });

  it("keeps the runtime manifest synchronized with generated metadata summaries", () => {
    expect(
      [...RUNTIME_FIREWALL_CONNECTOR_TYPES].sort(compareStrings),
    ).toStrictEqual(
      Object.keys(FIREWALL_PERMISSION_METADATA_SUMMARIES).sort(compareStrings),
    );
  });

  it("loads and caches expanded connector firewalls", async () => {
    expect(isRuntimeFirewallConnectorType("slack")).toBe(true);
    expect(isRuntimeFirewallConnectorType("cloudinary")).toBe(false);
    await expect(loadConnectorFirewall("cloudinary")).resolves.toBeNull();

    const [firstSlack, secondSlack] = await Promise.all([
      loadConnectorFirewall("slack"),
      loadConnectorFirewall("slack"),
    ]);
    expect(firstSlack).toBe(secondSlack);
    expect(firstSlack).not.toBeNull();
    expect(firstSlack!.name).toBe("slack");
    expect(firstSlack!.apis.length).toBeGreaterThan(0);

    const repeatedSlack = await loadConnectorFirewall("slack");
    expect(repeatedSlack).toBe(firstSlack);
  });

  it("deduplicates batch loads and preserves connector keys", async () => {
    const firewalls = await loadConnectorFirewalls([
      "github",
      "slack",
      "github",
      "cloudinary",
    ]);

    expect(Object.keys(firewalls).sort(compareStrings)).toStrictEqual([
      "github",
      "slack",
    ]);
    expect(firewalls.github?.name).toBe("github");
    expect(firewalls.slack).toBe(await loadConnectorFirewall("slack"));
  });
});
