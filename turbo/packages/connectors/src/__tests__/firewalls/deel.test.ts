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

function deelMatches(method: string, path: string): string[] {
  return findMatchingPermissions(method, path, firewall);
}

function expectDeelMatches(
  method: string,
  path: string,
  permissionNames: readonly string[],
): void {
  expect([...deelMatches(method, path)].sort()).toStrictEqual(
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

describe("deel firewall", () => {
  beforeAll(async () => {
    firewall = await loadRequiredConnectorFirewall("deel");
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

  it("maps legal entity mutations to legal entity write permission", () => {
    expectDeelMatches("POST", "/rest/v2/legal-entities", [
      "legal-entity:write",
    ]);
    expectDeelMatches("PATCH", "/rest/v2/legal-entities/123", [
      "legal-entity:write",
    ]);
    expectDeelMatches("DELETE", "/rest/v2/legal-entities/123", [
      "legal-entity:write",
    ]);
  });

  it("maps read/write alternatives by method", () => {
    expectDeelMatches("GET", "/rest/v2/payouts/contractors/methods", [
      "worker:read",
    ]);
    expectDeelMatches("POST", "/rest/v2/payouts/contractors/methods", [
      "worker:write",
    ]);
  });

  it("requires auth write for magic link creation", () => {
    expectDeelMatches("POST", "/rest/v2/magic-link", ["auth:write"]);
    expectDeelMatches("POST", "/rest/v2/managers/magic-links", ["auth:write"]);
  });

  it("maps cross-resource alternatives to the route resource owner", () => {
    expectDeelMatches("GET", "/rest/v2/legal-entities", ["organizations:read"]);
    expectDeelMatches("GET", "/rest/v2/people/me", ["people:read"]);
    expectDeelMatches("GET", "/rest/v2/screenings/verification-method", [
      "screenings:read",
    ]);
    expectDeelMatches("POST", "/rest/v2/time_offs", ["time-off:write"]);
  });
});
