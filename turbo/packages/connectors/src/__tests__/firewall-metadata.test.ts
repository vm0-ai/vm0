import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { CONNECTOR_TYPES, type ConnectorType } from "../connectors";
import {
  createFirewallMetadataPolicyResolver,
  expandFirewallMetadataDefaultPolicy,
  FIREWALL_PERMISSION_METADATA_SUMMARIES,
  getFirewallPermissionSummary,
  groupFirewallMetadataPermissionsByCategory,
  isFirewallMetadataConnectorType,
  loadFirewallPermissionMetadata,
  permissionGrantsToFirewallPolicies,
  resolveFirewallMetadataPolicies,
} from "../firewall-metadata";
import type {
  FirewallPermissionDetailMetadata,
  FirewallPermissionMetadataPermission,
} from "../firewall-metadata";
import {
  UNKNOWN_PERMISSION_GRANT,
  extractBaseUrlVarNames,
  extractSecretNamesFromApis,
  firewallAuthInjectsCredentials,
  hasBaseUrlVars,
  type FirewallConfig,
} from "../firewall-types";
import {
  getBuiltinConnectorHostOwner,
  getFirewallExecutionMetadata,
  getFirewallServerMetadataSummary,
  isFirewallExecutionMetadataConnectorType,
  isFirewallServerMetadataConnectorType,
  loadFirewallPermissionIndex,
  resolveFirewallServerMetadataPolicies,
} from "../firewall-metadata/server";
import {
  BILLABLE_CONNECTORS,
  getAllBuiltinConnectorHosts,
  getAllConnectorFirewalls,
  getDefaultFirewallPolicies,
  getPermissionCategories,
  groupPermissionsByCategory,
  resolveFirewallPolicies,
  type FirewallConnectorType,
} from "../firewalls";

const FORBIDDEN_METADATA_KEYS = new Set([
  "auth",
  "base",
  "placeholders",
  "rules",
]);
const FORBIDDEN_EXECUTION_METADATA_KEYS = new Set([
  "apis",
  "auth",
  "permissions",
  "rules",
]);
const DEFAULT_FIREWALL_SECRET_PLACEHOLDER =
  "c0ffee5afe10ca1c0ffee5afe10ca1c0ffee5afe";

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isConnectorType(type: string): type is ConnectorType {
  return Object.prototype.hasOwnProperty.call(CONNECTOR_TYPES, type);
}

function connectorLabel(type: FirewallConnectorType): string {
  if (!isConnectorType(type)) {
    throw new Error(
      `Firewall connector is missing connector metadata: ${type}`,
    );
  }
  return CONNECTOR_TYPES[type].label;
}

function collectRuntimePermissions(
  firewall: FirewallConfig,
): FirewallPermissionMetadataPermission[] {
  const permissions = new Map<string, FirewallPermissionMetadataPermission>();
  for (const api of firewall.apis) {
    for (const permission of api.permissions ?? []) {
      if (!permissions.has(permission.name)) {
        permissions.set(permission.name, {
          name: permission.name,
          ...(permission.description !== undefined
            ? { description: permission.description }
            : {}),
        });
      }
    }
  }
  return [...permissions.values()].sort((a, b) => {
    return compareStrings(a.name, b.name);
  });
}

function collectRuntimeBaseUrlTemplates(
  firewall: FirewallConfig,
): readonly { readonly base: string; readonly credentialed: boolean }[] {
  const templates = new Map<string, boolean>();
  for (const api of firewall.apis) {
    if (!hasBaseUrlVars(api.base)) {
      continue;
    }
    templates.set(
      api.base,
      (templates.get(api.base) ?? false) ||
        firewallAuthInjectsCredentials(api.auth),
    );
  }
  return [...templates.entries()]
    .sort(([a], [b]) => {
      return compareStrings(a, b);
    })
    .map(([base, credentialed]) => {
      return { base, credentialed };
    });
}

function collectRuntimePlaceholderValues(
  firewall: FirewallConfig,
): Record<string, string> {
  const placeholders: Record<string, string> = {};
  for (const name of extractSecretNamesFromApis(firewall.apis)) {
    placeholders[name] =
      firewall.placeholders?.[name] ?? DEFAULT_FIREWALL_SECRET_PLACEHOLDER;
  }
  for (const [name, value] of Object.entries(firewall.placeholders ?? {})) {
    placeholders[name] = value;
  }
  return Object.fromEntries(
    Object.entries(placeholders).sort(([a], [b]) => {
      return compareStrings(a, b);
    }),
  );
}

function listTsFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...listTsFiles(entryPath));
    } else if (entry.name.endsWith(".ts")) {
      result.push(entryPath);
    }
  }
  return result;
}

function importSpecifiers(source: string): string[] {
  return [
    ...staticImportSpecifiers(source),
    ...exportFromSpecifiers(source),
    ...dynamicImportSpecifiers(source),
  ];
}

function staticImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(
    /^\s*import(?:\s+type)?[\s\S]*?\sfrom\s+["']([^"']+)["'];?/gm,
  )) {
    specifiers.push(match[1]!);
  }
  for (const match of source.matchAll(/^\s*import\s+["']([^"']+)["'];?/gm)) {
    specifiers.push(match[1]!);
  }
  return specifiers;
}

function exportFromSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(
    /^\s*export(?:\s+type)?(?:\s+\*|\s+\{[\s\S]*?\})\s+from\s+["']([^"']+)["'];?/gm,
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

function assertNoForbiddenMetadataKeys(value: unknown, location: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertNoForbiddenMetadataKeys(item, `${location}[${index}]`);
    });
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  if (location.endsWith(".categories.categories")) {
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_METADATA_KEYS.has(key)) {
      throw new Error(`metadata contains runtime key "${key}" at ${location}`);
    }
    assertNoForbiddenMetadataKeys(nested, `${location}.${key}`);
  }
}

function assertNoForbiddenExecutionMetadataKeys(
  value: unknown,
  location: string,
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertNoForbiddenExecutionMetadataKeys(item, `${location}[${index}]`);
    });
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_EXECUTION_METADATA_KEYS.has(key)) {
      throw new Error(
        `execution metadata contains runtime key "${key}" at ${location}`,
      );
    }
    assertNoForbiddenExecutionMetadataKeys(nested, `${location}.${key}`);
  }
}

function runtimeEntries(): [FirewallConnectorType, FirewallConfig][] {
  return Object.entries(getAllConnectorFirewalls()).sort(([a], [b]) => {
    return compareStrings(a, b);
  }) as [FirewallConnectorType, FirewallConfig][];
}

const RESOLVER_METADATA = {
  type: "slack",
  label: "Slack",
  permissionCount: 4,
  permissions: [
    { name: "metadata-default-one" },
    { name: "metadata-default-two" },
    { name: "metadata-deny" },
    { name: "metadata-ask" },
  ],
  defaultPolicy: {
    permissionDefault: "allow",
    permissionOverrides: {
      deny: ["metadata-deny"],
      ask: ["metadata-ask"],
    },
    unknownPolicy: "deny",
  },
} satisfies FirewallPermissionDetailMetadata;

describe("firewall metadata", () => {
  it("keeps the public entrypoint off detail modules", () => {
    const entrypoint = path.resolve(
      import.meta.dirname,
      "../firewall-metadata/index.ts",
    );
    const source = fs.readFileSync(entrypoint, "utf-8");

    expect(staticImportSpecifiers(source).sort(compareStrings)).toStrictEqual([
      "../firewall-types",
      "./loader.generated",
      "./policy-resolver",
      "./summary.generated",
      "./types",
    ]);
    expect(exportFromSpecifiers(source).sort(compareStrings)).toStrictEqual([
      "./policy-resolver",
      "./types",
    ]);
    expect(dynamicImportSpecifiers(source)).toStrictEqual([]);
  });

  it("keeps server metadata behind an explicit package subpath", () => {
    const rootEntrypoint = fs.readFileSync(
      path.resolve(import.meta.dirname, "../index.ts"),
      "utf-8",
    );
    const packageJson = JSON.parse(
      fs.readFileSync(
        path.resolve(import.meta.dirname, "../../package.json"),
        "utf-8",
      ),
    ) as { exports: Record<string, unknown> };

    expect(rootEntrypoint).not.toContain("firewall-metadata/server");
    expect(packageJson.exports).toHaveProperty("./firewall-metadata/server");
  });

  it("keeps execution metadata behind the server metadata package subpath", () => {
    const rootEntrypoint = fs.readFileSync(
      path.resolve(import.meta.dirname, "../index.ts"),
      "utf-8",
    );
    const publicMetadataEntrypoint = fs.readFileSync(
      path.resolve(import.meta.dirname, "../firewall-metadata/index.ts"),
      "utf-8",
    );
    const serverMetadataEntrypoint = fs.readFileSync(
      path.resolve(import.meta.dirname, "../firewall-metadata/server.ts"),
      "utf-8",
    );
    const packageJson = JSON.parse(
      fs.readFileSync(
        path.resolve(import.meta.dirname, "../../package.json"),
        "utf-8",
      ),
    ) as { exports: Record<string, unknown> };

    expect(rootEntrypoint).not.toContain("firewall-execution-metadata/server");
    expect(rootEntrypoint).not.toContain("server-execution.generated");
    expect(publicMetadataEntrypoint).not.toContain(
      "server-execution.generated",
    );
    expect(serverMetadataEntrypoint).toContain("./server-execution.generated");
    expect(packageJson.exports).not.toHaveProperty(
      "./firewall-execution-metadata/server",
    );
    expect(packageJson.exports).toHaveProperty("./firewall-metadata/server");
  });

  it("resolves metadata permission defaults and overrides", () => {
    const resolver = createFirewallMetadataPolicyResolver(RESOLVER_METADATA);

    expect(resolver.permission("metadata-default-one")).toBe("allow");
    expect(resolver.permission("metadata-deny")).toBe("deny");
    expect(resolver.permission("metadata-ask")).toBe("ask");
    expect(resolver.permission("not-in-metadata")).toBe("allow");
    expect(resolver.unknown()).toBe("deny");
  });

  it("applies sparse overlay precedence", () => {
    const resolver = createFirewallMetadataPolicyResolver(RESOLVER_METADATA, {
      permissionDefault: "deny",
      permissionOverrides: {
        "metadata-deny": "allow",
        "metadata-ask": "ask",
      },
      unknownPolicy: "ask",
    });

    expect(resolver.permission("metadata-default-one")).toBe("deny");
    expect(resolver.permission("metadata-deny")).toBe("allow");
    expect(resolver.permission("metadata-ask")).toBe("ask");
    expect(resolver.permission("not-in-metadata")).toBe("deny");
    expect(resolver.unknown()).toBe("ask");
  });

  it("summarizes visible permission lists", () => {
    const resolver = createFirewallMetadataPolicyResolver(RESOLVER_METADATA);

    expect(
      resolver.list(["metadata-default-one", "metadata-default-two"]),
    ).toBe("allow");
    expect(resolver.list(["metadata-default-one", "metadata-deny"])).toBe(
      "mixed",
    );
    expect(resolver.list([])).toBe("mixed");
  });

  it("reports only effective sparse overlay changes as overrides", () => {
    const redundant = createFirewallMetadataPolicyResolver(RESOLVER_METADATA, {
      permissionDefault: "allow",
      permissionOverrides: {
        "metadata-deny": "deny",
      },
      unknownPolicy: "deny",
    });

    expect(redundant.isPermissionOverridden("metadata-default-one")).toBe(
      false,
    );
    expect(redundant.isPermissionOverridden("metadata-deny")).toBe(false);
    expect(redundant.isUnknownOverridden()).toBe(false);

    const changed = createFirewallMetadataPolicyResolver(RESOLVER_METADATA, {
      permissionDefault: "deny",
      permissionOverrides: {
        "metadata-deny": "allow",
      },
      unknownPolicy: "allow",
    });

    expect(changed.isPermissionOverridden("metadata-default-one")).toBe(true);
    expect(changed.isPermissionOverridden("metadata-deny")).toBe(true);
    expect(changed.isUnknownOverridden()).toBe(true);
  });

  it("keeps unknown endpoint policy separate from permission lookup", () => {
    const resolver = createFirewallMetadataPolicyResolver(RESOLVER_METADATA, {
      permissionOverrides: {
        [UNKNOWN_PERMISSION_GRANT]: "allow",
      },
      unknownPolicy: "ask",
    });

    expect(resolver.permission(UNKNOWN_PERMISSION_GRANT)).toBe("allow");
    expect(resolver.unknown()).toBe("ask");
  });

  it("ignores inherited fields when resolving sparse overlay overrides", () => {
    const resolver = createFirewallMetadataPolicyResolver(RESOLVER_METADATA, {
      permissionOverrides: {},
    });

    expect(resolver.permission("toString")).toBe("allow");
    expect(resolver.isPermissionOverridden("toString")).toBe(false);
  });

  it("keeps metadata modules independent from runtime firewall modules", () => {
    const metadataRoot = path.resolve(
      import.meta.dirname,
      "../firewall-metadata",
    );
    for (const file of listTsFiles(metadataRoot)) {
      const source = fs.readFileSync(file, "utf-8");
      const specs = importSpecifiers(source);
      for (const spec of specs) {
        expect(spec).not.toBe("@vm0/connectors/firewalls");
        expect(spec).not.toMatch(/^(\.\.\/)+firewalls(?:\/|$)/);
        expect(spec).not.toMatch(/\/firewalls(?:\/|$)/);
      }
    }
  });

  it("keeps fixed builtin host owners synchronized with runtime hosts", () => {
    for (const [host, type] of getAllBuiltinConnectorHosts()) {
      expect(getBuiltinConnectorHostOwner(host)).toStrictEqual({
        type,
        label: connectorLabel(type),
      });
    }

    expect(getBuiltinConnectorHostOwner("api.github.com")).toStrictEqual({
      type: "github",
      label: "GitHub",
    });
    expect(getBuiltinConnectorHostOwner("API.GITHUB.COM")).toStrictEqual({
      type: "github",
      label: "GitHub",
    });
    expect(getBuiltinConnectorHostOwner(" api.github.com ")).toStrictEqual({
      type: "github",
      label: "GitHub",
    });
    expect(getBuiltinConnectorHostOwner("api.github.com:443")).toStrictEqual({
      type: "github",
      label: "GitHub",
    });
    expect(getBuiltinConnectorHostOwner("api.github.com.")).toStrictEqual({
      type: "github",
      label: "GitHub",
    });
    expect(getBuiltinConnectorHostOwner("api.github.com....")).toStrictEqual({
      type: "github",
      label: "GitHub",
    });
    expect(
      getBuiltinConnectorHostOwner("https://api.github.com/repos"),
    ).toStrictEqual({
      type: "github",
      label: "GitHub",
    });
    expect(getBuiltinConnectorHostOwner("slack.com")).toStrictEqual({
      type: "slack",
      label: "Slack",
    });
    expect(getBuiltinConnectorHostOwner("example.invalid")).toBeNull();
    expect(getBuiltinConnectorHostOwner("")).toBeNull();
    expect(getBuiltinConnectorHostOwner("api.github.com:80")).toBeNull();
    expect(getBuiltinConnectorHostOwner("toString")).toBeNull();
    expect(getBuiltinConnectorHostOwner("__proto__")).toBeNull();
  });

  it("loads memoized server permission indexes from lazy detail metadata", async () => {
    expect(isFirewallServerMetadataConnectorType("slack")).toBe(true);
    expect(getFirewallServerMetadataSummary("slack")?.label).toBe("Slack");
    expect(isFirewallServerMetadataConnectorType("cloudinary")).toBe(false);
    expect(getFirewallServerMetadataSummary("cloudinary")).toBeNull();

    const first = await loadFirewallPermissionIndex("slack");
    const second = await loadFirewallPermissionIndex("slack");
    const [concurrentFirst, concurrentSecond] = await Promise.all([
      loadFirewallPermissionIndex("github"),
      loadFirewallPermissionIndex("github"),
    ]);

    expect(first).not.toBeNull();
    expect(first).toBe(second);
    expect(concurrentFirst).not.toBeNull();
    expect(concurrentFirst).toBe(concurrentSecond);
    expect(first!.type).toBe("slack");
    expect(first!.label).toBe("Slack");
    expect(first!.hasPermission("channels:read")).toBe(true);
    expect(first!.permissionNames.has("channels:read")).toBe(true);
    expect(first!.permissionDescription("channels:read")).toBe(
      "View basic information about public channels in a workspace",
    );
    expect(first!.hasPermission(UNKNOWN_PERMISSION_GRANT)).toBe(false);
    expect(first!.permissionNames.has(UNKNOWN_PERMISSION_GRANT)).toBe(false);
    expect(first!.unknownPolicy).toBe("allow");
    expect(first!.policyResolver.permission("channels:read")).toBe("allow");
    expect(first!.policyResolver.permission("chat:write")).toBe("deny");
    expect(await loadFirewallPermissionIndex("cloudinary")).toBeNull();
  });

  it("keeps server permission indexes aligned with generated summaries", async () => {
    for (const [type, summary] of Object.entries(
      FIREWALL_PERMISSION_METADATA_SUMMARIES,
    )) {
      const index = await loadFirewallPermissionIndex(type);
      expect(index).not.toBeNull();
      expect(index!.type).toBe(type);
      expect(index!.label).toBe(summary.label);
    }
  });

  it("resolves server metadata policies like runtime helpers", async () => {
    for (const [type] of runtimeEntries()) {
      const stored = {
        [type]: {
          policies: { __metadata_test__: "deny" as const },
          unknownPolicy: "deny" as const,
        },
      };
      await expect(
        resolveFirewallServerMetadataPolicies(null, [type]),
      ).resolves.toStrictEqual(resolveFirewallPolicies(null, [type]));
      await expect(
        resolveFirewallServerMetadataPolicies(stored, [type]),
      ).resolves.toStrictEqual(resolveFirewallPolicies(stored, [type]));
    }

    await expect(
      resolveFirewallServerMetadataPolicies(null, ["cloudinary"]),
    ).resolves.toBeNull();

    const storedUnknownConnector = {
      cloudinary: {
        policies: { read: "deny" as const },
        unknownPolicy: "allow" as const,
      },
    };
    await expect(
      resolveFirewallServerMetadataPolicies(storedUnknownConnector, [
        "cloudinary",
      ]),
    ).resolves.toStrictEqual(storedUnknownConnector);
  });

  it("keeps summary metadata synchronized with the runtime registry", () => {
    const runtimeTypes = runtimeEntries().map(([type]) => {
      return type;
    });
    const metadataTypes = Object.keys(
      FIREWALL_PERMISSION_METADATA_SUMMARIES,
    ).sort(compareStrings);
    expect(metadataTypes).toStrictEqual(runtimeTypes);

    for (const [type, firewall] of runtimeEntries()) {
      const permissions = collectRuntimePermissions(firewall);
      const summary = getFirewallPermissionSummary(type);
      expect(summary).toStrictEqual(
        FIREWALL_PERMISSION_METADATA_SUMMARIES[type],
      );
      expect(summary).toMatchObject({
        type,
        label: connectorLabel(type),
        hasPermissions: permissions.length > 0,
        permissionCount: permissions.length,
        hasCategories: getPermissionCategories(type) !== null,
      });
    }
  });

  it("loads per-connector details and keeps permission metadata synchronized", async () => {
    for (const [type, firewall] of runtimeEntries()) {
      expect(isFirewallMetadataConnectorType(type)).toBe(true);
      const detail = await loadFirewallPermissionMetadata(type);
      expect(detail).not.toBeNull();
      expect(detail!.label).toBe(connectorLabel(type));
      expect(detail!.permissions).toStrictEqual(
        collectRuntimePermissions(firewall),
      );
      expect(detail!.permissionCount).toBe(detail!.permissions.length);
      assertNoForbiddenMetadataKeys(detail, type);
    }

    expect(isFirewallMetadataConnectorType("cloudinary")).toBe(false);
    await expect(
      loadFirewallPermissionMetadata("cloudinary"),
    ).resolves.toBeNull();
  });

  it("keeps execution metadata synchronized with runtime construction data", async () => {
    const billableConnectors = new Set<string>(BILLABLE_CONNECTORS);

    for (const [type, firewall] of runtimeEntries()) {
      expect(isFirewallExecutionMetadataConnectorType(type)).toBe(true);
      const metadata = getFirewallExecutionMetadata(type);
      expect(metadata).not.toBeNull();
      const baseUrlTemplates = collectRuntimeBaseUrlTemplates(firewall);
      const baseUrlVarNames = [
        ...new Set(
          baseUrlTemplates.flatMap((template) => {
            return extractBaseUrlVarNames(template.base);
          }),
        ),
      ].sort(compareStrings);
      const placeholderValues = collectRuntimePlaceholderValues(firewall);

      expect(metadata!.type).toBe(type);
      expect(metadata!.billable).toBe(billableConnectors.has(type));
      expect(metadata!.baseUrlVarNames).toStrictEqual(baseUrlVarNames);
      expect(metadata!.baseUrlTemplates).toStrictEqual(baseUrlTemplates);
      expect(metadata!.placeholderValues).toStrictEqual(placeholderValues);
      expect(metadata!.secretPlaceholderNames).toStrictEqual(
        Object.keys(placeholderValues),
      );
      assertNoForbiddenExecutionMetadataKeys(metadata!, type);
    }

    expect(isFirewallExecutionMetadataConnectorType("cloudinary")).toBe(false);
    expect(getFirewallExecutionMetadata("cloudinary")).toBeNull();
  });

  it("keeps category metadata synchronized with runtime categories", async () => {
    for (const [type] of runtimeEntries()) {
      const detail = await loadFirewallPermissionMetadata(type);
      expect(detail).not.toBeNull();
      const categories = getPermissionCategories(type);
      if (!categories) {
        expect(detail!.categories).toBeUndefined();
        continue;
      }

      expect(detail!.categories).toStrictEqual({
        categories: categories.categories,
        displayOrder: [...categories.displayOrder],
      });
    }
  });

  it("groups metadata permissions like runtime categories", async () => {
    for (const [type, firewall] of runtimeEntries()) {
      const detail = await loadFirewallPermissionMetadata(type);
      expect(detail).not.toBeNull();
      expect(
        groupFirewallMetadataPermissionsByCategory(
          detail!.permissions,
          detail!,
        ),
      ).toStrictEqual(
        groupPermissionsByCategory(collectRuntimePermissions(firewall), type),
      );
    }
  });

  it("expands compact default policy metadata to runtime default policies", async () => {
    for (const [type] of runtimeEntries()) {
      const detail = await loadFirewallPermissionMetadata(type);
      expect(detail).not.toBeNull();
      expect(expandFirewallMetadataDefaultPolicy(detail!)).toStrictEqual(
        getDefaultFirewallPolicies(type),
      );
    }
  });

  it("resolves stored policies with metadata defaults like runtime helpers", async () => {
    for (const [type] of runtimeEntries()) {
      const detail = await loadFirewallPermissionMetadata(type);
      expect(detail).not.toBeNull();
      const stored = {
        [type]: {
          policies: { __metadata_test__: "deny" as const },
          unknownPolicy: "deny" as const,
        },
      };
      expect(resolveFirewallMetadataPolicies(stored, [detail!])).toStrictEqual(
        resolveFirewallPolicies(stored, [type]),
      );
    }
  });

  it("converts permission grants without runtime firewall data", () => {
    expect(
      permissionGrantsToFirewallPolicies([
        {
          connectorRef: "slack",
          permission: "channels:read",
          action: "allow",
        },
        {
          connectorRef: "slack",
          permission: "__unknown__",
          action: "deny",
        },
      ]),
    ).toStrictEqual({
      slack: {
        policies: { "channels:read": "allow" },
        unknownPolicy: "deny",
      },
    });
    expect(permissionGrantsToFirewallPolicies([])).toBeNull();
  });
});
