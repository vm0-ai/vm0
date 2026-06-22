import { beforeAll, describe, expect, it } from "vitest";
import { fetchSpec } from "../codegen";
import {
  buildGoogleMeetOfficialRouteKeys,
  GOOGLE_MEET_DISCOVERY_URL,
  GOOGLE_MEET_PERMISSION_MANIFEST,
  validateGoogleMeetPermissionManifest,
  type GoogleMeetDiscoveryDocument,
  type GoogleMeetManifestPermission,
} from "../google-meet";

async function loadDiscovery(): Promise<GoogleMeetDiscoveryDocument> {
  const response = await fetchSpec(
    GOOGLE_MEET_DISCOVERY_URL,
    "google-meet test discovery document",
  );
  return (await response.json()) as GoogleMeetDiscoveryDocument;
}

function cloneManifest(): GoogleMeetManifestPermission[] {
  return GOOGLE_MEET_PERMISSION_MANIFEST.map((permission) => {
    return {
      ...permission,
      routeKeys: [...permission.routeKeys],
    };
  });
}

function manifestPermission(name: string): GoogleMeetManifestPermission {
  const permission = GOOGLE_MEET_PERMISSION_MANIFEST.find((candidate) => {
    return candidate.name === name;
  });
  if (!permission) {
    throw new Error(`Missing Google Meet manifest permission: ${name}`);
  }
  return permission;
}

describe("Google Meet permission manifest", () => {
  let officialRouteKeys: Set<string>;

  beforeAll(async () => {
    officialRouteKeys = buildGoogleMeetOfficialRouteKeys(await loadDiscovery());
  });

  it("matches the official Discovery route set exactly", () => {
    expect(officialRouteKeys.size).toBe(18);

    expect(() => {
      validateGoogleMeetPermissionManifest(
        officialRouteKeys,
        GOOGLE_MEET_PERMISSION_MANIFEST,
      );
    }).not.toThrow();
  });

  it("uses flat Discovery paths instead of ambiguous name templates", () => {
    expect(officialRouteKeys).toContain("base:GET /v2/spaces/{spacesId}");
    expect(officialRouteKeys).toContain(
      "base:GET /v2/conferenceRecords/{conferenceRecordsId}",
    );
    expect(officialRouteKeys).not.toContain("base:GET /v2/{+name}");
  });

  it("fails when the manifest contains a route absent from Discovery", () => {
    const manifest = cloneManifest();
    manifest[0] = {
      ...manifest[0]!,
      routeKeys: [
        ...manifest[0]!.routeKeys,
        "base:GET /v2/spaces/{spacesId}/bogus",
      ],
    };

    expect(() => {
      validateGoogleMeetPermissionManifest(officialRouteKeys, manifest);
    }).toThrow("Unknown Google Meet manifest route keys");
  });

  it("fails when Discovery contains a route missing from the manifest", () => {
    const changedOfficialRoutes = new Set(officialRouteKeys);
    changedOfficialRoutes.add("base:DELETE /v2/spaces/{spacesId}");

    expect(() => {
      validateGoogleMeetPermissionManifest(
        changedOfficialRoutes,
        GOOGLE_MEET_PERMISSION_MANIFEST,
      );
    }).toThrow("Missing Google Meet manifest route keys");
  });

  it("fails duplicate route assignments", () => {
    const duplicateRoute = "base:GET /v2/spaces/{spacesId}";
    const manifest = cloneManifest();
    manifest[0] = {
      ...manifest[0]!,
      routeKeys: [...manifest[0]!.routeKeys, duplicateRoute],
    };

    expect(() => {
      validateGoogleMeetPermissionManifest(officialRouteKeys, manifest);
    }).toThrow("Duplicate Google Meet manifest route assignments");
  });

  it("keeps space creation, reads, updates, and conference end separate", () => {
    expect(manifestPermission("spaces.create").routeKeys).toEqual([
      "base:POST /v2/spaces",
    ]);
    expect(manifestPermission("spaces.read").routeKeys).toEqual([
      "base:GET /v2/spaces/{spacesId}",
    ]);
    expect(manifestPermission("spaces.write").routeKeys).toEqual([
      "base:PATCH /v2/spaces/{spacesId}",
    ]);
    expect(
      manifestPermission("spaces.end-active-conference").routeKeys,
    ).toEqual(["base:POST /v2/spaces/{spacesId}:endActiveConference"]);
  });

  it("keeps meeting artifacts in dedicated read permissions", () => {
    expect(manifestPermission("recordings.read").routeKeys).toEqual([
      "base:GET /v2/conferenceRecords/{conferenceRecordsId}/recordings",
      "base:GET /v2/conferenceRecords/{conferenceRecordsId}/recordings/{recordingsId}",
    ]);
    expect(manifestPermission("smart-notes.read").routeKeys).toEqual([
      "base:GET /v2/conferenceRecords/{conferenceRecordsId}/smartNotes",
      "base:GET /v2/conferenceRecords/{conferenceRecordsId}/smartNotes/{smartNotesId}",
    ]);
    expect(manifestPermission("transcripts.read").routeKeys).toEqual([
      "base:GET /v2/conferenceRecords/{conferenceRecordsId}/transcripts",
      "base:GET /v2/conferenceRecords/{conferenceRecordsId}/transcripts/{transcriptsId}",
    ]);
    expect(manifestPermission("transcript-entries.read").routeKeys).toEqual([
      "base:GET /v2/conferenceRecords/{conferenceRecordsId}/transcripts/{transcriptsId}/entries",
      "base:GET /v2/conferenceRecords/{conferenceRecordsId}/transcripts/{transcriptsId}/entries/{entriesId}",
    ]);
  });

  it("does not expose Google OAuth scope names as permissions", () => {
    const names = GOOGLE_MEET_PERMISSION_MANIFEST.map((permission) => {
      return permission.name;
    });

    expect(names).not.toContain("meetings.space.created");
    expect(names).not.toContain("meetings.space.readonly");
    expect(names).not.toContain("meetings.space.settings");
    expect(
      names.every((name) => {
        return !name.startsWith("meetings.");
      }),
    ).toBe(true);
  });

  it("groups every permission into a resource-oriented category", () => {
    const categoriesByName = Object.fromEntries(
      GOOGLE_MEET_PERMISSION_MANIFEST.map((permission) => {
        return [permission.name, permission.category];
      }),
    );

    expect(categoriesByName).toEqual({
      "conference-records.read": "Conference Records",
      "participant-sessions.read": "Participants",
      "participants.read": "Participants",
      "recordings.read": "Recordings",
      "smart-notes.read": "Smart Notes",
      "spaces.create": "Spaces",
      "spaces.end-active-conference": "Spaces",
      "spaces.read": "Spaces",
      "spaces.write": "Spaces",
      "transcript-entries.read": "Transcripts",
      "transcripts.read": "Transcripts",
    });
  });
});
