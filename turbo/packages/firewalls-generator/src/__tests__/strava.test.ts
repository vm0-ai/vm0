import { describe, expect, it } from "vitest";

import { pickStravaPermissionOwners } from "../strava";

describe("pickStravaPermissionOwners", () => {
  it("uses vm0-owned resource owners for Strava routes", () => {
    expect(
      pickStravaPermissionOwners("POST /api/v3/activities", ["activity:write"]),
    ).toStrictEqual(["activities:write"]);

    expect(
      pickStravaPermissionOwners("GET /api/v3/activities/{id}", [
        "activity:read_all",
        "activity:read",
      ]),
    ).toStrictEqual(["activities:read"]);

    expect(
      pickStravaPermissionOwners("GET /api/v3/routes/{id}", [
        "read_all",
        "read",
      ]),
    ).toStrictEqual(["routes:read"]);

    expect(
      pickStravaPermissionOwners("GET /api/v3/segments/{id}", [
        "read",
        "read_all",
      ]),
    ).toStrictEqual(["segments:read"]);

    expect(
      pickStravaPermissionOwners("GET /api/v3/athlete", [
        "profile:read_all",
        "read",
      ]),
    ).toStrictEqual(["profile:read"]);

    expect(
      pickStravaPermissionOwners("GET /api/v3/athlete/zones", [
        "profile:read_all",
      ]),
    ).toStrictEqual(["profile:read"]);

    expect(
      pickStravaPermissionOwners("GET /api/v3/athlete/clubs", ["read"]),
    ).toStrictEqual(["clubs:read"]);

    expect(
      pickStravaPermissionOwners("GET /api/v3/segment_efforts/{id}/streams", [
        "read_all",
      ]),
    ).toStrictEqual(["segment_effort_streams:read"]);

    expect(
      pickStravaPermissionOwners("POST /api/v3/uploads", [
        "activity:write",
        "activity:write",
      ]),
    ).toStrictEqual(["uploads:write"]);

    expect(
      pickStravaPermissionOwners("PUT /api/v3/segments/{id}/starred", [
        "profile:write",
      ]),
    ).toStrictEqual(["segments:write"]);
  });

  it("throws when a Strava route's official scopes change", () => {
    expect(() => {
      pickStravaPermissionOwners("GET /api/v3/activities/{id}", [
        "activity:read",
      ]);
    }).toThrow(
      'Strava route "GET /api/v3/activities/{id}" owner override scopes changed',
    );
  });

  it("throws when a Strava route has no vm0 permission owner", () => {
    expect(() => {
      pickStravaPermissionOwners("GET /api/v3/new_official_route", ["read"]);
    }).toThrow(
      'Strava route "GET /api/v3/new_official_route" has no vm0 permission owner',
    );
  });
});
