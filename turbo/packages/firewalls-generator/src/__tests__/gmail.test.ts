import { beforeAll, describe, expect, it } from "vitest";
import { fetchSpec } from "../codegen";
import {
  buildGmailOfficialRouteKeys,
  GMAIL_DISCOVERY_URL,
  GMAIL_PERMISSION_MANIFEST,
  validateGmailPermissionManifest,
  type GmailDiscoveryDocument,
  type GmailManifestPermission,
} from "../gmail";

async function loadDiscovery(): Promise<GmailDiscoveryDocument> {
  const response = await fetchSpec(
    GMAIL_DISCOVERY_URL,
    "gmail test discovery document",
  );
  return (await response.json()) as GmailDiscoveryDocument;
}

function cloneManifest(): GmailManifestPermission[] {
  return GMAIL_PERMISSION_MANIFEST.map((permission) => {
    return {
      ...permission,
      routeKeys: [...permission.routeKeys],
    };
  });
}

function manifestPermission(name: string): GmailManifestPermission {
  const permission = GMAIL_PERMISSION_MANIFEST.find((candidate) => {
    return candidate.name === name;
  });
  if (!permission) {
    throw new Error(`Missing Gmail manifest permission: ${name}`);
  }
  return permission;
}

describe("Gmail permission manifest", () => {
  let officialRouteKeys: Set<string>;

  beforeAll(async () => {
    officialRouteKeys = buildGmailOfficialRouteKeys(await loadDiscovery());
  });

  it("matches the official Discovery route set exactly", () => {
    expect(officialRouteKeys.size).toBe(91);

    expect(() => {
      validateGmailPermissionManifest(
        officialRouteKeys,
        GMAIL_PERMISSION_MANIFEST,
      );
    }).not.toThrow();
  });

  it("fails when the manifest contains a route absent from Discovery", () => {
    const manifest = cloneManifest();
    manifest[0] = {
      ...manifest[0]!,
      routeKeys: [
        ...manifest[0]!.routeKeys,
        "base:GET /v1/users/{userId}/bogus",
      ],
    };

    expect(() => {
      validateGmailPermissionManifest(officialRouteKeys, manifest);
    }).toThrow("Unknown Gmail manifest route keys");
  });

  it("fails when Discovery contains a route missing from the manifest", () => {
    const changedOfficialRoutes = new Set(officialRouteKeys);
    changedOfficialRoutes.add("base:GET /v1/users/{userId}/new-official-route");

    expect(() => {
      validateGmailPermissionManifest(
        changedOfficialRoutes,
        GMAIL_PERMISSION_MANIFEST,
      );
    }).toThrow("Missing Gmail manifest route keys");
  });

  it("derives upload route keys from Discovery media upload protocol paths", () => {
    const routeKeys = buildGmailOfficialRouteKeys({
      version: "test",
      resources: {
        users: {
          resources: {
            messages: {
              methods: {
                insert: {
                  id: "gmail.users.messages.insert",
                  httpMethod: "POST",
                  path: "gmail/v1/users/{userId}/messages",
                  supportsMediaUpload: true,
                  mediaUpload: {
                    protocols: {
                      simple: {
                        path: "/upload/gmail/v1/users/{userId}/messages",
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(routeKeys).toEqual(
      new Set([
        "base:POST /v1/users/{userId}/messages",
        "upload:POST /v1/users/{userId}/messages",
      ]),
    );
  });

  it("fails duplicate route assignments", () => {
    const duplicateRoute = "base:GET /v1/users/{userId}/profile";
    const manifest = cloneManifest();
    manifest[1] = {
      ...manifest[1]!,
      routeKeys: [...manifest[1]!.routeKeys, duplicateRoute],
    };

    expect(() => {
      validateGmailPermissionManifest(officialRouteKeys, manifest);
    }).toThrow("Duplicate Gmail manifest route assignments");
  });

  it("keeps direct send endpoints separate from draft writes", () => {
    const draftsWrite = manifestPermission("drafts.write");
    const draftsSend = manifestPermission("drafts.send");
    const messagesSend = manifestPermission("messages.send");

    expect(draftsWrite.routeKeys).toContain(
      "upload:POST /v1/users/{userId}/drafts",
    );
    expect(draftsWrite.routeKeys).not.toContain(
      "base:POST /v1/users/{userId}/drafts/send",
    );
    expect(draftsSend.routeKeys).toEqual([
      "base:POST /v1/users/{userId}/drafts/send",
      "resumable-upload:POST /v1/users/{userId}/drafts/send",
      "upload:POST /v1/users/{userId}/drafts/send",
    ]);
    expect(messagesSend.routeKeys).toEqual([
      "base:POST /v1/users/{userId}/messages/send",
      "resumable-upload:POST /v1/users/{userId}/messages/send",
      "upload:POST /v1/users/{userId}/messages/send",
    ]);
  });

  it("does not expose Google OAuth scope names as permissions", () => {
    const names = GMAIL_PERMISSION_MANIFEST.map((permission) => {
      return permission.name;
    });

    expect(names).not.toContain("gmail.send");
    expect(names).not.toContain("gmail.modify");
    expect(names).not.toContain("gmail.readonly");
    expect(
      names.every((name) => {
        return !name.startsWith("gmail.");
      }),
    ).toBe(true);
  });

  it("groups every permission into a resource-oriented category", () => {
    const categoriesByName = Object.fromEntries(
      GMAIL_PERMISSION_MANIFEST.map((permission) => {
        return [permission.name, permission.category];
      }),
    );

    expect(categoriesByName).toEqual({
      "drafts.read": "Drafts",
      "drafts.send": "Drafts",
      "drafts.write": "Drafts",
      "history.read": "Mailbox",
      "labels.read": "Labels",
      "labels.write": "Labels",
      "messages.delete": "Messages",
      "messages.read": "Messages",
      "messages.send": "Messages",
      "messages.write": "Messages",
      "notifications.write": "Notifications",
      "profile.read": "Mailbox",
      "settings.read": "Settings",
      "settings.sharing": "Settings",
      "settings.write": "Settings",
      "threads.delete": "Threads",
      "threads.read": "Threads",
      "threads.write": "Threads",
    });
  });
});
