import { describe, expect, it } from "vitest";

import { findMatchingPermissions } from "../../firewall-rule-matcher";
import { getConnectorFirewall } from "../../firewalls";

const RUNTIME_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;

const STRAVA_RESOURCE_PERMISSIONS = [
  "activities:read",
  "activities:write",
  "athlete_stats:read",
  "clubs:read",
  "gear:read",
  "profile:read",
  "profile:write",
  "routes:read",
  "segment_effort_streams:read",
  "segment_efforts:read",
  "segments:read",
  "segments:write",
  "uploads:write",
] as const;

const STRAVA_REMOVED_OAUTH_SCOPE_GROUPS = [
  "activity:read",
  "activity:read_all",
  "activity:write",
  "profile:read_all",
  "read",
  "read_all",
] as const;

function stravaMatches(method: string, path: string): string[] {
  return findMatchingPermissions(method, path, getConnectorFirewall("strava"), {
    apiBase: "https://www.strava.com",
  });
}

function expectStravaMatches(
  method: string,
  path: string,
  permissionNames: readonly string[],
): void {
  expect([...stravaMatches(method, path)].sort()).toStrictEqual(
    [...permissionNames].sort(),
  );
}

function expandRuntimeRules(rule: string): string[] {
  const spaceIndex = rule.indexOf(" ");
  const method = rule.slice(0, spaceIndex);
  const path = rule.slice(spaceIndex + 1);
  if (method !== "ANY") return [rule];
  return RUNTIME_METHODS.map((runtimeMethod) => {
    return `${runtimeMethod} ${path}`;
  });
}

describe("strava firewall", () => {
  it("replaces broad OAuth scope groups with vm0 resource permissions", () => {
    const permissions = new Set(
      getConnectorFirewall("strava").apis.flatMap((api) => {
        return (api.permissions ?? []).map((permission) => {
          return permission.name;
        });
      }),
    );

    expect(permissions).toStrictEqual(new Set(STRAVA_RESOURCE_PERMISSIONS));
    for (const oldScopeGroup of STRAVA_REMOVED_OAUTH_SCOPE_GROUPS) {
      expect(permissions.has(oldScopeGroup)).toBe(false);
    }
  });

  it("assigns one permission owner to every runtime route", () => {
    const duplicates: string[] = [];
    for (const api of getConnectorFirewall("strava").apis) {
      const owners = new Map<string, string>();
      for (const permission of api.permissions ?? []) {
        for (const rule of permission.rules) {
          for (const runtimeRule of expandRuntimeRules(rule)) {
            const key = `${api.base} ${runtimeRule}`;
            const existing = owners.get(key);
            if (existing) {
              duplicates.push(`${key}: ${existing}, ${permission.name}`);
              continue;
            }
            owners.set(key, permission.name);
          }
        }
      }
    }

    expect(duplicates).toStrictEqual([]);
  });

  it("maps Strava routes to resource owners", () => {
    expectStravaMatches("GET", "/api/v3/activities/123", ["activities:read"]);
    expectStravaMatches("GET", "/api/v3/activities/123/comments", [
      "activities:read",
    ]);
    expectStravaMatches("GET", "/api/v3/activities/123/streams", [
      "activities:read",
    ]);
    expectStravaMatches("GET", "/api/v3/athlete/activities", [
      "activities:read",
    ]);
    expectStravaMatches("POST", "/api/v3/activities", ["activities:write"]);
    expectStravaMatches("GET", "/api/v3/athlete", ["profile:read"]);
    expectStravaMatches("GET", "/api/v3/athlete/zones", ["profile:read"]);
    expectStravaMatches("PUT", "/api/v3/athlete", ["profile:write"]);
    expectStravaMatches("GET", "/api/v3/athlete/clubs", ["clubs:read"]);
    expectStravaMatches("GET", "/api/v3/clubs/123/activities", ["clubs:read"]);
    expectStravaMatches("GET", "/api/v3/athletes/123/stats", [
      "athlete_stats:read",
    ]);
    expectStravaMatches("GET", "/api/v3/gear/b123", ["gear:read"]);
    expectStravaMatches("GET", "/api/v3/athletes/123/routes", ["routes:read"]);
    expectStravaMatches("GET", "/api/v3/routes/123", ["routes:read"]);
    expectStravaMatches("GET", "/api/v3/routes/123/export_gpx", [
      "routes:read",
    ]);
    expectStravaMatches("GET", "/api/v3/segments/explore", ["segments:read"]);
    expectStravaMatches("GET", "/api/v3/segments/starred", ["segments:read"]);
    expectStravaMatches("GET", "/api/v3/segments/123", ["segments:read"]);
    expectStravaMatches("GET", "/api/v3/segments/123/streams", [
      "segments:read",
    ]);
    expectStravaMatches("PUT", "/api/v3/segments/123/starred", [
      "segments:write",
    ]);
    expectStravaMatches("GET", "/api/v3/segment_efforts", [
      "segment_efforts:read",
    ]);
    expectStravaMatches("GET", "/api/v3/segment_efforts/123", [
      "segment_efforts:read",
    ]);
    expectStravaMatches("GET", "/api/v3/segment_efforts/123/streams", [
      "segment_effort_streams:read",
    ]);
    expectStravaMatches("POST", "/api/v3/uploads", ["uploads:write"]);
    expectStravaMatches("GET", "/api/v3/uploads/123", ["uploads:write"]);
  });
});
