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

  it("maps tiered Strava activity routes to one vm0-owned permission", () => {
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
  });

  it("maps tiered Strava route, segment, and profile routes to one owner", () => {
    expectStravaMatches("GET", "/api/v3/athlete", ["profile:read"]);
    expectStravaMatches("GET", "/api/v3/athletes/123/routes", ["routes:read"]);
    expectStravaMatches("GET", "/api/v3/routes/123", ["routes:read"]);
    expectStravaMatches("GET", "/api/v3/routes/123/export_gpx", [
      "routes:read",
    ]);
    expectStravaMatches("GET", "/api/v3/segments/starred", ["segments:read"]);
    expectStravaMatches("GET", "/api/v3/segments/123", ["segments:read"]);
    expectStravaMatches("GET", "/api/v3/segments/123/streams", [
      "segments:read",
    ]);
  });

  it("keeps non-overlapping official Strava scopes as route owners", () => {
    expectStravaMatches("GET", "/api/v3/athlete/zones", ["profile:read_all"]);
    expectStravaMatches("GET", "/api/v3/athlete/clubs", ["read"]);
    expectStravaMatches("GET", "/api/v3/segment_efforts/123/streams", [
      "read_all",
    ]);
    expectStravaMatches("POST", "/api/v3/uploads", ["activity:write"]);
    expectStravaMatches("PUT", "/api/v3/athlete", ["profile:write"]);
  });
});
