import { beforeAll, describe, expect, it } from "vitest";
import { fetchSpec } from "../codegen";
import {
  buildYouTubeOfficialRouteKeys,
  YOUTUBE_DISCOVERY_URL,
  YOUTUBE_PERMISSION_MANIFEST,
  validateYouTubePermissionManifest,
  type YouTubeDiscoveryDocument,
  type YouTubeManifestPermission,
} from "../youtube";

async function loadDiscovery(): Promise<YouTubeDiscoveryDocument> {
  const response = await fetchSpec(
    YOUTUBE_DISCOVERY_URL,
    "youtube test discovery document",
  );
  return (await response.json()) as YouTubeDiscoveryDocument;
}

function cloneManifest(): YouTubeManifestPermission[] {
  return YOUTUBE_PERMISSION_MANIFEST.map((permission) => {
    return {
      ...permission,
      routeKeys: [...permission.routeKeys],
    };
  });
}

function manifestPermission(name: string): YouTubeManifestPermission {
  const permission = YOUTUBE_PERMISSION_MANIFEST.find((candidate) => {
    return candidate.name === name;
  });
  if (!permission) {
    throw new Error(`Missing YouTube manifest permission: ${name}`);
  }
  return permission;
}

describe("YouTube permission manifest", () => {
  let officialRouteKeys: Set<string>;

  beforeAll(async () => {
    officialRouteKeys = buildYouTubeOfficialRouteKeys(await loadDiscovery());
  });

  it("matches the official Discovery route set exactly", () => {
    expect(officialRouteKeys.size).toBe(107);

    expect(() => {
      validateYouTubePermissionManifest(
        officialRouteKeys,
        YOUTUBE_PERMISSION_MANIFEST,
      );
    }).not.toThrow();
  });

  it("fails when the manifest contains a route absent from Discovery", () => {
    const manifest = cloneManifest();
    manifest[0] = {
      ...manifest[0]!,
      routeKeys: [...manifest[0]!.routeKeys, "base:GET /v3/bogus"],
    };

    expect(() => {
      validateYouTubePermissionManifest(officialRouteKeys, manifest);
    }).toThrow("Unknown YouTube manifest route keys");
  });

  it("fails when Discovery contains a route missing from the manifest", () => {
    const changedOfficialRoutes = new Set(officialRouteKeys);
    changedOfficialRoutes.add("base:GET /v3/newOfficialRoute");

    expect(() => {
      validateYouTubePermissionManifest(
        changedOfficialRoutes,
        YOUTUBE_PERMISSION_MANIFEST,
      );
    }).toThrow("Missing YouTube manifest route keys");
  });

  it("fails duplicate route assignments", () => {
    const duplicateRoute = "base:GET /v3/videos";
    const manifest = cloneManifest();
    manifest[0] = {
      ...manifest[0]!,
      routeKeys: [...manifest[0]!.routeKeys, duplicateRoute],
    };

    expect(() => {
      validateYouTubePermissionManifest(officialRouteKeys, manifest);
    }).toThrow("Duplicate YouTube manifest route assignments");
  });

  it("keeps normal, upload, and resumable upload video routes together", () => {
    expect(manifestPermission("videos.create").routeKeys).toEqual([
      "base:POST /v3/videos",
      "upload:POST /v3/videos",
      "upload:PUT /v3/videos",
      "resumable-upload:POST /v3/videos",
      "resumable-upload:PUT /v3/videos",
    ]);
    expect(manifestPermission("videos.write").routeKeys).toEqual([
      "base:PUT /v3/videos",
    ]);
    expect(manifestPermission("videos.read").routeKeys).toEqual([
      "base:GET /v3/videos",
    ]);
  });

  it("covers Discovery routes that do not declare OAuth scopes", () => {
    expect(manifestPermission("third-party-links.read").routeKeys).toEqual([
      "base:GET /v3/thirdPartyLinks",
    ]);
    expect(manifestPermission("third-party-links.write").routeKeys).toEqual([
      "base:POST /v3/thirdPartyLinks",
      "base:PUT /v3/thirdPartyLinks",
    ]);
    expect(manifestPermission("comment-threads.write").routeKeys).toContain(
      "base:PUT /v3/commentThreads",
    );
  });

  it("does not expose Google OAuth scope names as permissions", () => {
    const names = YOUTUBE_PERMISSION_MANIFEST.map((permission) => {
      return permission.name;
    });

    expect(names).not.toContain("youtube");
    expect(names).not.toContain("youtube.force-ssl");
    expect(names).not.toContain("youtube.readonly");
    expect(names).not.toContain("youtube.upload");
    expect(
      names.filter((name) => {
        return name.startsWith("youtube.");
      }),
    ).toEqual([]);
  });

  it("groups representative permissions into resource-oriented categories", () => {
    const categoriesByName = Object.fromEntries(
      YOUTUBE_PERMISSION_MANIFEST.map((permission) => {
        return [permission.name, permission.category];
      }),
    );

    expect(categoriesByName).toMatchObject({
      "channel-sections.read": "Channels",
      "videos.create": "Videos",
      "comments.moderate": "Comments & Captions",
      "playlist-items.write": "Playlists",
      "live-broadcasts.control": "Live Streaming",
      "live-chat-messages.read": "Live Chat",
      "subscriptions.read": "Subscriptions",
      "members.read": "Memberships & Monetization",
      "search.read": "Discovery",
      "third-party-links.write": "Third Party Links",
      "tests.create": "Tests",
    });
  });
});
