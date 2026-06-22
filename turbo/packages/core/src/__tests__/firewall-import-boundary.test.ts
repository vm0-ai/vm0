/// <reference types="node" />

import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

import packageJson from "../../package.json";

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

function moduleSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = stringLiteralText(node.moduleSpecifier);
      if (specifier !== null) {
        specifiers.push(specifier);
      }
    }
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const isModuleCall =
        expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(expression) && expression.text === "require");
      if (isModuleCall) {
        const specifier = stringLiteralText(node.arguments[0]);
        if (specifier !== null) {
          specifiers.push(specifier);
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(parseSource(source));
  return specifiers;
}

describe("core firewall import boundary", () => {
  it("keeps runtime firewalls out of the package root source", () => {
    const rootEntrypoint = fs.readFileSync(
      path.resolve(import.meta.dirname, "../index.ts"),
      "utf-8",
    );

    for (const specifier of moduleSpecifiers(rootEntrypoint)) {
      expect(specifier).not.toMatch(/^\.\/firewalls(?:\/|$)/);
      expect(specifier).not.toMatch(/^@vm0\/connectors\/firewalls(?:\/|$)/);
    }
  });

  it("does not expose the core firewall alias subpath or source file", () => {
    expect(packageJson.exports).not.toHaveProperty("./firewalls");
    expect(
      fs.existsSync(path.resolve(import.meta.dirname, "../firewalls.ts")),
    ).toBe(false);
    expect(
      fs.existsSync(path.resolve(import.meta.dirname, "../firewalls/index.ts")),
    ).toBe(false);
  });
});
