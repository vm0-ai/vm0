import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { loadConnectorFirewallSourceSet } from "../connector-firewall-sources";

const FIREWALLS_DIR = path.resolve(
  import.meta.dirname,
  "../../../connectors/src/firewalls",
);
const CONNECTORS_DIR = path.resolve(
  import.meta.dirname,
  "../../../connectors/src/connectors",
);
const FIREWALLS_INDEX_FILE = path.join(FIREWALLS_DIR, "index.ts");
const GENERATOR_SOURCE_BOUNDARY_FILES = [
  "../metadata.ts",
  "../connector-firewall-sources.ts",
] as const;

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

function billableConnectorTypes(source: string): string[] {
  const registryMatch = source.match(
    /export const BILLABLE_CONNECTORS = \[\n([\s\S]*?)\n\] as const satisfies/s,
  );
  if (!registryMatch) {
    throw new Error("Unable to find BILLABLE_CONNECTORS registry");
  }

  return [...registryMatch[1]!.matchAll(/^\s*"([^"]+)",$/gm)]
    .map((match) => {
      return match[1]!;
    })
    .sort(compareStrings);
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
    for (const file of GENERATOR_SOURCE_BOUNDARY_FILES) {
      const source = fs.readFileSync(
        path.resolve(import.meta.dirname, file),
        "utf-8",
      );

      expect(staticValueModuleSpecifiers(source), file).not.toContain(
        "../../connectors/src/connectors",
      );
      expect(staticValueModuleSpecifiers(source), file).not.toContain(
        "../../connectors/src/firewalls",
      );
      for (const specifier of staticValueModuleSpecifiers(source)) {
        expect(specifier, file).not.toMatch(/^\.\.\/\.\.\/connectors\/src\//);
      }
      expect(dynamicImportSpecifiers(source), file).not.toContain(
        "../../connectors/src/firewalls",
      );
      expect(source, file).not.toContain("@vm0/connectors/firewalls/all");
      expect(source, file).not.toMatch(/\bCONNECTOR_TYPES\b/);
    }
  });

  it("loads connector sources with sorted and registry order preserved", async () => {
    const registrySource = fs.readFileSync(FIREWALLS_INDEX_FILE, "utf-8");
    const registryExportNames = firewallRegistryExportNames(registrySource);
    const registryTypes = [...registryExportNames.keys()];
    const sourceSet = await loadConnectorFirewallSourceSet({
      firewallsDir: FIREWALLS_DIR,
      connectorsDir: CONNECTORS_DIR,
      firewallsIndexFile: FIREWALLS_INDEX_FILE,
    });

    expect(sourceSet.sources.map((source) => source.type)).toStrictEqual(
      [...registryTypes].sort(compareStrings),
    );
    expect(
      sourceSet.registryOrderedSources.map((source) => source.type),
    ).toStrictEqual(registryTypes);
    expect([...sourceSet.billableTypes].sort(compareStrings)).toStrictEqual(
      billableConnectorTypes(registrySource),
    );
    expect(
      sourceSet.sources.find((source) => source.type === "slack")
        ?.firewallExportName,
    ).toBe(registryExportNames.get("slack"));
    expect(
      sourceSet.sources.find((source) => source.type === "slack")?.label,
    ).toBe("Slack");
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

  it("keeps generated server execution metadata eager and server-shaped", () => {
    const source = fs.readFileSync(
      path.resolve(
        import.meta.dirname,
        "../../../connectors/src/firewall-metadata/server-execution.generated.ts",
      ),
      "utf-8",
    );

    expect(staticValueModuleSpecifiers(source)).toStrictEqual([]);
    expect(dynamicImportSpecifiers(source)).toStrictEqual([]);
    expect(source).toContain("FIREWALL_SERVER_EXECUTION_METADATA");
    expect(source).toContain('"baseUrlVarNames"');
    expect(source).toContain('"baseUrlTemplates"');
    expect(source).toContain('"secretPlaceholderNames"');
    expect(source).toContain('"placeholderValues"');
    expect(source).not.toContain('"permissions":');
    expect(source).not.toContain('"description"');
    expect(source).not.toContain('"rules"');
  });

  it("keeps the generated runtime loader literal and registry-shaped", () => {
    const registrySource = fs.readFileSync(FIREWALLS_INDEX_FILE, "utf-8");
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
