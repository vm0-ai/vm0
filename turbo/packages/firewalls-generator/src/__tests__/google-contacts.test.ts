import { beforeAll, describe, expect, it } from "vitest";
import { fetchSpec } from "../codegen";
import {
  buildGoogleContactsOfficialRouteKeys,
  GOOGLE_CONTACTS_DISCOVERY_URL,
  GOOGLE_CONTACTS_PERMISSION_MANIFEST,
  validateGoogleContactsPermissionManifest,
  type GoogleContactsDiscoveryDocument,
  type GoogleContactsManifestPermission,
} from "../google-contacts";

async function loadDiscovery(): Promise<GoogleContactsDiscoveryDocument> {
  const response = await fetchSpec(
    GOOGLE_CONTACTS_DISCOVERY_URL,
    "google-contacts test discovery document",
  );
  return (await response.json()) as GoogleContactsDiscoveryDocument;
}

function cloneManifest(): GoogleContactsManifestPermission[] {
  return GOOGLE_CONTACTS_PERMISSION_MANIFEST.map((permission) => ({
    ...permission,
    routeKeys: [...permission.routeKeys],
  }));
}

function manifestPermission(name: string): GoogleContactsManifestPermission {
  const permission = GOOGLE_CONTACTS_PERMISSION_MANIFEST.find(
    (candidate) => candidate.name === name,
  );
  if (!permission) {
    throw new Error(`Missing Google Contacts manifest permission: ${name}`);
  }
  return permission;
}

describe("Google Contacts permission manifest", () => {
  let officialRouteKeys: Set<string>;

  beforeAll(async () => {
    officialRouteKeys = buildGoogleContactsOfficialRouteKeys(
      await loadDiscovery(),
    );
  });

  it("matches the official Discovery route set exactly", () => {
    expect(officialRouteKeys.size).toBe(24);
    expect(() => {
      validateGoogleContactsPermissionManifest(
        officialRouteKeys,
        GOOGLE_CONTACTS_PERMISSION_MANIFEST,
      );
    }).not.toThrow();
  });

  it("rejects unknown, missing, and duplicate routes", () => {
    const unknownManifest = cloneManifest();
    unknownManifest[0] = {
      ...unknownManifest[0]!,
      routeKeys: [
        ...unknownManifest[0]!.routeKeys,
        "base:GET /v1/people/bogus",
      ],
    };
    expect(() => {
      validateGoogleContactsPermissionManifest(
        officialRouteKeys,
        unknownManifest,
      );
    }).toThrow("Unknown Google Contacts manifest route keys");

    const changedOfficialRoutes = new Set(officialRouteKeys);
    changedOfficialRoutes.add("base:GET /v1/people:newOfficialRoute");
    expect(() => {
      validateGoogleContactsPermissionManifest(
        changedOfficialRoutes,
        GOOGLE_CONTACTS_PERMISSION_MANIFEST,
      );
    }).toThrow("Missing Google Contacts manifest route keys");

    const duplicateManifest = cloneManifest();
    duplicateManifest[1] = {
      ...duplicateManifest[1]!,
      routeKeys: [
        ...duplicateManifest[1]!.routeKeys,
        "base:GET /v1/people/{peopleId}",
      ],
    };
    expect(() => {
      validateGoogleContactsPermissionManifest(
        officialRouteKeys,
        duplicateManifest,
      );
    }).toThrow("Duplicate Google Contacts manifest route assignments");
  });

  it("keeps contact reads and mutations separate", () => {
    expect(manifestPermission("contacts.read").routeKeys).toEqual([
      "base:GET /v1/people/{peopleId}",
      "base:GET /v1/people:batchGet",
      "base:GET /v1/people/{peopleId}/connections",
      "base:GET /v1/people:searchContacts",
    ]);
    expect(manifestPermission("contacts.create").routeKeys).toEqual([
      "base:POST /v1/people:createContact",
      "base:POST /v1/people:batchCreateContacts",
    ]);
    expect(manifestPermission("contacts.update").routeKeys).toEqual([
      "base:PATCH /v1/people/{peopleId}:updateContact",
      "base:POST /v1/people:batchUpdateContacts",
    ]);
    expect(manifestPermission("contacts.delete").routeKeys).toEqual([
      "base:DELETE /v1/people/{peopleId}:deleteContact",
      "base:POST /v1/people:batchDeleteContacts",
    ]);
  });

  it("uses resource-oriented categories instead of OAuth scope names", () => {
    const categoriesByName = Object.fromEntries(
      GOOGLE_CONTACTS_PERMISSION_MANIFEST.map((permission) => [
        permission.name,
        permission.category,
      ]),
    );
    expect(categoriesByName).toEqual({
      "contact-groups.create": "Contact Groups",
      "contact-groups.delete": "Contact Groups",
      "contact-groups.read": "Contact Groups",
      "contact-groups.update": "Contact Groups",
      "contact-photos.write": "Contacts",
      "contacts.create": "Contacts",
      "contacts.delete": "Contacts",
      "contacts.read": "Contacts",
      "contacts.update": "Contacts",
      "directory.read": "Directory",
      "other-contacts.copy": "Other Contacts",
      "other-contacts.read": "Other Contacts",
    });
    expect(Object.keys(categoriesByName)).not.toContain("contacts");
    expect(Object.keys(categoriesByName)).not.toContain("contacts.readonly");
  });
});
