import { describe, expect, it } from "vitest";

import { findMatchingPermissions } from "../../firewall-rule-matcher";
import {
  getConnectorFirewall,
  getDefaultFirewallPolicies,
} from "../../firewalls";

const RUNTIME_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;

function clerkMatches(method: string, path: string): string[] {
  return findMatchingPermissions(method, path, getConnectorFirewall("clerk"));
}

function expectClerkMatches(
  method: string,
  path: string,
  permissionNames: readonly string[],
): void {
  expect([...clerkMatches(method, path)].sort()).toStrictEqual(
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

describe("clerk firewall", () => {
  it("assigns one permission owner to every runtime route", () => {
    const duplicates: string[] = [];
    for (const api of getConnectorFirewall("clerk").apis) {
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

  it("maps nested user billing routes to billing permissions", () => {
    expectClerkMatches("GET", "/v1/users/user_123/billing/credits", [
      "billing:read",
    ]);
    expectClerkMatches("GET", "/v1/users/user_123/billing/subscription", [
      "billing:read",
    ]);
    expectClerkMatches("POST", "/v1/users/user_123/billing/credits", [
      "billing:write",
    ]);
  });

  it("maps nested organization billing routes to billing permissions", () => {
    expectClerkMatches("GET", "/v1/organizations/org_123/billing/credits", [
      "billing:read",
    ]);
    expectClerkMatches(
      "GET",
      "/v1/organizations/org_123/billing/subscription",
      ["billing:read"],
    );
    expectClerkMatches("POST", "/v1/organizations/org_123/billing/credits", [
      "billing:write",
    ]);
  });

  it("keeps billing writes default denied as admin operations", () => {
    const policies = getDefaultFirewallPolicies("clerk").policies;

    expect(policies["billing:read"]).toBe("allow");
    expect(policies["billing:write"]).toBe("deny");
    expect(policies["users:write"]).toBe("deny");
    expect(policies["organizations:write"]).toBe("deny");
  });
});
