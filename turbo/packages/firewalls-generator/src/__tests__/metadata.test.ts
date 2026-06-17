import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

function staticValueImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(
    /^\s*import\s+(?!type\b)[\s\S]*?\sfrom\s+["']([^"']+)["'];?/gm,
  )) {
    specifiers.push(match[1]!);
  }
  return specifiers;
}

function dynamicImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) {
    specifiers.push(match[1]!);
  }
  return specifiers;
}

describe("firewall metadata generator", () => {
  it("does not import runtime connector registries", () => {
    const source = fs.readFileSync(
      path.resolve(import.meta.dirname, "../metadata.ts"),
      "utf-8",
    );

    expect(staticValueImportSpecifiers(source)).not.toContain(
      "../../connectors/src/connectors",
    );
    expect(staticValueImportSpecifiers(source)).not.toContain(
      "../../connectors/src/firewalls",
    );
    expect(dynamicImportSpecifiers(source)).not.toContain(
      "../../connectors/src/firewalls",
    );
    expect(source).not.toContain("CONNECTOR_TYPES");
  });
});
