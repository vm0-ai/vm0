import { beforeAll, describe, expect, it } from "vitest";
import { fetchSpec } from "../codegen";
import {
  buildGoogleDriveOfficialRouteKeys,
  GOOGLE_DRIVE_DISCOVERY_URLS,
  GOOGLE_DRIVE_PERMISSION_MANIFEST,
  validateGoogleDrivePermissionManifest,
  type GoogleDriveDiscoveryDocument,
  type GoogleDriveManifestPermission,
} from "../google-drive";

async function loadDiscoveries(): Promise<GoogleDriveDiscoveryDocument[]> {
  const discoveries: GoogleDriveDiscoveryDocument[] = [];
  for (const discoveryUrl of GOOGLE_DRIVE_DISCOVERY_URLS) {
    const response = await fetchSpec(
      discoveryUrl,
      "google-drive test discovery document",
    );
    discoveries.push((await response.json()) as GoogleDriveDiscoveryDocument);
  }
  return discoveries;
}

function cloneManifest(): GoogleDriveManifestPermission[] {
  return GOOGLE_DRIVE_PERMISSION_MANIFEST.map((permission) => {
    return {
      ...permission,
      routeKeys: [...permission.routeKeys],
    };
  });
}

function manifestPermission(name: string): GoogleDriveManifestPermission {
  const permission = GOOGLE_DRIVE_PERMISSION_MANIFEST.find((candidate) => {
    return candidate.name === name;
  });
  if (!permission) {
    throw new Error(`Missing Google Drive manifest permission: ${name}`);
  }
  return permission;
}

describe("Google Drive permission manifest", () => {
  let officialRouteKeys: Set<string>;

  beforeAll(async () => {
    officialRouteKeys = buildGoogleDriveOfficialRouteKeys(
      await loadDiscoveries(),
    );
  });

  it("matches the official Discovery route set exactly", () => {
    expect(officialRouteKeys.size).toBe(141);

    expect(() => {
      validateGoogleDrivePermissionManifest(
        officialRouteKeys,
        GOOGLE_DRIVE_PERMISSION_MANIFEST,
      );
    }).not.toThrow();
  });

  it("fails when the manifest contains a route absent from Discovery", () => {
    const manifest = cloneManifest();
    manifest[0] = {
      ...manifest[0]!,
      routeKeys: [...manifest[0]!.routeKeys, "base:GET /v9/not-real"],
    };

    expect(() => {
      validateGoogleDrivePermissionManifest(officialRouteKeys, manifest);
    }).toThrow("Unknown Google Drive manifest route keys");
  });

  it("fails when Discovery contains a route missing from the manifest", () => {
    const changedOfficialRoutes = new Set(officialRouteKeys);
    changedOfficialRoutes.add("base:GET /v3/new-official-route");

    expect(() => {
      validateGoogleDrivePermissionManifest(
        changedOfficialRoutes,
        GOOGLE_DRIVE_PERMISSION_MANIFEST,
      );
    }).toThrow("Missing Google Drive manifest route keys");
  });

  it("fails duplicate route assignments unless they are allowlisted", () => {
    const duplicateRoute = "base:GET /v2/about";
    const manifest = cloneManifest();
    manifest[1] = {
      ...manifest[1]!,
      routeKeys: [...manifest[1]!.routeKeys, duplicateRoute],
    };

    expect(() => {
      validateGoogleDrivePermissionManifest(officialRouteKeys, manifest);
    }).toThrow("Duplicate Google Drive manifest route assignments");

    expect(() => {
      validateGoogleDrivePermissionManifest(
        officialRouteKeys,
        manifest,
        new Set([duplicateRoute]),
      );
    }).not.toThrow();
  });

  it("keeps apps.read limited to Drive app routes", () => {
    const appsRead = manifestPermission("apps.read");

    expect(appsRead.routeKeys).toEqual([
      "base:GET /v2/apps",
      "base:GET /v2/apps/{appId}",
      "base:GET /v3/apps",
      "base:GET /v3/apps/{appId}",
    ]);
    expect(appsRead.routeKeys).not.toContain("base:POST /v2/files");
    expect(appsRead.routeKeys).not.toContain("upload:POST /v2/files");
  });

  it("assigns upload and resumable upload mutations to files.write", () => {
    const filesWrite = manifestPermission("files.write");

    expect(filesWrite.routeKeys).toContain("base:POST /v2/files");
    expect(filesWrite.routeKeys).toContain("upload:POST /v2/files");
    expect(filesWrite.routeKeys).toContain("resumable-upload:POST /v2/files");
    expect(filesWrite.routeKeys).toContain("upload:PATCH /v3/files/{fileId}");
    expect(filesWrite.routeKeys).toContain(
      "resumable-upload:PATCH /v3/files/{fileId}",
    );
  });

  it("does not expose OAuth scope names as permissions", () => {
    const names = GOOGLE_DRIVE_PERMISSION_MANIFEST.map((permission) => {
      return permission.name;
    });

    expect(names).not.toContain("drive.apps.readonly");
    expect(names).not.toContain("drive.file");
    expect(names).not.toContain("drive.readonly");
    expect(names.every((name) => !name.startsWith("drive."))).toBe(true);
  });

  it("groups every permission into a resource-oriented category", () => {
    const categoriesByName = Object.fromEntries(
      GOOGLE_DRIVE_PERMISSION_MANIFEST.map((permission) => {
        return [permission.name, permission.category];
      }),
    );

    expect(categoriesByName).toEqual({
      "about.read": "Drive Metadata",
      "apps.read": "Drive Metadata",
      "changes.read": "Drive Metadata",
      "channels.write": "Notifications",
      "comments.read": "Comments",
      "comments.write": "Comments",
      "drives.delete": "Shared Drives",
      "drives.read": "Shared Drives",
      "drives.write": "Shared Drives",
      "files.delete": "Files",
      "files.read": "Files",
      "files.share": "Sharing",
      "files.write": "Files",
      "operations.read": "Drive Metadata",
      "replies.read": "Comments",
      "replies.write": "Comments",
      "revisions.delete": "Revisions",
      "revisions.read": "Revisions",
      "revisions.write": "Revisions",
    });
  });
});
