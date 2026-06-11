import { describe, expect, it } from "vitest";

import { findMatchingPermissions } from "../../firewall-rule-matcher";
import { extractSecretNamesFromApis } from "../../firewall-types";
import {
  getConnectorFirewall,
  getDefaultFirewallPolicies,
  isFirewallConnectorType,
} from "../../firewalls/index";
import {
  cloudflareCategories,
  cloudflareCategoryOrder,
  cloudflareDefaultAllowed,
  cloudflareGenerationStats,
} from "../../firewalls/cloudflare.generated";

function getCloudflarePermission(name: string) {
  const firewall = getConnectorFirewall("cloudflare");
  const permission = firewall.apis
    .flatMap((api) => {
      return api.permissions ?? [];
    })
    .find((candidate) => {
      return candidate.name === name;
    });

  if (!permission) {
    throw new Error(`Missing Cloudflare permission "${name}"`);
  }
  return permission;
}

function expectCloudflareRule(permissionName: string, rule: string): void {
  const permission = getCloudflarePermission(permissionName);
  expect(permission.rules).toContain(rule);
}

function expectCloudflareMatches(
  method: string,
  path: string,
  permissionNames: readonly string[],
): void {
  const matches = findMatchingPermissions(
    method,
    path,
    getConnectorFirewall("cloudflare"),
  );
  expect([...matches].sort()).toStrictEqual([...permissionNames].sort());
}

function expectCloudflareMatchesContaining(
  method: string,
  path: string,
  includedPermissionNames: readonly string[],
  excludedPermissionNames: readonly string[],
): void {
  const matches = findMatchingPermissions(
    method,
    path,
    getConnectorFirewall("cloudflare"),
  );

  for (const permissionName of includedPermissionNames) {
    expect(matches).toContain(permissionName);
  }
  for (const permissionName of excludedPermissionNames) {
    expect(matches).not.toContain(permissionName);
  }
}

describe("cloudflare firewall", () => {
  it("registers the Cloudflare firewall with API token auth", () => {
    expect(isFirewallConnectorType("cloudflare")).toBe(true);
    const firewall = getConnectorFirewall("cloudflare");

    expect(firewall.name).toBe("cloudflare");
    expect(firewall.apis).toHaveLength(1);
    expect(firewall.apis[0]).toMatchObject({
      base: "https://api.cloudflare.com/client/v4",
      auth: {
        headers: {
          Authorization: "Bearer ${{ secrets.CLOUDFLARE_TOKEN }}",
        },
      },
    });
    expect(extractSecretNamesFromApis([...firewall.apis])).toStrictEqual([
      "CLOUDFLARE_TOKEN",
    ]);
  });

  it("exposes official Cloudflare API token groups for representative resources", () => {
    expectCloudflareRule(
      "dns-firewall.read",
      "GET /accounts/{account_id}/dns_firewall",
    );
    expectCloudflareRule(
      "dns-firewall.write",
      "POST /accounts/{account_id}/dns_firewall",
    );
    expectCloudflareRule(
      "account-firewall-access-rules.read",
      "GET /accounts/{account_id}/firewall/access_rules/rules",
    );
    expectCloudflareRule(
      "account-firewall-access-rules.write",
      "POST /accounts/{account_id}/firewall/access_rules/rules",
    );
    expectCloudflareRule(
      "account-waf.read",
      "GET /accounts/{account_id}/rulesets",
    );
    expectCloudflareRule("zone-waf.read", "GET /zones/{zone_id}/rulesets");
    expectCloudflareRule(
      "magic-firewall.read",
      "GET /accounts/{account_id}/rulesets",
    );
    expectCloudflareRule("d1.read", "GET /accounts/{account_id}/d1/database");
    expectCloudflareRule(
      "address-maps.write",
      "DELETE /accounts/{account_id}/addressing/address_maps/{address_map_id}/accounts/{account_id_2}",
    );
    expectCloudflareRule(
      "magic-wan.read",
      "GET /accounts/{account_id}/magic/connectors/{connector_id}/telemetry/events/{event_t_event_n}",
    );
    expectCloudflareRule(
      "workers-scripts.read",
      "GET /accounts/{account_id}/workers/scripts",
    );
  });

  it("filters read endpoints to read permissions instead of write-capable groups", () => {
    expectCloudflareMatches("GET", "/accounts/account-id/dns_firewall", [
      "dns-firewall.read",
    ]);
    expectCloudflareMatchesContaining(
      "GET",
      "/accounts/account-id/rulesets",
      ["account-rulesets.read", "account-waf.read", "magic-firewall.read"],
      ["account-rulesets.write", "account-waf.write", "magic-firewall.write"],
    );
  });

  it("maps mutating endpoints to write permissions", () => {
    expectCloudflareMatches("POST", "/accounts/account-id/dns_firewall", [
      "dns-firewall.write",
    ]);
    expectCloudflareMatchesContaining(
      "POST",
      "/accounts/account-id/rulesets",
      ["account-rulesets.write", "account-waf.write", "magic-firewall.write"],
      ["account-rulesets.read", "account-waf.read", "magic-firewall.read"],
    );
  });

  it("reports generated mapping coverage from the official OpenAPI schema", () => {
    const firewall = getConnectorFirewall("cloudflare");
    const permissionCount = firewall.apis.reduce((count, api) => {
      return count + (api.permissions?.length ?? 0);
    }, 0);

    expect(cloudflareGenerationStats.totalOperations).toBe(3145);
    expect(cloudflareGenerationStats.operationsWithApiTokenGroup).toBe(2646);
    expect(cloudflareGenerationStats.operationsWithCfPermissionsRequired).toBe(
      702,
    );
    expect(cloudflareGenerationStats.mappedOperations).toBe(2597);
    expect(cloudflareGenerationStats.unmappedOperations).toBe(548);
    expect(cloudflareGenerationStats.ambiguousOperations).toBe(0);
    expect(cloudflareGenerationStats.readOperationsWithOnlyWriteGroups).toBe(
      47,
    );
    expect(cloudflareGenerationStats.multiGroupOperations).toBe(536);
    expect(cloudflareGenerationStats.permissionCount).toBe(247);
    expect(cloudflareGenerationStats.permissionCount).toBe(permissionCount);
  });

  it("groups Cloudflare permissions by official OAuth scope UI category", () => {
    expect(cloudflareCategories["dns-firewall.read"]).toBe("DNS & Zones");
    expect(cloudflareCategories["account-waf.write"]).toBe("App Security");
    expect(cloudflareCategories["zone-waf.read"]).toBe("App Security");
    expect(cloudflareCategories["magic-firewall.write"]).toBe(
      "Network Services",
    );
    expect(cloudflareCategories["d1.read"]).toBe("Developer Platform");
    expect(cloudflareCategories["api-tokens.read"]).toBe("Account & Billing");
    expect(cloudflareCategories["sso-connector.read"]).toBe(
      "Cloudflare One / Zero Trust",
    );
    expect(cloudflareCategoryOrder).toContain("DNS & Zones");
    expect(cloudflareCategoryOrder).toContain("App Security");
    expect(cloudflareCategoryOrder).toContain("Network Services");
    expect(cloudflareCategoryOrder).toContain("Developer Platform");
    expect(cloudflareCategoryOrder).toContain("Account & Billing");
    expect(cloudflareCategoryOrder).toContain("Cloudflare One / Zero Trust");
  });

  it("defaults Cloudflare readonly permissions to allow", () => {
    const policy = getDefaultFirewallPolicies("cloudflare");

    expect(policy.policies["dns-firewall.read"]).toBe("allow");
    expect(policy.policies["account-firewall-access-rules.read"]).toBe("allow");
    expect(policy.policies["account-waf.read"]).toBe("allow");
    expect(policy.policies["zone-waf.read"]).toBe("allow");
    expect(policy.policies["d1.read"]).toBe("allow");
    expect(policy.policies["dns-firewall.write"]).toBe("deny");
    expect(policy.policies["account-firewall-access-rules.write"]).toBe("deny");
    expect(policy.policies["account-waf.write"]).toBe("deny");
    expect(policy.policies["zone-waf.write"]).toBe("deny");
    expect(policy.policies["d1.write"]).toBe("deny");
    expect(policy.unknownPolicy).toBe("allow");
  });

  it("generates Cloudflare default-allowed permissions from readonly rules", () => {
    const firewall = getConnectorFirewall("cloudflare");
    const readOnlyPermissions = firewall.apis.flatMap((api) => {
      return (api.permissions ?? [])
        .filter((permission) => {
          return permission.rules.every((rule) => {
            return rule.startsWith("GET ") || rule.startsWith("HEAD ");
          });
        })
        .map((permission) => {
          return permission.name;
        });
    });

    expect([...cloudflareDefaultAllowed].sort()).toStrictEqual(
      readOnlyPermissions.sort(),
    );
    expect(cloudflareDefaultAllowed).toHaveLength(122);
    expect(cloudflareDefaultAllowed).toContain("dns-firewall.read");
    expect(cloudflareDefaultAllowed).toContain("account-waf.read");
    expect(cloudflareDefaultAllowed).toContain("zone-waf.read");
    expect(cloudflareDefaultAllowed).toContain("magic-firewall.read");
    expect(cloudflareDefaultAllowed).not.toContain("dns-firewall.write");
  });
});
