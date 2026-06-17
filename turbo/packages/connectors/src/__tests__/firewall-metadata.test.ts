import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { CONNECTOR_TYPES, type ConnectorType } from "../connectors";
import {
  expandFirewallMetadataDefaultPolicy,
  FIREWALL_PERMISSION_METADATA_SUMMARIES,
  getFirewallPermissionSummary,
  isFirewallMetadataConnectorType,
  loadFirewallPermissionMetadata,
} from "../firewall-metadata";
import type { FirewallPermissionMetadataPermission } from "../firewall-metadata";
import type { FirewallConfig } from "../firewall-types";
import {
  getAllConnectorFirewalls,
  getDefaultFirewallPolicies,
  getPermissionCategories,
  type FirewallConnectorType,
} from "../firewalls";

const FORBIDDEN_METADATA_KEYS = new Set([
  "auth",
  "base",
  "placeholders",
  "rules",
]);

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

function runtimeEntries(): [FirewallConnectorType, FirewallConfig][] {
  return Object.entries(getAllConnectorFirewalls()).sort(([a], [b]) => {
    return compareStrings(a, b);
  }) as [FirewallConnectorType, FirewallConfig][];
}

describe("firewall metadata", () => {
  it("keeps the public entrypoint summary-first", () => {
    const entrypoint = path.resolve(
      import.meta.dirname,
      "../firewall-metadata/index.ts",
    );
    const source = fs.readFileSync(entrypoint, "utf-8");

    expect(staticImportSpecifiers(source).sort(compareStrings)).toStrictEqual([
      "../firewall-types",
      "./summary.generated",
      "./types",
    ]);
    expect(dynamicImportSpecifiers(source)).toStrictEqual([
      "./loader.generated",
    ]);
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

  it("expands compact default policy metadata to runtime default policies", async () => {
    for (const [type] of runtimeEntries()) {
      const detail = await loadFirewallPermissionMetadata(type);
      expect(detail).not.toBeNull();
      expect(expandFirewallMetadataDefaultPolicy(detail!)).toStrictEqual(
        getDefaultFirewallPolicies(type),
      );
    }
  });
});
