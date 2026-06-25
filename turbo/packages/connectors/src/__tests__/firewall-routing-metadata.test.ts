import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { FIREWALL_PERMISSION_METADATA_SUMMARIES } from "../firewall-metadata";
import {
  FIREWALL_ROUTING_METADATA_CONNECTOR_TYPES,
  isFirewallRoutingMetadataConnectorType,
  loadFirewallRoutingMetadata,
  type FirewallRoutingMetadata,
} from "../firewall-routing-metadata";
import type { FirewallConfig } from "../firewall-types";
import { loadRuntimeFirewallEntries } from "./firewall-test-helpers";

const DEFAULT_FIREWALL_SECRET_PLACEHOLDER =
  "c0ffee5afe10ca1c0ffee5afe10ca1c0ffee5afe";
const FORBIDDEN_ROUTING_METADATA_KEYS = new Set([
  "auth",
  "headers",
  "query",
  "awsSigv4",
  "placeholders",
  "placeholderValues",
  "secretPlaceholderNames",
]);

type FirewallConnectorType =
  keyof typeof FIREWALL_PERMISSION_METADATA_SUMMARIES;

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function assertNoForbiddenRoutingMetadata(
  value: unknown,
  location: string,
): void {
  if (typeof value === "string") {
    expect(value, location).not.toContain(DEFAULT_FIREWALL_SECRET_PLACEHOLDER);
    expect(value, location).not.toContain("${{ secrets.");
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertNoForbiddenRoutingMetadata(item, `${location}[${index}]`);
    });
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_ROUTING_METADATA_KEYS.has(key)) {
      throw new Error(
        `routing metadata contains forbidden key "${key}" at ${location}`,
      );
    }
    assertNoForbiddenRoutingMetadata(nested, `${location}.${key}`);
  }
}

function runtimeRoutingProjection(
  type: FirewallConnectorType,
  firewall: FirewallConfig,
): FirewallRoutingMetadata {
  return {
    type,
    label: FIREWALL_PERMISSION_METADATA_SUMMARIES[type].label,
    apis: firewall.apis.map((api) => {
      return {
        base: api.base,
        permissions: (api.permissions ?? []).map((permission) => {
          return {
            name: permission.name,
            rules: [...permission.rules],
          };
        }),
      };
    }),
  };
}

async function loadRequiredRoutingMetadata(
  type: FirewallConnectorType,
): Promise<FirewallRoutingMetadata> {
  const metadata = await loadFirewallRoutingMetadata(type);
  if (!metadata) {
    throw new Error(`Missing firewall routing metadata: ${type}`);
  }
  return metadata;
}

describe("firewall routing metadata", () => {
  it("keeps routing metadata behind an explicit package subpath", () => {
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

    expect(packageJson.exports["./firewall-routing-metadata"]).toStrictEqual({
      import: "./src/firewall-routing-metadata/index.ts",
      types: "./src/firewall-routing-metadata/index.ts",
    });
    expect(rootEntrypoint).not.toContain("firewall-routing-metadata");
  });

  it("keeps the routing manifest synchronized with generated permission metadata", () => {
    expect(
      [...FIREWALL_ROUTING_METADATA_CONNECTOR_TYPES].sort(compareStrings),
    ).toStrictEqual(
      Object.keys(FIREWALL_PERMISSION_METADATA_SUMMARIES).sort(compareStrings),
    );
  });

  it("loads and caches generated routing metadata", async () => {
    expect(isFirewallRoutingMetadataConnectorType("slack")).toBe(true);
    for (const unknownType of [
      "cloudinary",
      "__proto__",
      "constructor",
      "toString",
    ]) {
      expect(isFirewallRoutingMetadataConnectorType(unknownType)).toBe(false);
      await expect(
        loadFirewallRoutingMetadata(unknownType),
      ).resolves.toBeNull();
    }

    const [firstSlack, secondSlack] = await Promise.all([
      loadFirewallRoutingMetadata("slack"),
      loadFirewallRoutingMetadata("slack"),
    ]);
    expect(firstSlack).toBe(secondSlack);
    expect(firstSlack).not.toBeNull();
    expect(firstSlack!.type).toBe("slack");
    expect(firstSlack!.label).toBe("Slack");
    expect(firstSlack!.apis.length).toBeGreaterThan(1);
    expect(
      firstSlack!.apis.map((api) => {
        return api.base;
      }),
    ).toContain("https://slack.com/api");
    expect(
      firstSlack!.apis.map((api) => {
        return api.base;
      }),
    ).toContain("https://files.slack.com");

    const repeatedSlack = await loadFirewallRoutingMetadata("slack");
    expect(repeatedSlack).toBe(firstSlack);
  });

  it("preserves route-only data from runtime firewall configs", async () => {
    for (const [type, firewall] of await loadRuntimeFirewallEntries()) {
      const metadata = await loadRequiredRoutingMetadata(type);
      expect(metadata).toStrictEqual(runtimeRoutingProjection(type, firewall));
      assertNoForbiddenRoutingMetadata(metadata, type);
    }
  });

  it("represents large and shared routing surfaces", async () => {
    const [googleCloud, stripe, cloudflare] = await Promise.all([
      loadRequiredRoutingMetadata("google-cloud"),
      loadRequiredRoutingMetadata("stripe"),
      loadRequiredRoutingMetadata("cloudflare"),
    ]);

    expect(googleCloud.apis.length).toBeGreaterThan(10);
    expect(
      stripe.apis.flatMap((api) => {
        return api.permissions;
      }).length,
    ).toBeGreaterThan(100);
    expect(
      cloudflare.apis.flatMap((api) => {
        return api.permissions.flatMap((permission) => {
          return permission.rules;
        });
      }).length,
    ).toBeGreaterThan(100);

    let sharedPermissionExample: {
      readonly type: string;
      readonly permission: string;
      readonly apiCount: number;
    } | null = null;
    for (const type of FIREWALL_ROUTING_METADATA_CONNECTOR_TYPES) {
      const metadata = await loadRequiredRoutingMetadata(type);
      const apiCounts = new Map<string, number>();
      for (const api of metadata.apis) {
        const names = new Set(
          api.permissions.map((permission) => {
            return permission.name;
          }),
        );
        for (const name of names) {
          apiCounts.set(name, (apiCounts.get(name) ?? 0) + 1);
        }
      }
      const shared = [...apiCounts.entries()].find(([, count]) => {
        return count > 1;
      });
      if (shared) {
        sharedPermissionExample = {
          type,
          permission: shared[0],
          apiCount: shared[1],
        };
        break;
      }
    }

    expect(sharedPermissionExample).not.toBeNull();
    expect(sharedPermissionExample!.apiCount).toBeGreaterThan(1);
  });
});
