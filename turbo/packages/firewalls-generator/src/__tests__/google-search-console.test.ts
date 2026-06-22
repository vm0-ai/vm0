import { beforeAll, describe, expect, it } from "vitest";
import { fetchSpec } from "../codegen";
import {
  buildGoogleSearchConsoleOfficialRouteKeys,
  GOOGLE_SEARCH_CONSOLE_DISCOVERY_URL,
  GOOGLE_SEARCH_CONSOLE_PERMISSION_MANIFEST,
  validateGoogleSearchConsolePermissionManifest,
  type GoogleSearchConsoleDiscoveryDocument,
  type GoogleSearchConsoleManifestPermission,
} from "../google-search-console";

async function loadDiscovery(): Promise<GoogleSearchConsoleDiscoveryDocument> {
  const response = await fetchSpec(
    GOOGLE_SEARCH_CONSOLE_DISCOVERY_URL,
    "google-search-console test discovery document",
  );
  return (await response.json()) as GoogleSearchConsoleDiscoveryDocument;
}

function cloneManifest(): GoogleSearchConsoleManifestPermission[] {
  return GOOGLE_SEARCH_CONSOLE_PERMISSION_MANIFEST.map((permission) => {
    return {
      ...permission,
      routeKeys: [...permission.routeKeys],
    };
  });
}

function manifestPermission(
  name: string,
): GoogleSearchConsoleManifestPermission {
  const permission = GOOGLE_SEARCH_CONSOLE_PERMISSION_MANIFEST.find(
    (candidate) => {
      return candidate.name === name;
    },
  );
  if (!permission) {
    throw new Error(
      `Missing Google Search Console manifest permission: ${name}`,
    );
  }
  return permission;
}

describe("Google Search Console permission manifest", () => {
  let officialRouteKeys: Set<string>;

  beforeAll(async () => {
    officialRouteKeys = buildGoogleSearchConsoleOfficialRouteKeys(
      await loadDiscovery(),
    );
  });

  it("matches the official Discovery route set exactly", () => {
    expect(officialRouteKeys.size).toBe(11);

    expect(() => {
      validateGoogleSearchConsolePermissionManifest(
        officialRouteKeys,
        GOOGLE_SEARCH_CONSOLE_PERMISSION_MANIFEST,
      );
    }).not.toThrow();
  });

  it("fails when the manifest contains a route absent from Discovery", () => {
    const manifest = cloneManifest();
    manifest[0] = {
      ...manifest[0]!,
      routeKeys: [
        ...manifest[0]!.routeKeys,
        "base:GET /webmasters/v3/sites/{siteUrl}/bogus",
      ],
    };

    expect(() => {
      validateGoogleSearchConsolePermissionManifest(
        officialRouteKeys,
        manifest,
      );
    }).toThrow("Unknown Google Search Console manifest route keys");
  });

  it("fails when Discovery contains a route missing from the manifest", () => {
    const changedOfficialRoutes = new Set(officialRouteKeys);
    changedOfficialRoutes.add("base:GET /webmasters/v3/newOfficialRoute");

    expect(() => {
      validateGoogleSearchConsolePermissionManifest(
        changedOfficialRoutes,
        GOOGLE_SEARCH_CONSOLE_PERMISSION_MANIFEST,
      );
    }).toThrow("Missing Google Search Console manifest route keys");
  });

  it("fails duplicate route assignments", () => {
    const duplicateRoute = "base:GET /webmasters/v3/sites";
    const manifest = cloneManifest();
    manifest[0] = {
      ...manifest[0]!,
      routeKeys: [...manifest[0]!.routeKeys, duplicateRoute],
    };

    expect(() => {
      validateGoogleSearchConsolePermissionManifest(
        officialRouteKeys,
        manifest,
      );
    }).toThrow("Duplicate Google Search Console manifest route assignments");
  });

  it("keeps diagnostics and analytics routes separate", () => {
    expect(manifestPermission("url-inspection.inspect").routeKeys).toEqual([
      "base:POST /v1/urlInspection/index:inspect",
    ]);
    expect(manifestPermission("mobile-friendly-tests.run").routeKeys).toEqual([
      "base:POST /v1/urlTestingTools/mobileFriendlyTest:run",
    ]);
    expect(manifestPermission("search-analytics.query").routeKeys).toEqual([
      "base:POST /webmasters/v3/sites/{siteUrl}/searchAnalytics/query",
    ]);
  });

  it("keeps site and sitemap reads, writes, and deletes separate", () => {
    expect(manifestPermission("sites.read").routeKeys).toEqual([
      "base:GET /webmasters/v3/sites",
      "base:GET /webmasters/v3/sites/{siteUrl}",
    ]);
    expect(manifestPermission("sites.write").routeKeys).toEqual([
      "base:PUT /webmasters/v3/sites/{siteUrl}",
    ]);
    expect(manifestPermission("sites.delete").routeKeys).toEqual([
      "base:DELETE /webmasters/v3/sites/{siteUrl}",
    ]);
    expect(manifestPermission("sitemaps.read").routeKeys).toEqual([
      "base:GET /webmasters/v3/sites/{siteUrl}/sitemaps",
      "base:GET /webmasters/v3/sites/{siteUrl}/sitemaps/{feedpath}",
    ]);
    expect(manifestPermission("sitemaps.write").routeKeys).toEqual([
      "base:PUT /webmasters/v3/sites/{siteUrl}/sitemaps/{feedpath}",
    ]);
    expect(manifestPermission("sitemaps.delete").routeKeys).toEqual([
      "base:DELETE /webmasters/v3/sites/{siteUrl}/sitemaps/{feedpath}",
    ]);
  });

  it("does not expose Google OAuth scope names as permissions", () => {
    const names = GOOGLE_SEARCH_CONSOLE_PERMISSION_MANIFEST.map(
      (permission) => {
        return permission.name;
      },
    );

    expect(names).not.toContain("webmasters");
    expect(names).not.toContain("webmasters.readonly");
    expect(names.every((name) => !name.startsWith("webmasters"))).toBe(true);
  });

  it("groups every permission into a resource-oriented category", () => {
    const categoriesByName = Object.fromEntries(
      GOOGLE_SEARCH_CONSOLE_PERMISSION_MANIFEST.map((permission) => {
        return [permission.name, permission.category];
      }),
    );

    expect(categoriesByName).toEqual({
      "mobile-friendly-tests.run": "URL Testing",
      "search-analytics.query": "Search Analytics",
      "sitemaps.delete": "Sitemaps",
      "sitemaps.read": "Sitemaps",
      "sitemaps.write": "Sitemaps",
      "sites.delete": "Sites",
      "sites.read": "Sites",
      "sites.write": "Sites",
      "url-inspection.inspect": "URL Inspection",
    });
  });
});
