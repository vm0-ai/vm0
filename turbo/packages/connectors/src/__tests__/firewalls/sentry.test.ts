import { beforeAll, describe, expect, it } from "vitest";

import { findMatchingPermissions } from "../../firewall-rule-matcher";
import type { FirewallConfig } from "../../firewall-types";
import { loadRequiredConnectorFirewall } from "../firewall-test-helpers";

const RUNTIME_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;

let firewall: FirewallConfig;

function sentryPermissionRules(permissionName: string): readonly string[] {
  const permission = firewall.apis
    .flatMap((api) => {
      return api.permissions ?? [];
    })
    .find((candidate) => {
      return candidate.name === permissionName;
    });

  if (!permission) {
    throw new Error(`Missing Sentry permission "${permissionName}"`);
  }
  return permission.rules;
}

function sentryMatches(method: string, path: string): string[] {
  return findMatchingPermissions(method, path, firewall);
}

function expectSentryMatches(
  method: string,
  path: string,
  permissionNames: readonly string[],
): void {
  expect([...sentryMatches(method, path)].sort()).toStrictEqual(
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

describe("sentry firewall", () => {
  beforeAll(async () => {
    firewall = await loadRequiredConnectorFirewall("sentry");
  });

  it("assigns one permission owner to every runtime route", () => {
    const duplicates: string[] = [];
    for (const api of firewall.apis) {
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

  it("keeps read permissions non-mutating", () => {
    for (const permission of firewall.apis.flatMap((api) => {
      return api.permissions ?? [];
    })) {
      if (!permission.name.endsWith(":read")) continue;

      const mutatingRules = permission.rules.filter((rule) => {
        return !rule.startsWith("GET ") && !rule.startsWith("HEAD ");
      });
      expect(mutatingRules, permission.name).toEqual([]);
    }
  });

  it("maps member mutations according to Sentry's official method scopes", () => {
    expectSentryMatches("DELETE", "/api/0/organizations/acme/members/123/", [
      "member:admin",
    ]);
    expectSentryMatches(
      "PUT",
      "/api/0/organizations/acme/members/123/teams/team-a/",
      ["team:write"],
    );
  });

  it("maps project mutations according to Sentry's official method scopes", () => {
    expectSentryMatches("POST", "/api/0/organizations/acme/projects/", [
      "project:write",
    ]);
    expectSentryMatches("PUT", "/api/0/projects/acme/web/ownership/", [
      "project:write",
    ]);
  });

  it("maps issue and event routes to the least privileged event scope", () => {
    expectSentryMatches("GET", "/api/0/organizations/acme/issues/", [
      "event:read",
    ]);
    expectSentryMatches("PUT", "/api/0/organizations/acme/issues/", [
      "event:write",
    ]);
    expectSentryMatches("DELETE", "/api/0/organizations/acme/issues/", [
      "event:admin",
    ]);
  });

  it("maps monitor routes to alerts scopes instead of broad org/project scopes", () => {
    expectSentryMatches("GET", "/api/0/organizations/acme/detectors/", [
      "alerts:read",
    ]);
    expectSentryMatches("PUT", "/api/0/organizations/acme/detectors/", [
      "alerts:write",
    ]);
    expectSentryMatches(
      "GET",
      "/api/0/organizations/acme/monitors/my-monitor/",
      ["alerts:read"],
    );
    expectSentryMatches(
      "PUT",
      "/api/0/organizations/acme/monitors/my-monitor/",
      ["alerts:write"],
    );
  });

  it("preserves Sentry's release and CI custom scopes", () => {
    expect(sentryPermissionRules("project:releases")).toContain(
      "POST /api/0/organizations/{organization_id_or_slug}/releases/",
    );
    expect(sentryPermissionRules("org:ci")).toContain(
      "GET /api/0/projects/{organization_id_or_slug}/{project_id_or_slug}/files/dsyms/",
    );
    expectSentryMatches("POST", "/api/0/organizations/acme/releases/", [
      "project:releases",
    ]);
    expectSentryMatches("GET", "/api/0/projects/acme/web/files/dsyms/", [
      "org:ci",
    ]);
  });
});
