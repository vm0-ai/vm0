import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { FIREWALL_PERMISSION_METADATA_SUMMARIES } from "../firewall-metadata";
import {
  FIREWALL_ROUTING_METADATA_CONNECTOR_TYPES,
  getFirewallRoutingIndexMetadata,
  isFirewallRoutingMetadataConnectorType,
  loadFirewallRoutingMetadata,
  type FirewallRoutingMetadata,
} from "../firewall-metadata/routing";
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

    const routingEntrypoint = fs.readFileSync(
      path.resolve(import.meta.dirname, "../firewall-metadata/routing.ts"),
      "utf-8",
    );
    const routingIndexGenerated = fs.readFileSync(
      path.resolve(
        import.meta.dirname,
        "../firewall-metadata/routing-index.generated.ts",
      ),
      "utf-8",
    );
    const routingLoaderGenerated = fs.readFileSync(
      path.resolve(
        import.meta.dirname,
        "../firewall-metadata/routing-loader.generated.ts",
      ),
      "utf-8",
    );

    expect(packageJson.exports["./firewall-metadata/routing"]).toStrictEqual({
      import: "./src/firewall-metadata/routing.ts",
      types: "./src/firewall-metadata/routing.ts",
    });
    expect(packageJson.exports).not.toHaveProperty(
      "./firewall-routing-metadata",
    );
    expect(rootEntrypoint).not.toContain("firewall-metadata/routing");
    expect(routingEntrypoint).toContain("./routing-index.generated");
    expect(routingEntrypoint).toContain("./routing-loader.generated");
    expect(routingEntrypoint).not.toContain("./routing.generated");
    expect(routingEntrypoint).not.toContain("import(");
    expect(routingEntrypoint).not.toContain("loadAll");
    expect(routingIndexGenerated).toContain("FIREWALL_ROUTING_METADATA_INDEX");
    expect(routingIndexGenerated).not.toContain("import(");
    expect(routingIndexGenerated).not.toContain('"routes"');
    expect(routingIndexGenerated).not.toContain('"permissionName"');
    expect(routingIndexGenerated).not.toContain('"rule"');
    expect(routingLoaderGenerated).toContain(
      "loadGeneratedFirewallRoutingMetadata",
    );
    expect(routingLoaderGenerated).toContain(
      "./routing-details/slack.generated",
    );
    expect(routingLoaderGenerated).toContain("Object.create(null)");
    expect(routingLoaderGenerated).not.toContain("loadAll");
  });

  it("keeps the routing manifest synchronized with generated permission metadata", () => {
    expect(
      [...FIREWALL_ROUTING_METADATA_CONNECTOR_TYPES].sort(compareStrings),
    ).toStrictEqual(
      Object.keys(FIREWALL_PERMISSION_METADATA_SUMMARIES).sort(compareStrings),
    );
  });

  it("gets generated routing metadata", async () => {
    expect(isFirewallRoutingMetadataConnectorType("slack")).toBe(true);
    for (const unknownType of [
      "cloudinary",
      "__proto__",
      "constructor",
      "toString",
    ]) {
      expect(isFirewallRoutingMetadataConnectorType(unknownType)).toBe(false);
      expect(getFirewallRoutingIndexMetadata(unknownType)).toBeNull();
      await expect(
        loadFirewallRoutingMetadata(unknownType),
      ).resolves.toBeNull();
    }

    const slack = getFirewallRoutingIndexMetadata("slack");
    expect(slack).not.toBeNull();
    expect(slack!.type).toBe("slack");
    expect(slack!.label).toBe("Slack");
    expect(slack!.apis.length).toBeGreaterThan(1);
    expect(
      slack!.apis.map((api) => {
        return api.base;
      }),
    ).toContain("https://slack.com/api");
    expect(
      slack!.apis.map((api) => {
        return api.base;
      }),
    ).toContain("https://files.slack.com");

    const slackDetail = await loadFirewallRoutingMetadata("slack");
    expect(slackDetail).not.toBeNull();
    expect(
      slackDetail!.apis.flatMap((api) => {
        return api.routes;
      }).length,
    ).toBeGreaterThan(100);
  });

  it("preserves route-only data from runtime firewall configs", async () => {
    for (const [type, firewall] of await loadRuntimeFirewallEntries()) {
      const metadata = await loadRequiredRoutingMetadata(type);
      expect(metadata).toStrictEqual(runtimeRoutingProjection(type, firewall));
      assertNoForbiddenRoutingMetadata(metadata, type);
    }
  });

  it("represents large and shared routing surfaces", async () => {
    const googleCloud = await loadRequiredRoutingMetadata("google-cloud");
    const stripe = await loadRequiredRoutingMetadata("stripe");
    const cloudflare = await loadRequiredRoutingMetadata("cloudflare");

    expect(googleCloud.apis.length).toBeGreaterThan(10);
    expect(
      stripe.apis.flatMap((api) => {
        return api.routes;
      }).length,
    ).toBeGreaterThan(100);
    expect(
      cloudflare.apis.flatMap((api) => {
        return api.routes;
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
          api.routes.map((route) => {
            return route.permissionName;
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
