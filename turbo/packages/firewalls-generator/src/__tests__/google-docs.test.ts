import { beforeAll, describe, expect, it } from "vitest";
import { fetchSpec } from "../codegen";
import {
  buildGoogleDocsOfficialRouteKeys,
  GOOGLE_DOCS_DISCOVERY_URL,
  GOOGLE_DOCS_PERMISSION_MANIFEST,
  validateGoogleDocsPermissionManifest,
  type GoogleDocsDiscoveryDocument,
  type GoogleDocsManifestPermission,
} from "../google-docs";

async function loadDiscovery(): Promise<GoogleDocsDiscoveryDocument> {
  const response = await fetchSpec(
    GOOGLE_DOCS_DISCOVERY_URL,
    "google-docs test discovery document",
  );
  return (await response.json()) as GoogleDocsDiscoveryDocument;
}

function cloneManifest(): GoogleDocsManifestPermission[] {
  return GOOGLE_DOCS_PERMISSION_MANIFEST.map((permission) => {
    return {
      ...permission,
      routeKeys: [...permission.routeKeys],
    };
  });
}

function manifestPermission(name: string): GoogleDocsManifestPermission {
  const permission = GOOGLE_DOCS_PERMISSION_MANIFEST.find((candidate) => {
    return candidate.name === name;
  });
  if (!permission) {
    throw new Error(`Missing Google Docs manifest permission: ${name}`);
  }
  return permission;
}

describe("Google Docs permission manifest", () => {
  let officialRouteKeys: Set<string>;

  beforeAll(async () => {
    officialRouteKeys = buildGoogleDocsOfficialRouteKeys(await loadDiscovery());
  });

  it("matches the official Discovery route set exactly", () => {
    expect(officialRouteKeys.size).toBe(3);

    expect(() => {
      validateGoogleDocsPermissionManifest(
        officialRouteKeys,
        GOOGLE_DOCS_PERMISSION_MANIFEST,
      );
    }).not.toThrow();
  });

  it("fails when the manifest contains a route absent from Discovery", () => {
    const manifest = cloneManifest();
    manifest[0] = {
      ...manifest[0]!,
      routeKeys: [...manifest[0]!.routeKeys, "base:GET /v1/documents"],
    };

    expect(() => {
      validateGoogleDocsPermissionManifest(officialRouteKeys, manifest);
    }).toThrow("Unknown Google Docs manifest route keys");
  });

  it("fails when Discovery contains a route missing from the manifest", () => {
    const changedOfficialRoutes = new Set(officialRouteKeys);
    changedOfficialRoutes.add("base:DELETE /v1/documents/{documentId}");

    expect(() => {
      validateGoogleDocsPermissionManifest(
        changedOfficialRoutes,
        GOOGLE_DOCS_PERMISSION_MANIFEST,
      );
    }).toThrow("Missing Google Docs manifest route keys");
  });

  it("fails duplicate route assignments", () => {
    const duplicateRoute = "base:GET /v1/documents/{documentId}";
    const manifest = cloneManifest();
    manifest[0] = {
      ...manifest[0]!,
      routeKeys: [...manifest[0]!.routeKeys, duplicateRoute],
    };

    expect(() => {
      validateGoogleDocsPermissionManifest(officialRouteKeys, manifest);
    }).toThrow("Duplicate Google Docs manifest route assignments");
  });

  it("keeps create, read, and update routes separate", () => {
    expect(manifestPermission("documents.create").routeKeys).toEqual([
      "base:POST /v1/documents",
    ]);
    expect(manifestPermission("documents.read").routeKeys).toEqual([
      "base:GET /v1/documents/{documentId}",
    ]);
    expect(manifestPermission("documents.write").routeKeys).toEqual([
      "base:POST /v1/documents/{documentId}:batchUpdate",
    ]);
  });

  it("does not expose Google OAuth scope names as permissions", () => {
    const names = GOOGLE_DOCS_PERMISSION_MANIFEST.map((permission) => {
      return permission.name;
    });

    expect(names).not.toContain("documents");
    expect(names).not.toContain("documents.readonly");
    expect(names).not.toContain("drive");
    expect(names).not.toContain("drive.file");
    expect(names).not.toContain("drive.readonly");
  });
});
