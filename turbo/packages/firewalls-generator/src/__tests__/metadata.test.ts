import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  generatedFirewallExportName,
  loadConnectorFirewallSourceSet,
} from "../connector-firewall-sources";
import {
  BILLABLE_FIREWALL_CONNECTOR_TYPES,
  FIREWALL_CONNECTOR_TYPES,
  type FirewallConnectorType,
} from "../connector-firewall-manifest";

const FIREWALLS_DIR = path.resolve(
  import.meta.dirname,
  "../../../connectors/src/firewalls",
);
const CONNECTORS_DIR = path.resolve(
  import.meta.dirname,
  "../../../connectors/src/connectors",
);
const UNREGISTERED_GENERATED_FIREWALL_TYPES = [
  "daytona",
  "lovable",
  "modal",
] as const;
const GENERATOR_SOURCE_BOUNDARY_FILES = [
  "../metadata.ts",
  "../connector-firewall-manifest.ts",
  "../connector-firewall-sources.ts",
  "../python-builtin-firewall-catalog-composition.ts",
] as const;
const GENERATOR_RENDERER_BOUNDARY_FILES = [
  "../python-builtin-firewall-catalog.ts",
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

function manifestFirewallExportNames(): Map<FirewallConnectorType, string> {
  return new Map(
    [...FIREWALL_CONNECTOR_TYPES].sort(compareStrings).map((type) => {
      return [type, generatedFirewallExportName(type)] as const;
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
      expect(source, file).not.toContain("CONNECTOR_FIREWALLS");
      expect(source, file).not.toContain("BILLABLE_CONNECTORS");
      expect(source, file).not.toContain("firewallsIndexFile");
    }
  });

  it("keeps Python builtin firewall rendering detached from source composition", () => {
    for (const file of GENERATOR_RENDERER_BOUNDARY_FILES) {
      const source = fs.readFileSync(
        path.resolve(import.meta.dirname, file),
        "utf-8",
      );
      const specifiers = [
        ...staticValueModuleSpecifiers(source),
        ...dynamicImportSpecifiers(source),
      ];

      for (const specifier of specifiers) {
        expect(specifier, file).not.toBe("@vm0/api-contracts");
        expect(specifier, file).not.toBe("@vm0/connectors");
        expect(specifier, file).not.toBe("@vm0/connectors/firewalls/all");
        expect(specifier, file).not.toMatch(/^\.\.\/\.\.\/connectors\/src\//);
      }
      expect(source, file).not.toContain("@vm0/api-contracts");
      expect(source, file).not.toContain("@vm0/connectors");
      expect(source, file).not.toContain("@vm0/connectors/firewalls/all");
      expect(source, file).not.toMatch(/\.\.\/\.\.\/connectors\/src\//);
    }
  });

  it("loads connector sources with sorted and registry order preserved", async () => {
    const manifestTypes = [...FIREWALL_CONNECTOR_TYPES];
    const sourceSet = await loadConnectorFirewallSourceSet({
      firewallsDir: FIREWALLS_DIR,
      connectorsDir: CONNECTORS_DIR,
    });

    expect(sourceSet.sources.map((source) => source.type)).toStrictEqual(
      [...manifestTypes].sort(compareStrings),
    );
    expect(
      sourceSet.registryOrderedSources.map((source) => source.type),
    ).toStrictEqual(manifestTypes);
    expect([...sourceSet.billableTypes].sort(compareStrings)).toStrictEqual(
      [...BILLABLE_FIREWALL_CONNECTOR_TYPES].sort(compareStrings),
    );
    expect(
      sourceSet.sources.find((source) => source.type === "slack")
        ?.firewallExportName,
    ).toBe(generatedFirewallExportName("slack"));
    expect(
      sourceSet.sources.find((source) => source.type === "slack")?.label,
    ).toBe("Slack");
  });

  it("derives generated firewall export names from connector types", () => {
    const examples: readonly (readonly [FirewallConnectorType, string])[] = [
      ["google-drive", "googleDriveFirewall"],
      ["anthropic-managed-agents", "anthropicManagedAgentsFirewall"],
      ["altium-365", "altium365Firewall"],
      ["v0", "v0Firewall"],
    ];

    for (const [type, exportName] of examples) {
      expect(generatedFirewallExportName(type)).toBe(exportName);
    }
  });

  it("keeps generated-only firewall files out of the runtime manifest", () => {
    const runtimeTypes = new Set<string>(FIREWALL_CONNECTOR_TYPES);

    for (const type of UNREGISTERED_GENERATED_FIREWALL_TYPES) {
      expect(
        fs.existsSync(path.join(FIREWALLS_DIR, `${type}.generated.ts`)),
        type,
      ).toBe(true);
      expect(runtimeTypes.has(type), type).toBe(false);
    }
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
      [...FIREWALL_CONNECTOR_TYPES].sort(compareStrings),
    );
    expect(runtimeLoaderExportNames(loaderSource)).toStrictEqual(
      manifestFirewallExportNames(),
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
