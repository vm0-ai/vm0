import { beforeAll, describe, expect, it } from "vitest";
import { fetchSpec } from "../codegen";
import {
  buildGoogleFormsOfficialRouteKeys,
  GOOGLE_FORMS_DISCOVERY_URL,
  GOOGLE_FORMS_PERMISSION_MANIFEST,
  validateGoogleFormsPermissionManifest,
  type GoogleFormsDiscoveryDocument,
  type GoogleFormsManifestPermission,
} from "../google-forms";

async function loadDiscovery(): Promise<GoogleFormsDiscoveryDocument> {
  const response = await fetchSpec(
    GOOGLE_FORMS_DISCOVERY_URL,
    "google-forms test discovery document",
  );
  return (await response.json()) as GoogleFormsDiscoveryDocument;
}

function cloneManifest(): GoogleFormsManifestPermission[] {
  return GOOGLE_FORMS_PERMISSION_MANIFEST.map((permission) => ({
    ...permission,
    routeKeys: [...permission.routeKeys],
  }));
}

function manifestPermission(name: string): GoogleFormsManifestPermission {
  const permission = GOOGLE_FORMS_PERMISSION_MANIFEST.find(
    (candidate) => candidate.name === name,
  );
  if (!permission) {
    throw new Error(`Missing Google Forms manifest permission: ${name}`);
  }
  return permission;
}

describe("Google Forms permission manifest", () => {
  let officialRouteKeys: Set<string>;

  beforeAll(async () => {
    officialRouteKeys = buildGoogleFormsOfficialRouteKeys(
      await loadDiscovery(),
    );
  });

  it("matches the official Discovery route set exactly", () => {
    expect(officialRouteKeys.size).toBe(10);
    expect(() => {
      validateGoogleFormsPermissionManifest(
        officialRouteKeys,
        GOOGLE_FORMS_PERMISSION_MANIFEST,
      );
    }).not.toThrow();
  });

  it("rejects unknown, missing, and duplicate routes", () => {
    const unknownManifest = cloneManifest();
    unknownManifest[0] = {
      ...unknownManifest[0]!,
      routeKeys: [...unknownManifest[0]!.routeKeys, "base:GET /v1/forms/bogus"],
    };
    expect(() => {
      validateGoogleFormsPermissionManifest(officialRouteKeys, unknownManifest);
    }).toThrow("Unknown Google Forms manifest route keys");

    const changedOfficialRoutes = new Set(officialRouteKeys);
    changedOfficialRoutes.add("base:GET /v1/forms:newOfficialRoute");
    expect(() => {
      validateGoogleFormsPermissionManifest(
        changedOfficialRoutes,
        GOOGLE_FORMS_PERMISSION_MANIFEST,
      );
    }).toThrow("Missing Google Forms manifest route keys");

    const duplicateManifest = cloneManifest();
    duplicateManifest[1] = {
      ...duplicateManifest[1]!,
      routeKeys: [...duplicateManifest[1]!.routeKeys, "base:POST /v1/forms"],
    };
    expect(() => {
      validateGoogleFormsPermissionManifest(
        officialRouteKeys,
        duplicateManifest,
      );
    }).toThrow("Duplicate Google Forms manifest route assignments");
  });

  it("keeps form reads and mutations separate", () => {
    expect(manifestPermission("forms.create").routeKeys).toEqual([
      "base:POST /v1/forms",
    ]);
    expect(manifestPermission("forms.read").routeKeys).toEqual([
      "base:GET /v1/forms/{formId}",
    ]);
    expect(manifestPermission("forms.write").routeKeys).toEqual([
      "base:POST /v1/forms/{formId}:batchUpdate",
    ]);
    expect(manifestPermission("forms.publish").routeKeys).toEqual([
      "base:POST /v1/forms/{formId}:setPublishSettings",
    ]);
  });

  it("uses resource-oriented categories instead of OAuth scope names", () => {
    const categoriesByName = Object.fromEntries(
      GOOGLE_FORMS_PERMISSION_MANIFEST.map((permission) => [
        permission.name,
        permission.category,
      ]),
    );
    expect(categoriesByName).toEqual({
      "forms.create": "Forms",
      "forms.publish": "Forms",
      "forms.read": "Forms",
      "forms.write": "Forms",
      "responses.read": "Responses",
      "watches.create": "Watches",
      "watches.delete": "Watches",
      "watches.read": "Watches",
      "watches.renew": "Watches",
    });
    expect(Object.keys(categoriesByName)).not.toContain("forms.body");
    expect(Object.keys(categoriesByName)).not.toContain(
      "forms.responses.readonly",
    );
  });
});
