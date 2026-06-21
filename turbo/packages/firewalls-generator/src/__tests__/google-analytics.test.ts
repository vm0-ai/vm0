import { beforeAll, describe, expect, it } from "vitest";
import { fetchSpec } from "../codegen";
import {
  buildGoogleAnalyticsOfficialRouteKeys,
  GOOGLE_ANALYTICS_APIS,
  GOOGLE_ANALYTICS_PERMISSION_MANIFEST,
  validateGoogleAnalyticsPermissionManifest,
  type GoogleAnalyticsDiscoveryDocument,
  type GoogleAnalyticsManifestPermission,
} from "../google-analytics";

async function loadDiscoveries(): Promise<
  Array<{
    readonly kind: (typeof GOOGLE_ANALYTICS_APIS)[number]["kind"];
    readonly discovery: GoogleAnalyticsDiscoveryDocument;
  }>
> {
  const discoveries: Array<{
    readonly kind: (typeof GOOGLE_ANALYTICS_APIS)[number]["kind"];
    readonly discovery: GoogleAnalyticsDiscoveryDocument;
  }> = [];
  for (const api of GOOGLE_ANALYTICS_APIS) {
    const response = await fetchSpec(
      api.discoveryUrl,
      "google-analytics test discovery document",
    );
    discoveries.push({
      kind: api.kind,
      discovery: (await response.json()) as GoogleAnalyticsDiscoveryDocument,
    });
  }
  return discoveries;
}

function cloneManifest(): GoogleAnalyticsManifestPermission[] {
  return GOOGLE_ANALYTICS_PERMISSION_MANIFEST.map((permission) => {
    return {
      ...permission,
      routeKeys: [...permission.routeKeys],
    };
  });
}

function manifestPermission(name: string): GoogleAnalyticsManifestPermission {
  const permission = GOOGLE_ANALYTICS_PERMISSION_MANIFEST.find((candidate) => {
    return candidate.name === name;
  });
  if (!permission) {
    throw new Error(`Missing Google Analytics manifest permission: ${name}`);
  }
  return permission;
}

describe("Google Analytics permission manifest", () => {
  let officialRouteKeys: Set<string>;

  beforeAll(async () => {
    officialRouteKeys = buildGoogleAnalyticsOfficialRouteKeys(
      await loadDiscoveries(),
    );
  });

  it("matches the official Discovery route set exactly", () => {
    expect(officialRouteKeys.size).toBe(66);

    expect(() => {
      validateGoogleAnalyticsPermissionManifest(
        officialRouteKeys,
        GOOGLE_ANALYTICS_PERMISSION_MANIFEST,
      );
    }).not.toThrow();
  });

  it("fails when the manifest contains a route absent from Discovery", () => {
    const manifest = cloneManifest();
    manifest[0] = {
      ...manifest[0]!,
      routeKeys: [
        ...manifest[0]!.routeKeys,
        "data:GET /v1beta/properties/{propertiesId}/bogus",
      ],
    };

    expect(() => {
      validateGoogleAnalyticsPermissionManifest(officialRouteKeys, manifest);
    }).toThrow("Unknown Google Analytics manifest route keys");
  });

  it("fails when Discovery contains a route missing from the manifest", () => {
    const changedOfficialRoutes = new Set(officialRouteKeys);
    changedOfficialRoutes.add(
      "admin:GET /v1beta/properties/{propertiesId}/newOfficialRoute",
    );

    expect(() => {
      validateGoogleAnalyticsPermissionManifest(
        changedOfficialRoutes,
        GOOGLE_ANALYTICS_PERMISSION_MANIFEST,
      );
    }).toThrow("Missing Google Analytics manifest route keys");
  });

  it("fails duplicate route assignments", () => {
    const duplicateRoute =
      "data:GET /v1beta/properties/{propertiesId}/metadata";
    const manifest = cloneManifest();
    manifest[0] = {
      ...manifest[0]!,
      routeKeys: [...manifest[0]!.routeKeys, duplicateRoute],
    };

    expect(() => {
      validateGoogleAnalyticsPermissionManifest(officialRouteKeys, manifest);
    }).toThrow("Duplicate Google Analytics manifest route assignments");
  });

  it("keeps audience export creation separate from report execution", () => {
    const reportsRun = manifestPermission("reports.run");
    const audienceExportsRun = manifestPermission("audience-exports.run");
    const audienceExportsRead = manifestPermission("audience-exports.read");

    expect(reportsRun.routeKeys).toContain(
      "data:POST /v1beta/properties/{propertiesId}:runReport",
    );
    expect(reportsRun.routeKeys).not.toContain(
      "data:POST /v1beta/properties/{propertiesId}/audienceExports",
    );
    expect(audienceExportsRun.routeKeys).toEqual([
      "data:POST /v1beta/properties/{propertiesId}/audienceExports",
    ]);
    expect(audienceExportsRead.routeKeys).toContain(
      "data:POST /v1beta/properties/{propertiesId}/audienceExports/{audienceExportsId}:query",
    );
  });

  it("keeps Measurement Protocol secret reads in a dedicated permission", () => {
    const dataStreamsRead = manifestPermission("data-streams.read");
    const measurementSecretsRead = manifestPermission(
      "measurement-secrets.read",
    );

    expect(dataStreamsRead.routeKeys).toEqual([
      "admin:GET /v1beta/properties/{propertiesId}/dataStreams",
      "admin:GET /v1beta/properties/{propertiesId}/dataStreams/{dataStreamsId}",
    ]);
    expect(measurementSecretsRead.routeKeys).toEqual([
      "admin:GET /v1beta/properties/{propertiesId}/dataStreams/{dataStreamsId}/measurementProtocolSecrets",
      "admin:GET /v1beta/properties/{propertiesId}/dataStreams/{dataStreamsId}/measurementProtocolSecrets/{measurementProtocolSecretsId}",
    ]);
  });

  it("does not expose Google OAuth scope names as permissions", () => {
    const names = GOOGLE_ANALYTICS_PERMISSION_MANIFEST.map((permission) => {
      return permission.name;
    });

    expect(names).not.toContain("analytics");
    expect(names).not.toContain("analytics.readonly");
    expect(names).not.toContain("analytics.edit");
    expect(names.every((name) => !name.startsWith("analytics."))).toBe(true);
  });

  it("groups every permission into a resource-oriented category", () => {
    const categoriesByName = Object.fromEntries(
      GOOGLE_ANALYTICS_PERMISSION_MANIFEST.map((permission) => {
        return [permission.name, permission.category];
      }),
    );

    expect(categoriesByName).toEqual({
      "access-reports.run": "Admin Activity",
      "accounts.delete": "Accounts",
      "accounts.read": "Accounts",
      "accounts.write": "Accounts",
      "audience-exports.read": "Reports",
      "audience-exports.run": "Reports",
      "change-history.read": "Admin Activity",
      "custom-definitions.read": "Events & Definitions",
      "custom-definitions.write": "Events & Definitions",
      "data-streams.delete": "Data Streams",
      "data-streams.read": "Data Streams",
      "data-streams.write": "Data Streams",
      "key-events.delete": "Events & Definitions",
      "key-events.read": "Events & Definitions",
      "key-events.write": "Events & Definitions",
      "links.delete": "Integrations",
      "links.read": "Integrations",
      "links.write": "Integrations",
      "measurement-secrets.delete": "Data Streams",
      "measurement-secrets.read": "Data Streams",
      "measurement-secrets.write": "Data Streams",
      "metadata.read": "Reports",
      "properties.delete": "Properties",
      "properties.read": "Properties",
      "properties.write": "Properties",
      "reports.run": "Reports",
    });
  });
});
