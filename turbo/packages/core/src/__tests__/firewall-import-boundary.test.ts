import { describe, expect, it } from "vitest";

import packageJson from "../../package.json";

function staticValueImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(
    /^\s*import\s+(?!type\b)[\s\S]*?\sfrom\s+["']([^"']+)["'];?/gm,
  )) {
    const specifier = match[1];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }
  for (const match of source.matchAll(/^\s*import\s+["']([^"']+)["'];?/gm)) {
    const specifier = match[1];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

function staticValueExportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(
    /^\s*export(?:\s+\*|\s+\{[\s\S]*?\})\s+from\s+["']([^"']+)["'];?/gm,
  )) {
    const specifier = match[1];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

function staticValueModuleSpecifiers(source: string): string[] {
  return [
    ...staticValueImportSpecifiers(source),
    ...staticValueExportSpecifiers(source),
  ];
}

describe("core firewall import boundary", () => {
  it("keeps runtime firewalls out of the package root entrypoint", async () => {
    const { default: rootEntrypoint } = await import("../index.ts?raw");

    expect(staticValueModuleSpecifiers(rootEntrypoint)).not.toContain(
      "./firewalls",
    );
    expect(rootEntrypoint).not.toContain("@vm0/connectors/firewalls");
  });

  it("does not expose the core firewall alias subpath", () => {
    expect(packageJson.exports).not.toHaveProperty("./firewalls");
  });
});
