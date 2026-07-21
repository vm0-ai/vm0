import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { MODEL_PROVIDER_FIREWALL_CONFIGS } from "@vm0/api-contracts/contracts/model-provider-firewalls";
import { extractFirewallTemplateReferences } from "@vm0/connectors/firewall-types";
import {
  generatedFirewallExportName,
  generatedConnectorMetadataFileName,
  loadConnectorFirewallSourceSet,
  loadGeneratedConnectorFirewallSource,
  type ConnectorFirewallSource,
} from "../connector-firewall-sources";
import { getGeneratedFirewallOutput, writeOutput } from "../codegen";
import {
  BILLABLE_FIREWALL_CONNECTOR_TYPES,
  FIREWALL_CONNECTOR_TYPES,
  type FirewallConnectorType,
} from "../connector-firewall-manifest";

const CONNECTORS_DIR = path.resolve(
  import.meta.dirname,
  "../../../connectors/src/connectors",
);
const FULL_FIREWALL_SOURCE_TEST_TIMEOUT_MS = 60_000;
const DEFAULT_FIREWALL_SECRET_PLACEHOLDER =
  "c0ffee5afe10ca1c0ffee5afe10ca1c0ffee5afe";
const GENERATOR_SOURCE_BOUNDARY_FILES = [
  "../metadata.ts",
  "../lazy-loader-renderer.ts",
  "../connector-firewall-manifest.ts",
  "../connector-firewall-sources.ts",
] as const;
const ALLOWED_GENERATOR_CONNECTOR_IMPORTS = new Set([
  "@vm0/connectors/connectors",
  "@vm0/connectors/firewall-expander",
  "@vm0/connectors/firewall-metadata",
  "@vm0/connectors/firewall-metadata/routing",
  "@vm0/connectors/firewall-metadata/runner-runtime-catalog",
  "@vm0/connectors/firewall-metadata/server",
  "@vm0/connectors/firewall-types",
]);

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

function staticTypeModuleSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(
    /^\s*import\s+type\s+[\s\S]*?\sfrom\s+["']([^"']+)["'];?/gm,
  )) {
    specifiers.push(match[1]!);
  }
  for (const match of source.matchAll(
    /^\s*export\s+type(?:\s+\*|\s+\{[\s\S]*?\})\s+from\s+["']([^"']+)["'];?/gm,
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
  for (const match of source.matchAll(
    /import\(\s*["']([^"']+)["'](?:\s+as\s+string)?\s*\)/g,
  )) {
    specifiers.push(match[1]!);
  }
  return specifiers;
}

function missingPermissionDescriptions(
  source: ConnectorFirewallSource,
): string[] {
  return source.firewall.apis.flatMap((api) => {
    return (api.permissions ?? [])
      .filter((permission) => {
        return (
          permission.rules.length > 0 &&
          (permission.description?.trim() ?? "") === ""
        );
      })
      .map((permission) => {
        return permission.name;
      });
  });
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function routingMetadataFromSource(source: ConnectorFirewallSource): unknown {
  return {
    type: source.type,
    label: source.label,
    apis: source.firewall.apis.map((api) => {
      const references = extractFirewallTemplateReferences([api]);
      return {
        base: api.base,
        environmentNames: [
          ...new Set([...references.secrets, ...references.vars]),
        ].sort(compareStrings),
        routes: (api.permissions ?? []).flatMap((permission) => {
          return permission.rules.map((rule) => {
            return {
              permissionName: permission.name,
              rule,
            };
          });
        }),
      };
    }),
  };
}

function sourceHasObjectKey(source: string, key: string): boolean {
  const quotedKey = JSON.stringify(key);
  const escapedQuotedKey = quotedKey.replaceAll('"', '\\"');
  return (
    source.includes(`${quotedKey}:`) ||
    source.includes(`${escapedQuotedKey}:`) ||
    new RegExp(`^\\s*${key}:`, "m").test(source)
  );
}

function assertRoutingMetadataSourceExcludesAuthData(
  source: string,
  filename: string,
): void {
  for (const forbidden of [
    "auth",
    "headers",
    "query",
    "awsSigv4",
    "placeholders",
    "placeholderValues",
    "secretPlaceholderNames",
    "description",
  ]) {
    expect(sourceHasObjectKey(source, forbidden), filename).toBe(false);
  }
  expect(source, filename).not.toContain(DEFAULT_FIREWALL_SECRET_PLACEHOLDER);
  expect(source, filename).not.toContain("${{ secrets.");
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
        "../../connectors/src" + "/firewalls",
      );
      const specifiers = [
        ...staticValueModuleSpecifiers(source),
        ...staticTypeModuleSpecifiers(source),
      ];
      for (const specifier of specifiers) {
        if (specifier.startsWith("@vm0/connectors")) {
          expect(ALLOWED_GENERATOR_CONNECTOR_IMPORTS.has(specifier), file).toBe(
            true,
          );
          continue;
        }
        expect(specifier, file).not.toMatch(/^\.\.\/\.\.\/connectors\/src\//);
      }
      expect(dynamicImportSpecifiers(source), file).not.toContain(
        "../../connectors/src" + "/firewalls",
      );
      expect(source, file).not.toContain("@vm0/connectors/firewalls/all");
      expect(source, file).not.toMatch(/\bCONNECTOR_TYPES\b/);
      expect(source, file).not.toContain("CONNECTOR_FIREWALLS");
      expect(source, file).not.toContain("BILLABLE_CONNECTORS");
      expect(source, file).not.toContain("firewallsIndexFile");
    }
  });

  it("keeps package generator scripts aligned with the firewall manifest", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(
        path.resolve(import.meta.dirname, "../../package.json"),
        "utf-8",
      ),
    ) as { scripts: Record<string, string> };
    const manifestTypes = new Set<string>(FIREWALL_CONNECTOR_TYPES);

    for (const type of FIREWALL_CONNECTOR_TYPES) {
      expect(packageJson.scripts[`generate:${type}`]).toBe(
        `tsx src/index.ts ${type}`,
      );
    }

    const unexpectedScripts = Object.entries(packageJson.scripts)
      .filter(([name, command]) => {
        if (!name.startsWith("generate:")) {
          return false;
        }
        const target = name.slice("generate:".length);
        if (target === "metadata") {
          return command !== "tsx src/index.ts metadata";
        }
        return (
          !manifestTypes.has(target) || command !== `tsx src/index.ts ${target}`
        );
      })
      .map(([name]) => name)
      .sort(compareStrings);

    expect(unexpectedScripts).toStrictEqual([]);
  });

  it(
    "loads connector sources with sorted and registry order preserved",
    async () => {
      const manifestTypes = [...FIREWALL_CONNECTOR_TYPES];
      const sourceSet = await loadConnectorFirewallSourceSet({
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
    },
    FULL_FIREWALL_SOURCE_TEST_TIMEOUT_MS,
  );

  it(
    "keeps Sentry permission descriptions complete at the source boundary",
    async () => {
      const source = await loadGeneratedConnectorFirewallSource("sentry", {
        connectorsDir: CONNECTORS_DIR,
      });
      const missingDescriptions = source.firewall.apis.flatMap((api) => {
        return (api.permissions ?? [])
          .filter((permission) => {
            return (
              permission.rules.length > 0 && !permission.description?.trim()
            );
          })
          .map((permission) => {
            return permission.name;
          });
      });

      expect(missingDescriptions).toStrictEqual([]);
    },
    FULL_FIREWALL_SOURCE_TEST_TIMEOUT_MS,
  );

  it(
    "validates generated firewall config shape before deriving metadata",
    async () => {
      await loadGeneratedConnectorFirewallSource("github", {
        connectorsDir: CONNECTORS_DIR,
      });
      const previousSource = getGeneratedFirewallOutput("github");
      if (previousSource === null) {
        throw new Error("missing generated github firewall source");
      }

      writeOutput(
        "github",
        [
          "export const githubFirewall = {",
          '  name: "github",',
          "  apis: [",
          "    {",
          '      base: "https://api.github.com",',
          "      auth: {",
          '        header: { Authorization: "Bearer token" },',
          "      },",
          "      permissions: [],",
          "    },",
          "  ],",
          "};",
        ].join("\n"),
      );

      try {
        await expect(
          loadGeneratedConnectorFirewallSource("github", {
            connectorsDir: CONNECTORS_DIR,
          }),
        ).rejects.toThrow(
          "Generated firewall config contains unknown keys at github.apis[0].auth: header",
        );
      } finally {
        writeOutput("github", previousSource);
      }
    },
    FULL_FIREWALL_SOURCE_TEST_TIMEOUT_MS,
  );

  it(
    "rejects auth.base with SigV4 at the generated source boundary",
    async () => {
      await loadGeneratedConnectorFirewallSource("github", {
        connectorsDir: CONNECTORS_DIR,
      });
      const previousSource = getGeneratedFirewallOutput("github");
      if (previousSource === null) {
        throw new Error("missing generated github firewall source");
      }

      writeOutput(
        "github",
        [
          "export const githubFirewall = {",
          '  name: "github",',
          "  apis: [",
          "    {",
          '      base: "https://api.github.com",',
          "      auth: {",
          '        base: "https://hooks.example.com/secret",',
          "        awsSigv4: {",
          '          accessKeyId: "${{ secrets.AWS_ACCESS_KEY_ID }}",',
          '          secretAccessKey: "${{ secrets.AWS_SECRET_ACCESS_KEY }}",',
          "        },",
          "      },",
          "      permissions: [],",
          "    },",
          "  ],",
          "};",
        ].join("\n"),
      );

      try {
        await expect(
          loadGeneratedConnectorFirewallSource("github", {
            connectorsDir: CONNECTORS_DIR,
          }),
        ).rejects.toThrow("auth.base cannot be combined with auth.awsSigv4");
      } finally {
        writeOutput("github", previousSource);
      }
    },
    FULL_FIREWALL_SOURCE_TEST_TIMEOUT_MS,
  );

  it(
    "requires host policy for credentialed whole-host dynamic bases",
    async () => {
      await loadGeneratedConnectorFirewallSource("github", {
        connectorsDir: CONNECTORS_DIR,
      });
      const previousSource = getGeneratedFirewallOutput("github");
      if (previousSource === null) {
        throw new Error("missing generated github firewall source");
      }

      writeOutput(
        "github",
        [
          "export const githubFirewall = {",
          '  name: "github",',
          "  apis: [",
          "    {",
          '      base: "https://${{ vars.GITHUB_HOST }}",',
          "      auth: {",
          "        headers: {",
          '          Authorization: "Bearer ${{ secrets.GITHUB_TOKEN }}",',
          "        },",
          "      },",
          "      permissions: [],",
          "    },",
          "  ],",
          "};",
        ].join("\n"),
      );

      try {
        await expect(
          loadGeneratedConnectorFirewallSource("github", {
            connectorsDir: CONNECTORS_DIR,
          }),
        ).rejects.toThrow(
          "Credentialed dynamic base URL requires hostPolicy for github.apis[0]",
        );
      } finally {
        writeOutput("github", previousSource);
      }
    },
    FULL_FIREWALL_SOURCE_TEST_TIMEOUT_MS,
  );

  it(
    "rejects provider-owned host policies without fixed host ownership",
    async () => {
      await loadGeneratedConnectorFirewallSource("github", {
        connectorsDir: CONNECTORS_DIR,
      });
      const previousSource = getGeneratedFirewallOutput("github");
      if (previousSource === null) {
        throw new Error("missing generated github firewall source");
      }
      const invalidCases = [
        {
          hostPolicy:
            '{ kind: "providerOwned", exactHosts: [".api.github.com"] }',
          message:
            "providerOwned host policy exactHosts must be fixed hostnames with at least two labels",
        },
        {
          hostPolicy: '{ kind: "providerOwned", exactHosts: ["127.0.0.1"] }',
          message:
            "providerOwned host policy exactHosts must be fixed hostnames with at least two labels",
        },
        {
          hostPolicy: '{ kind: "providerOwned", exactHosts: ["0177.0.0.1"] }',
          message:
            "providerOwned host policy exactHosts must be fixed hostnames with at least two labels",
        },
        {
          hostPolicy: '{ kind: "providerOwned", exactHosts: ["api.例子.com"] }',
          message:
            "providerOwned host policy exactHosts must be fixed hostnames with at least two labels",
        },
        {
          hostPolicy: '{ kind: "providerOwned", suffixes: ["*.github.com"] }',
          message:
            "providerOwned host policy suffixes must be fixed hostnames with at least two labels",
        },
        {
          hostPolicy: '{ kind: "providerOwned", suffixes: ["..github.com"] }',
          message:
            "providerOwned host policy suffixes must be fixed hostnames with at least two labels",
        },
        {
          hostPolicy: '{ kind: "providerOwned", suffixes: ["com"] }',
          message:
            "providerOwned host policy suffixes must be fixed hostnames with at least two labels",
        },
      ] as const;

      try {
        for (const invalidCase of invalidCases) {
          writeOutput(
            "github",
            [
              "export const githubFirewall = {",
              '  name: "github",',
              "  apis: [",
              "    {",
              '      base: "https://${{ vars.GITHUB_HOST }}",',
              `      hostPolicy: ${invalidCase.hostPolicy},`,
              "      auth: {",
              "        headers: {",
              '          Authorization: "Bearer ${{ secrets.GITHUB_TOKEN }}",',
              "        },",
              "      },",
              "      permissions: [],",
              "    },",
              "  ],",
              "};",
            ].join("\n"),
          );

          await expect(
            loadGeneratedConnectorFirewallSource("github", {
              connectorsDir: CONNECTORS_DIR,
            }),
          ).rejects.toThrow(invalidCase.message);
        }
      } finally {
        writeOutput("github", previousSource);
      }
    },
    FULL_FIREWALL_SOURCE_TEST_TIMEOUT_MS,
  );

  it(
    "rejects generated optional metadata exports with the wrong connector prefix",
    async () => {
      await loadGeneratedConnectorFirewallSource("github", {
        connectorsDir: CONNECTORS_DIR,
      });
      const previousSource = getGeneratedFirewallOutput("github");
      if (previousSource === null) {
        throw new Error("missing generated github firewall source");
      }

      writeOutput(
        "github",
        [
          "export const githubFirewall = {",
          '  name: "github",',
          "  apis: [",
          "    {",
          '      base: "https://api.github.com",',
          "      auth: {",
          "        headers: {",
          '          Authorization: "Bearer token",',
          "        },",
          "      },",
          "      permissions: [",
          "        {",
          '          name: "repo-read",',
          '          rules: ["GET /repos/{owner}/{repo}"],',
          "        },",
          "      ],",
          "    },",
          "  ],",
          "};",
          "export const gitHubDefaultAllowed = [",
          '  "repo-read",',
          "];",
        ].join("\n"),
      );

      try {
        await expect(
          loadGeneratedConnectorFirewallSource("github", {
            connectorsDir: CONNECTORS_DIR,
          }),
        ).rejects.toThrow(
          "Unexpected DefaultAllowed export names for firewall metadata: github: gitHubDefaultAllowed; expected githubDefaultAllowed",
        );
      } finally {
        writeOutput("github", previousSource);
      }
    },
    FULL_FIREWALL_SOURCE_TEST_TIMEOUT_MS,
  );

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

  it(
    "keeps Deel permission descriptions complete at the source boundary",
    async () => {
      const source = await loadGeneratedConnectorFirewallSource("deel", {
        connectorsDir: CONNECTORS_DIR,
      });

      expect(missingPermissionDescriptions(source)).toStrictEqual([]);
    },
    FULL_FIREWALL_SOURCE_TEST_TIMEOUT_MS,
  );

  it(
    "keeps Dropbox permission descriptions complete at the source boundary",
    async () => {
      const source = await loadGeneratedConnectorFirewallSource("dropbox", {
        connectorsDir: CONNECTORS_DIR,
      });
      const permissions = new Map(
        source.firewall.apis.flatMap((api) => {
          return (api.permissions ?? []).map((permission) => {
            return [permission.name, permission] as const;
          });
        }),
      );

      expect(missingPermissionDescriptions(source)).toStrictEqual([]);
      expect(permissions.get("files.content.read")?.description).toBe(
        "Download, export, preview, and read Dropbox file content.",
      );
      expect(permissions.get("team_data.governance.write")?.description).toBe(
        "Create, update, release, and inspect Dropbox team legal hold policies and held revisions.",
      );
    },
    FULL_FIREWALL_SOURCE_TEST_TIMEOUT_MS,
  );

  it(
    "keeps PlayStation universal search aligned with psn-api",
    async () => {
      const source = await loadGeneratedConnectorFirewallSource("playstation", {
        connectorsDir: CONNECTORS_DIR,
      });
      const searchPermission = source.firewall.apis
        .flatMap((api) => {
          return api.permissions ?? [];
        })
        .find((permission) => {
          return permission.name === "playstation-search-read";
        });

      expect(searchPermission?.rules).toStrictEqual([
        "POST /api/search/v1/universalSearch",
      ]);
    },
    FULL_FIREWALL_SOURCE_TEST_TIMEOUT_MS,
  );

  it("keeps generated server metadata host-owner only", () => {
    const source = fs.readFileSync(
      path.resolve(
        import.meta.dirname,
        "../../../connectors/src/firewall-metadata/server.generated.ts",
      ),
      "utf-8",
    );

    expect(staticValueModuleSpecifiers(source)).toStrictEqual([]);
    expect(source).toContain('\\"api.github.com\\": \\"github\\"');
    expect(source).toContain('\\"{network}.g.alchemy.com\\": \\"alchemy\\"');
    expect(source).toContain('\\"slack.com\\": \\"slack\\"');
    expect(source).not.toContain("${{");
    expect(sourceHasObjectKey(source, "permissions")).toBe(false);
    expect(sourceHasObjectKey(source, "description")).toBe(false);
    expect(sourceHasObjectKey(source, "rules")).toBe(false);
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
    expect(sourceHasObjectKey(source, "baseUrlVarNames")).toBe(true);
    expect(sourceHasObjectKey(source, "baseUrlTemplates")).toBe(true);
    expect(sourceHasObjectKey(source, "secretPlaceholderNames")).toBe(true);
    expect(sourceHasObjectKey(source, "placeholderValues")).toBe(true);
    expect(sourceHasObjectKey(source, "permissions")).toBe(false);
    expect(sourceHasObjectKey(source, "description")).toBe(false);
    expect(sourceHasObjectKey(source, "rules")).toBe(false);
  });

  it("keeps the generated metadata loader literal and nullable", () => {
    const loaderSource = fs.readFileSync(
      path.resolve(
        import.meta.dirname,
        "../../../connectors/src/firewall-metadata/permission-detail-loader.generated.ts",
      ),
      "utf-8",
    );
    const dynamicSpecifiers = dynamicImportSpecifiers(loaderSource);

    expect(staticValueModuleSpecifiers(loaderSource)).toStrictEqual([]);
    expect(dynamicSpecifiers).toContain("./permission-details/slack.generated");
    expect(dynamicSpecifiers).toContain(
      "./permission-details/github.generated",
    );
    expect(loaderSource).toContain("/firewall-metadata/permission-details/v1/");
    expect(loaderSource).toContain(
      "const FIREWALL_PERMISSION_METADATA_LOADERS",
    );
    expect(loaderSource).toContain("Object.create(null)");
    expect(loaderSource).toContain(
      "export async function loadGeneratedFirewallPermissionMetadata",
    );
    expect(loaderSource).toContain("return null;");
    expect(loaderSource).toContain("return await load();");
    expect(new Set(dynamicSpecifiers).size).toBe(dynamicSpecifiers.length);
    expect(dynamicSpecifiers.length).toBe(FIREWALL_CONNECTOR_TYPES.length);
    for (const specifier of dynamicSpecifiers) {
      expect(specifier).toMatch(
        /^\.\/permission-details\/[a-z0-9][a-z0-9-]*\.generated$/,
      );
    }
  });

  it("does not keep the generated runtime loader", () => {
    expect(
      fs.existsSync(
        path.resolve(
          import.meta.dirname,
          "../../../connectors/src",
          "firewalls/runtime-loader.generated.ts",
        ),
      ),
    ).toBe(false);
  });

  it("keeps generated routing index eager and base-only", () => {
    const source = fs.readFileSync(
      path.resolve(
        import.meta.dirname,
        "../../../connectors/src/firewall-metadata/routing-index.generated.ts",
      ),
      "utf-8",
    );

    expect(staticValueModuleSpecifiers(source)).toStrictEqual([]);
    expect(dynamicImportSpecifiers(source)).toStrictEqual([]);
    expect(source).toContain("FIREWALL_ROUTING_METADATA_INDEX");
    expect(source).toContain('"slack"');
    expect(source).toContain('"google-cloud"');
    expect(source).toContain('"stripe"');
    expect(source).toContain('"daytona"');
    expect(source).toContain('"modal"');
    expect(sourceHasObjectKey(source, "base")).toBe(true);
    expect(sourceHasObjectKey(source, "environmentNames")).toBe(false);
    expect(sourceHasObjectKey(source, "routes")).toBe(false);
    expect(sourceHasObjectKey(source, "permissionName")).toBe(false);
    expect(sourceHasObjectKey(source, "rule")).toBe(false);
    expect(sourceHasObjectKey(source, "permissions")).toBe(false);
    expect(sourceHasObjectKey(source, "rules")).toBe(false);
    assertRoutingMetadataSourceExcludesAuthData(
      source,
      "routing-index.generated.ts",
    );
  });

  it("keeps generated routing details lazy and route-only", () => {
    const loaderSource = fs.readFileSync(
      path.resolve(
        import.meta.dirname,
        "../../../connectors/src/firewall-metadata/routing-loader.generated.ts",
      ),
      "utf-8",
    );
    const slackDetailSource = fs.readFileSync(
      path.resolve(
        import.meta.dirname,
        "../../../connectors/src/firewall-metadata/routing-details/slack.generated.ts",
      ),
      "utf-8",
    );
    const dynamicSpecifiers = dynamicImportSpecifiers(loaderSource);

    expect(staticValueModuleSpecifiers(loaderSource)).toStrictEqual([]);
    expect(dynamicSpecifiers).toContain("./routing-details/slack.generated");
    expect(dynamicSpecifiers).toContain("./routing-details/github.generated");
    expect(dynamicSpecifiers.length).toBe(FIREWALL_CONNECTOR_TYPES.length);
    expect(new Set(dynamicSpecifiers).size).toBe(dynamicSpecifiers.length);
    for (const specifier of dynamicSpecifiers) {
      expect(specifier).toMatch(
        /^\.\/routing-details\/[a-z0-9][a-z0-9-]*\.generated$/,
      );
    }
    expect(loaderSource).toContain("FIREWALL_ROUTING_METADATA_LOADERS");
    expect(loaderSource).toContain("Object.create(null)");
    expect(loaderSource).toContain(
      "export async function loadGeneratedFirewallRoutingMetadata",
    );
    expect(loaderSource).not.toContain("loadAll");

    expect(staticValueModuleSpecifiers(slackDetailSource)).toStrictEqual([]);
    expect(dynamicImportSpecifiers(slackDetailSource)).toStrictEqual([]);
    expect(slackDetailSource).toContain("firewallRoutingMetadata");
    expect(slackDetailSource).toContain("JSON.parse");
    expect(slackDetailSource).toContain(
      "firewallRoutingMetadataValue as FirewallRoutingMetadata",
    );
    expect(sourceHasObjectKey(slackDetailSource, "environmentNames")).toBe(
      true,
    );
    expect(slackDetailSource).toContain('\\"base\\"');
    expect(slackDetailSource).toContain('\\"routes\\"');
    expect(slackDetailSource).toContain('\\"permissionName\\"');
    expect(slackDetailSource).toContain('\\"rule\\"');
    expect(slackDetailSource).not.toContain('\\"permissions\\"');
    expect(slackDetailSource).not.toContain('\\"rules\\"');
    assertRoutingMetadataSourceExcludesAuthData(
      slackDetailSource,
      "routing-details/slack.generated.ts",
    );
  });

  it(
    "projects all routing details from connector firewall route data",
    async () => {
      const sourceSet = await loadConnectorFirewallSourceSet({
        connectorsDir: CONNECTORS_DIR,
      });

      for (const source of sourceSet.sources) {
        const filename = `routing-details/${generatedConnectorMetadataFileName(source.type)}`;
        const detailSource = fs.readFileSync(
          path.resolve(
            import.meta.dirname,
            "../../../connectors/src/firewall-metadata",
            filename,
          ),
          "utf-8",
        );
        expect(detailSource, filename).toContain(
          `const firewallRoutingMetadataJson = ${JSON.stringify(stableJson(routingMetadataFromSource(source)))};`,
        );
        expect(detailSource, filename).toContain(
          "export const firewallRoutingMetadata = firewallRoutingMetadataValue as FirewallRoutingMetadata;",
        );
        assertRoutingMetadataSourceExcludesAuthData(detailSource, filename);
      }
    },
    FULL_FIREWALL_SOURCE_TEST_TIMEOUT_MS,
  );

  it(
    "projects runner runtime firewalls from connector and model provider data",
    async () => {
      const sourceSet = await loadConnectorFirewallSourceSet({
        connectorsDir: CONNECTORS_DIR,
      });
      const loaderSource = fs.readFileSync(
        path.resolve(
          import.meta.dirname,
          "../../../connectors/src/firewall-metadata/runner-runtime-loader.generated.ts",
        ),
        "utf-8",
      );
      const dynamicSpecifiers = dynamicImportSpecifiers(loaderSource);

      expect(dynamicSpecifiers.length).toBe(
        sourceSet.sources.length +
          Object.keys(MODEL_PROVIDER_FIREWALL_CONFIGS).length,
      );
      expect(dynamicSpecifiers).toContain(
        "./runner-runtime-details/github.generated",
      );
      expect(dynamicSpecifiers).toContainEqual(
        expect.stringMatching(
          /^\.\/runner-runtime-details\/model-provider-openai-api-key-[a-f0-9]{12}\.generated$/,
        ),
      );
      expect(loaderSource).toContain('["model-provider:openai-api-key"]');
      expect(loaderSource).toContain("RUNNER_RUNTIME_FIREWALL_CATALOG_DIGEST");
      expect(loaderSource).toContain("RUNNER_RUNTIME_FIREWALL_NAMES");
      expect(loaderSource).toContain(
        "export const RUNNER_RUNTIME_FIREWALL_NAMES = Object.freeze(",
      );

      const googleDriveRuntimeSource = fs.readFileSync(
        path.resolve(
          import.meta.dirname,
          "../../../connectors/src/firewall-metadata/runner-runtime-details/google-drive.generated.ts",
        ),
        "utf-8",
      );
      expect(googleDriveRuntimeSource).toContain(
        '\\"name\\": \\"google-drive\\"',
      );
      expect(googleDriveRuntimeSource).not.toContain('\\"description\\"');
      expect(googleDriveRuntimeSource).not.toContain("placeholders");
      expect(googleDriveRuntimeSource).not.toContain("defaultPolicies");
    },
    FULL_FIREWALL_SOURCE_TEST_TIMEOUT_MS,
  );
});
