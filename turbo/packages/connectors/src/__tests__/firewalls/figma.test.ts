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

function figmaMatches(method: string, path: string): string[] {
  return findMatchingPermissions(method, path, firewall);
}

function expectFigmaMatches(
  method: string,
  path: string,
  permissionNames: readonly string[],
): void {
  expect([...figmaMatches(method, path)].sort()).toStrictEqual(
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

describe("figma firewall", () => {
  beforeAll(async () => {
    firewall = await loadRequiredConnectorFirewall("figma");
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

  it("maps deprecated files:read overlaps to granular permissions", () => {
    expectFigmaMatches("GET", "/v1/files/file-key", ["file_content:read"]);
    expectFigmaMatches("GET", "/v1/files/file-key/images", [
      "file_content:read",
    ]);
    expectFigmaMatches("GET", "/v1/files/file-key/meta", [
      "file_metadata:read",
    ]);
    expectFigmaMatches("GET", "/v1/files/file-key/comments", [
      "file_comments:read",
    ]);
    expectFigmaMatches("GET", "/v1/projects/project-id/files", [
      "projects:read",
    ]);
    expectFigmaMatches("GET", "/v2/webhooks/webhook-id", ["webhooks:read"]);
  });
});
