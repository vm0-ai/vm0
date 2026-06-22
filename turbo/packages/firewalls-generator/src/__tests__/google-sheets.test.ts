import { beforeAll, describe, expect, it } from "vitest";
import { fetchSpec } from "../codegen";
import {
  buildGoogleSheetsOfficialRouteKeys,
  GOOGLE_SHEETS_DISCOVERY_URL,
  GOOGLE_SHEETS_PERMISSION_MANIFEST,
  validateGoogleSheetsPermissionManifest,
  type GoogleSheetsDiscoveryDocument,
  type GoogleSheetsManifestPermission,
} from "../google-sheets";

async function loadDiscovery(): Promise<GoogleSheetsDiscoveryDocument> {
  const response = await fetchSpec(
    GOOGLE_SHEETS_DISCOVERY_URL,
    "google-sheets test discovery document",
  );
  return (await response.json()) as GoogleSheetsDiscoveryDocument;
}

function cloneManifest(): GoogleSheetsManifestPermission[] {
  return GOOGLE_SHEETS_PERMISSION_MANIFEST.map((permission) => {
    return {
      ...permission,
      routeKeys: [...permission.routeKeys],
    };
  });
}

function manifestPermission(name: string): GoogleSheetsManifestPermission {
  const permission = GOOGLE_SHEETS_PERMISSION_MANIFEST.find((candidate) => {
    return candidate.name === name;
  });
  if (!permission) {
    throw new Error(`Missing Google Sheets manifest permission: ${name}`);
  }
  return permission;
}

describe("Google Sheets permission manifest", () => {
  let officialRouteKeys: Set<string>;

  beforeAll(async () => {
    officialRouteKeys = buildGoogleSheetsOfficialRouteKeys(
      await loadDiscovery(),
    );
  });

  it("matches the official Discovery route set exactly", () => {
    expect(officialRouteKeys.size).toBe(17);

    expect(() => {
      validateGoogleSheetsPermissionManifest(
        officialRouteKeys,
        GOOGLE_SHEETS_PERMISSION_MANIFEST,
      );
    }).not.toThrow();
  });

  it("fails when the manifest contains a route absent from Discovery", () => {
    const manifest = cloneManifest();
    manifest[0] = {
      ...manifest[0]!,
      routeKeys: [
        ...manifest[0]!.routeKeys,
        "base:GET /v4/spreadsheets/{spreadsheetId}/bogus",
      ],
    };

    expect(() => {
      validateGoogleSheetsPermissionManifest(officialRouteKeys, manifest);
    }).toThrow("Unknown Google Sheets manifest route keys");
  });

  it("fails when Discovery contains a route missing from the manifest", () => {
    const changedOfficialRoutes = new Set(officialRouteKeys);
    changedOfficialRoutes.add("base:GET /v4/spreadsheets/newOfficialRoute");

    expect(() => {
      validateGoogleSheetsPermissionManifest(
        changedOfficialRoutes,
        GOOGLE_SHEETS_PERMISSION_MANIFEST,
      );
    }).toThrow("Missing Google Sheets manifest route keys");
  });

  it("fails duplicate route assignments", () => {
    const duplicateRoute = "base:GET /v4/spreadsheets/{spreadsheetId}";
    const manifest = cloneManifest();
    manifest[0] = {
      ...manifest[0]!,
      routeKeys: [...manifest[0]!.routeKeys, duplicateRoute],
    };

    expect(() => {
      validateGoogleSheetsPermissionManifest(officialRouteKeys, manifest);
    }).toThrow("Duplicate Google Sheets manifest route assignments");
  });

  it("keeps spreadsheet reads, writes, and creates separate", () => {
    expect(manifestPermission("spreadsheets.create").routeKeys).toEqual([
      "base:POST /v4/spreadsheets",
    ]);
    expect(manifestPermission("spreadsheets.read").routeKeys).toEqual([
      "base:GET /v4/spreadsheets/{spreadsheetId}",
    ]);
    expect(
      manifestPermission("spreadsheets.read-by-data-filter").routeKeys,
    ).toEqual(["base:POST /v4/spreadsheets/{spreadsheetId}:getByDataFilter"]);
    expect(manifestPermission("spreadsheets.write").routeKeys).toEqual([
      "base:POST /v4/spreadsheets/{spreadsheetId}:batchUpdate",
    ]);
  });

  it("keeps value reads, writes, and clears separate", () => {
    expect(manifestPermission("values.read").routeKeys).toEqual([
      "base:GET /v4/spreadsheets/{spreadsheetId}/values/{range}",
      "base:GET /v4/spreadsheets/{spreadsheetId}/values:batchGet",
    ]);
    expect(manifestPermission("values.read-by-data-filter").routeKeys).toEqual([
      "base:POST /v4/spreadsheets/{spreadsheetId}/values:batchGetByDataFilter",
    ]);
    expect(manifestPermission("values.write").routeKeys).toEqual([
      "base:POST /v4/spreadsheets/{spreadsheetId}/values/{range}:append",
      "base:POST /v4/spreadsheets/{spreadsheetId}/values:batchUpdate",
      "base:POST /v4/spreadsheets/{spreadsheetId}/values:batchUpdateByDataFilter",
      "base:PUT /v4/spreadsheets/{spreadsheetId}/values/{range}",
    ]);
    expect(manifestPermission("values.clear").routeKeys).toEqual([
      "base:POST /v4/spreadsheets/{spreadsheetId}/values/{range}:clear",
      "base:POST /v4/spreadsheets/{spreadsheetId}/values:batchClear",
      "base:POST /v4/spreadsheets/{spreadsheetId}/values:batchClearByDataFilter",
    ]);
  });

  it("does not expose Google OAuth scope names as permissions", () => {
    const names = GOOGLE_SHEETS_PERMISSION_MANIFEST.map((permission) => {
      return permission.name;
    });

    expect(names).not.toContain("drive");
    expect(names).not.toContain("drive.file");
    expect(names).not.toContain("drive.readonly");
    expect(names).not.toContain("spreadsheets");
    expect(names).not.toContain("spreadsheets.readonly");
  });

  it("groups every permission into a resource-oriented category", () => {
    const categoriesByName = Object.fromEntries(
      GOOGLE_SHEETS_PERMISSION_MANIFEST.map((permission) => {
        return [permission.name, permission.category];
      }),
    );

    expect(categoriesByName).toEqual({
      "developer-metadata.read": "Developer Metadata",
      "developer-metadata.search": "Developer Metadata",
      "sheets.copy": "Sheets",
      "spreadsheets.create": "Spreadsheets",
      "spreadsheets.read": "Spreadsheets",
      "spreadsheets.read-by-data-filter": "Spreadsheets",
      "spreadsheets.write": "Spreadsheets",
      "values.clear": "Values",
      "values.read": "Values",
      "values.read-by-data-filter": "Values",
      "values.write": "Values",
    });
  });
});
