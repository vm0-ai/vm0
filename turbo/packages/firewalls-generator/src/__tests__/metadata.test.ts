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
  for (const match of source.matchAll(/^\s*import\s+["']([^"']+)["'];?/gm)) {
    specifiers.push(match[1]!);
  }
  return specifiers;
}

function staticValueExportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(
    /^\s*export(?:\s+\*|\s+\{[\s\S]*?\})\s+from\s+["']([^"']+)["'];?/gm,
  )) {
    specifiers.push(match[1]!);
  }
  return specifiers;
}

function staticValueModuleSpecifiers(source: string): string[] {
  return [
    ...staticValueImportSpecifiers(source),
    ...staticValueExportSpecifiers(source),
  ];
}

function dynamicImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) {
    specifiers.push(match[1]!);
  }
  return specifiers;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function firewallRegistryConnectorTypes(source: string): string[] {
  return [...firewallRegistryExportNames(source).keys()].sort(compareStrings);
}

function firewallRegistryExportNames(source: string): Map<string, string> {
  const registryMatch = source.match(
    /const CONNECTOR_FIREWALLS = defineConnectorFirewalls\(\{\n([\s\S]*?)\n\} satisfies/s,
  );
  if (!registryMatch) {
    throw new Error("Unable to find CONNECTOR_FIREWALLS registry");
  }

  return new Map(
    [
      ...registryMatch[1]!.matchAll(
        /^\s*(?:"([^"]+)"|([a-zA-Z_$][\w$]*)):\s*([a-zA-Z_$][\w$]*),$/gm,
      ),
    ].map((match) => {
      return [match[1] ?? match[2]!, match[3]!] as const;
    }),
  );
}

function runtimeLoaderConnectorTypes(source: string): string[] {
  const manifestMatch = source.match(
    /export const RUNTIME_FIREWALL_CONNECTOR_TYPES = \[\n([\s\S]*?)\n\] as const;/s,
  );
  if (!manifestMatch) {
    throw new Error("Unable to find runtime firewall connector manifest");
  }

  return [...manifestMatch[1]!.matchAll(/^\s*"([^"]+)",$/gm)]
    .map((match) => {
      return match[1]!;
    })
    .sort(compareStrings);
}

function runtimeLoaderExportNames(source: string): Map<string, string> {
  return new Map(
    [
      ...source.matchAll(
        /^\s*"([^"]+)": async \(\) => \{\n\s+return \(await import\("[^"]+"\)\)\.([a-zA-Z_$][\w$]*);\n\s+\},$/gm,
      ),
    ].map((match) => {
      return [match[1]!, match[2]!] as const;
    }),
  );
}

describe("firewall metadata generator", () => {
  it("does not import runtime connector registries", () => {
    const source = fs.readFileSync(
      path.resolve(import.meta.dirname, "../metadata.ts"),
      "utf-8",
    );

    expect(staticValueModuleSpecifiers(source)).not.toContain(
      "../../connectors/src/connectors",
    );
    expect(staticValueModuleSpecifiers(source)).not.toContain(
      "../../connectors/src/firewalls",
    );
    for (const specifier of staticValueModuleSpecifiers(source)) {
      expect(specifier).not.toMatch(/^\.\.\/\.\.\/connectors\/src\//);
    }
    expect(dynamicImportSpecifiers(source)).not.toContain(
      "../../connectors/src/firewalls",
    );
    expect(source).not.toMatch(/\bCONNECTOR_TYPES\b/);
  });

  it("keeps generated server metadata host-owner only", () => {
    const source = fs.readFileSync(
      path.resolve(
        import.meta.dirname,
        "../../../connectors/src/firewall-metadata/server.generated.ts",
      ),
      "utf-8",
    );

    expect(staticValueModuleSpecifiers(source)).toStrictEqual([]);
    expect(source).toContain('"api.github.com": "github"');
    expect(source).toContain('"{network}.g.alchemy.com": "alchemy"');
    expect(source).toContain('"slack.com": "slack"');
    expect(source).not.toContain("${{");
    expect(source).not.toContain('"permissions"');
    expect(source).not.toContain('"description"');
    expect(source).not.toContain('"rules"');
  });

  it("keeps the generated runtime loader literal and registry-shaped", () => {
    const registrySource = fs.readFileSync(
      path.resolve(
        import.meta.dirname,
        "../../../connectors/src/firewalls/index.ts",
      ),
      "utf-8",
    );
    const loaderSource = fs.readFileSync(
      path.resolve(
        import.meta.dirname,
        "../../../connectors/src/firewalls/runtime-loader.generated.ts",
      ),
      "utf-8",
    );
    const dynamicSpecifiers = dynamicImportSpecifiers(loaderSource);

    expect(staticValueModuleSpecifiers(loaderSource)).toStrictEqual([]);
    expect(runtimeLoaderConnectorTypes(loaderSource)).toStrictEqual(
      firewallRegistryConnectorTypes(registrySource),
    );
    expect(runtimeLoaderExportNames(loaderSource)).toStrictEqual(
      firewallRegistryExportNames(registrySource),
    );
    expect(dynamicSpecifiers).toContain("./slack.generated");
    expect(dynamicSpecifiers).toContain("./github.generated");
    expect(new Set(dynamicSpecifiers).size).toBe(dynamicSpecifiers.length);
    expect(dynamicSpecifiers.length).toBe(
      runtimeLoaderConnectorTypes(loaderSource).length,
    );
    for (const specifier of dynamicSpecifiers) {
      expect(specifier).toMatch(/^\.\/[a-z0-9][a-z0-9-]*\.generated$/);
    }
    expect(loaderSource).toContain('"slack": async () =>');
    expect(loaderSource).toContain(")).slackFirewall");
  });
});
