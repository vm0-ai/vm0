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

function vercelMatches(method: string, path: string): string[] {
  return findMatchingPermissions(method, path, firewall);
}

function expectVercelMatches(
  method: string,
  path: string,
  permissionNames: readonly string[],
): void {
  expect([...vercelMatches(method, path)].sort()).toStrictEqual(
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

describe("vercel firewall", () => {
  beforeAll(async () => {
    firewall = await loadRequiredConnectorFirewall("vercel");
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

  it("maps deployment integration actions to integrations write", () => {
    expectVercelMatches(
      "PATCH",
      "/v1/deployments/dpl_123/integrations/icfg_123/resources/res_123/actions/restart",
      ["integrations:write"],
    );
  });

  it("maps shared connect links to static IPs write", () => {
    expectVercelMatches(
      "PATCH",
      "/v1/projects/project-a/shared-connect-links",
      ["static-ips:write"],
    );
  });
});
