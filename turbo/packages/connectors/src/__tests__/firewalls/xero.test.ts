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

function xeroMatches(apiBase: string, method: string, path: string): string[] {
  return findMatchingPermissions(method, path, firewall, {
    apiBase,
  });
}

function expectXeroMatches(
  apiBase: string,
  method: string,
  path: string,
  permissionNames: readonly string[],
): void {
  expect([...xeroMatches(apiBase, method, path)].sort()).toStrictEqual(
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

describe("xero firewall", () => {
  beforeAll(async () => {
    firewall = await loadRequiredConnectorFirewall("xero");
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

  it("maps accounting read routes to read permissions", () => {
    const accountingBase = "https://api.xero.com/api.xro/2.0";

    expectXeroMatches(accountingBase, "GET", "/Accounts", [
      "accounting.settings.read",
    ]);
    expectXeroMatches(
      accountingBase,
      "GET",
      "/Accounts/account-id/Attachments",
      ["accounting.attachments.read"],
    );
    expectXeroMatches(accountingBase, "GET", "/Reports/TenNinetyNine", [
      "accounting.reports.tenninetynine.read",
    ]);
  });

  it("maps mutating routes to write-capable permissions", () => {
    const accountingBase = "https://api.xero.com/api.xro/2.0";

    expectXeroMatches(accountingBase, "PUT", "/Accounts", [
      "accounting.settings",
    ]);
    expectXeroMatches(
      accountingBase,
      "PUT",
      "/Accounts/account-id/Attachments/file.pdf",
      ["accounting.attachments"],
    );
  });

  it("maps Files API read and mutating routes separately", () => {
    const filesBase = "https://api.xero.com/files.xro/1.0";

    expectXeroMatches(filesBase, "GET", "/Files", ["files.read"]);
    expectXeroMatches(filesBase, "POST", "/Files", ["files"]);
  });
});
