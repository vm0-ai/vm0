import { describe, expect, it } from "vitest";

import { pickStravaPermissionOwners } from "../strava";

describe("pickStravaPermissionOwners", () => {
  it("uses vm0-owned owners for Strava tiered read scopes", () => {
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
  });

  it("keeps official scope owners for routes without overrides", () => {
    expect(
      pickStravaPermissionOwners("POST /api/v3/uploads", [
        "activity:write",
        "activity:write",
      ]),
    ).toStrictEqual(["activity:write"]);
  });

  it("throws when a tiered Strava route's official scopes change", () => {
    expect(() => {
      pickStravaPermissionOwners("GET /api/v3/activities/{id}", [
        "activity:read",
      ]);
    }).toThrow(
      'Strava route "GET /api/v3/activities/{id}" owner override scopes changed',
    );
  });
});
