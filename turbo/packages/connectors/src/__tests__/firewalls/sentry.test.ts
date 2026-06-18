import { describe, expect, it } from "vitest";

import { findMatchingPermissions } from "../../firewall-rule-matcher";
import { getConnectorFirewall } from "../../firewalls";

function sentryPermissionRules(permissionName: string): readonly string[] {
  const firewall = getConnectorFirewall("sentry");
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

function expectSentryMatchesContaining(
  method: string,
  path: string,
  includedPermissionNames: readonly string[],
  excludedPermissionNames: readonly string[],
): void {
  const matches = findMatchingPermissions(
    method,
    path,
    getConnectorFirewall("sentry"),
  );

  for (const permissionName of includedPermissionNames) {
    expect(matches).toContain(permissionName);
  }
  for (const permissionName of excludedPermissionNames) {
    expect(matches).not.toContain(permissionName);
  }
}

describe("sentry firewall", () => {
  it("keeps read permissions non-mutating", () => {
    const firewall = getConnectorFirewall("sentry");

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
    expectSentryMatchesContaining(
      "DELETE",
      "/api/0/organizations/acme/members/123/",
      ["member:admin"],
      ["member:read", "member:write"],
    );
    expectSentryMatchesContaining(
      "PUT",
      "/api/0/organizations/acme/members/123/teams/team-a/",
      [
        "member:admin",
        "member:write",
        "org:admin",
        "org:write",
        "team:admin",
        "team:write",
      ],
      ["member:read", "org:read", "team:read"],
    );
  });

  it("maps project mutations according to Sentry's official method scopes", () => {
    expectSentryMatchesContaining(
      "POST",
      "/api/0/organizations/acme/projects/",
      ["project:admin", "project:write"],
      ["project:read"],
    );
    expectSentryMatchesContaining(
      "PUT",
      "/api/0/projects/acme/web/ownership/",
      ["project:admin", "project:write"],
      ["project:read"],
    );
  });

  it("preserves Sentry's project:releases exception", () => {
    expect(sentryPermissionRules("project:releases")).toContain(
      "POST /api/0/organizations/{organization_id_or_slug}/releases/",
    );
    expectSentryMatchesContaining(
      "POST",
      "/api/0/organizations/acme/releases/",
      ["project:releases"],
      ["project:read", "project:write", "project:admin"],
    );
  });
});
