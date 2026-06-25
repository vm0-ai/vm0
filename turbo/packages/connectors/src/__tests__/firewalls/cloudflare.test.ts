import { beforeAll, describe, expect, it } from "vitest";

import { findMatchingPermissions } from "../../firewall-rule-matcher";
import {
  extractSecretNamesFromApis,
  type FirewallConfig,
} from "../../firewall-types";
import {
  loadDefaultFirewallPolicies,
  loadRequiredConnectorFirewall,
} from "../firewall-test-helpers";
import {
  cloudflareCategories,
  cloudflareCategoryOrder,
  cloudflareDefaultAllowed,
  cloudflareGenerationStats,
} from "../../firewalls/cloudflare.generated";

let firewall: FirewallConfig;

function getCloudflarePermission(name: string) {
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
  const matches = findMatchingPermissions(method, path, firewall);
  expect([...matches].sort()).toStrictEqual([...permissionNames].sort());
}

describe("cloudflare firewall", () => {
  beforeAll(async () => {
    firewall = await loadRequiredConnectorFirewall("cloudflare");
  });

  it("registers the Cloudflare firewall with API token auth", () => {
    expect(firewall.name).toBe("cloudflare");
    expect(firewall.apis).toHaveLength(1);
    expect(firewall.apis[0]).toMatchObject({
      base: "https://api.cloudflare.com/client",
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
      "access-ssh-auditing.read",
      "GET /v4/accounts/{account_id}/access/gateway_ca",
    );
    expectCloudflareRule(
      "access-ssh-auditing.write",
      "POST /v4/accounts/{account_id}/access/gateway_ca",
    );
    expectCloudflareRule(
      "dns-firewall.read",
      "GET /v4/accounts/{account_id}/dns_firewall",
    );
    expectCloudflareRule(
      "dns-firewall.write",
      "POST /v4/accounts/{account_id}/dns_firewall",
    );
    expectCloudflareRule(
      "account-firewall-access-rules.write",
      "POST /v4/accounts/{account_id}/firewall/access_rules/rules",
    );
    expectCloudflareRule(
      "account-rulesets.read",
      "GET /v4/accounts/{account_id}/rulesets",
    );
    expectCloudflareRule("zone-waf.read", "GET /v4/zones/{zone_id}/rulesets");
    expectCloudflareRule(
      "d1.read",
      "GET /v4/accounts/{account_id}/d1/database",
    );
    expectCloudflareRule(
      "address-maps.write",
      "DELETE /v4/accounts/{account_id}/addressing/address_maps/{address_map_id}/accounts/{account_id_2}",
    );
    expectCloudflareRule(
      "magic-wan.read",
      "GET /v4/accounts/{account_id}/magic/connectors/{connector_id}/telemetry/events/{event_t_event_n}",
    );
    expectCloudflareRule(
      "workers-scripts.read",
      "GET /v4/accounts/{account_id}/workers/scripts",
    );
    expectCloudflareRule(
      "argotunnel.write",
      "GET /v4/accounts/{account_id}/cfd_tunnel/{tunnel_id}/token",
    );
    expectCloudflareRule(
      "request-tracer.read",
      "POST /v4/accounts/{account_id}/request-tracer/trace",
    );
    expectCloudflareRule(
      "account-rule-lists.read",
      "GET /v4/accounts/{account_id}/rules/lists/{list_id}",
    );
    expectCloudflareRule(
      "account-settings.read",
      "GET /v4/accounts/{account_id}/scim/v2/Users",
    );
    expectCloudflareRule(
      "workers-tail.read",
      "GET /v4/accounts/{account_id}/workers/scripts/{script_name}/tails",
    );
    expectCloudflareRule(
      "api-gateway.read",
      "GET /v4/zones/{zone_id}/schema_validation/schemas",
    );
  });

  it("selects one owning Cloudflare API token group for routes with multiple official groups", () => {
    expectCloudflareMatches(
      "GET",
      "/v4/accounts/account-id/access/gateway_ca",
      ["access-ssh-auditing.read"],
    );
    expectCloudflareMatches("GET", "/v4/accounts/account-id/dns_firewall", [
      "dns-firewall.read",
    ]);
    expectCloudflareMatches("GET", "/v4/accounts/account-id/rulesets", [
      "account-rulesets.read",
    ]);
    expectCloudflareMatches("GET", "/v4/zones/zone-id/rulesets", [
      "zone-waf.read",
    ]);
    expectCloudflareMatches(
      "GET",
      "/v4/accounts/account-id/cfd_tunnel/tunnel-id/token",
      ["argotunnel.write"],
    );
    expectCloudflareMatches(
      "POST",
      "/v4/accounts/account-id/access/apps/app-id/revoke_tokens",
      ["access-app.revoke"],
    );
    expectCloudflareMatches(
      "GET",
      "/v4/zones/zone-id/schema_validation/schemas",
      ["api-gateway.read"],
    );
    expectCloudflareMatches("GET", "/v4/accounts/account-id/scim/v2/Users", [
      "account-settings.read",
    ]);
    expectCloudflareMatches(
      "GET",
      "/v4/accounts/account-id/workers/scripts/script-name/tails",
      ["workers-tail.read"],
    );
    expectCloudflareMatches(
      "POST",
      "/v4/accounts/account-id/request-tracer/trace",
      ["request-tracer.read"],
    );
    expectCloudflareMatches("POST", "/v4/zones/zone-id/logpush/edge/jobs", [
      "logs.read",
    ]);
  });

  it("maps read-like POST endpoints to read permissions", () => {
    expectCloudflareMatches(
      "POST",
      "/v4/accounts/account-id/logs/explorer/query/sql",
      ["logs.read"],
    );
    expectCloudflareMatches(
      "POST",
      "/v4/zones/zone-id/logs/explorer/query/sql",
      ["logs.read"],
    );
    expectCloudflareMatches(
      "POST",
      "/v4/accounts/account-id/vectorize/indexes/index-name/get-by-ids",
      ["vectorize.read"],
    );
    expectCloudflareMatches(
      "POST",
      "/v4/accounts/account-id/vectorize/v2/indexes/index-name/get_by_ids",
      ["vectorize.read"],
    );
    expectCloudflareMatches(
      "POST",
      "/v4/accounts/account-id/storage/kv/namespaces/namespace-id/bulk/get",
      ["workers-kv-storage.read"],
    );
    expectCloudflareMatches(
      "POST",
      "/v4/accounts/account-id/pay-per-crawl/zones_can_be_enabled/query",
      ["account-settings.read"],
    );
    expectCloudflareMatches("POST", "/v4/zones/zone-id/ssl/analyze", [
      "ssl-and-certificates.read",
    ]);
  });

  it("does not assign any route to more than one permission", () => {
    const routePermissions = new Map<string, string[]>();

    for (const api of firewall.apis) {
      for (const permission of api.permissions ?? []) {
        for (const rule of permission.rules) {
          const permissions = routePermissions.get(rule) ?? [];
          permissions.push(permission.name);
          routePermissions.set(rule, permissions);
        }
      }
    }

    const conflicts = [...routePermissions.entries()].filter(
      ([, permissions]) => {
        return permissions.length > 1;
      },
    );
    expect(conflicts).toStrictEqual([]);
  });

  it("does not assign any route to both default-allowed and default-denied permissions", () => {
    const defaultAllowed: ReadonlySet<string> = new Set(
      cloudflareDefaultAllowed,
    );
    const routePolicies = new Map<string, Set<"allow" | "deny">>();

    for (const api of firewall.apis) {
      for (const permission of api.permissions ?? []) {
        const policy = defaultAllowed.has(permission.name) ? "allow" : "deny";
        for (const rule of permission.rules) {
          const policies =
            routePolicies.get(rule) ?? new Set<"allow" | "deny">();
          policies.add(policy);
          routePolicies.set(rule, policies);
        }
      }
    }

    const conflicts = [...routePolicies.entries()].filter(([, policies]) => {
      return policies.size > 1;
    });
    expect(conflicts).toStrictEqual([]);
  });

  it("maps mutating endpoints to write permissions", () => {
    expectCloudflareMatches(
      "POST",
      "/v4/accounts/account-id/access/gateway_ca",
      ["access-ssh-auditing.write"],
    );
    expectCloudflareMatches(
      "DELETE",
      "/v4/accounts/account-id/access/gateway_ca/cert-id",
      ["access-ssh-auditing.write"],
    );
    expectCloudflareMatches("POST", "/v4/accounts/account-id/dns_firewall", [
      "dns-firewall.write",
    ]);
    expectCloudflareMatches("POST", "/v4/accounts/account-id/rulesets", [
      "account-rulesets.write",
    ]);
    expectCloudflareMatches("POST", "/v4/accounts/account-id/scim/v2/Users", [
      "scim-provisioning.write",
    ]);
    expectCloudflareMatches(
      "POST",
      "/v4/accounts/account-id/workers/scripts/script-name/tails",
      ["workers-scripts.write"],
    );
    expectCloudflareMatches("POST", "/v4/accounts/account-id/ai/run/model", [
      "ai.write",
    ]);
    expectCloudflareMatches(
      "POST",
      "/v4/accounts/account-id/realtime/kit/app-id/recordings",
      ["realtime.admin"],
    );
  });

  it("reports generated mapping coverage from the official OpenAPI schema", () => {
    const permissionCount = firewall.apis.reduce((count, api) => {
      return count + (api.permissions?.length ?? 0);
    }, 0);

    expect(cloudflareGenerationStats.totalOperations).toBe(3150);
    expect(cloudflareGenerationStats.operationsWithApiTokenGroup).toBe(2655);
    expect(cloudflareGenerationStats.operationsWithCfPermissionsRequired).toBe(
      703,
    );
    expect(cloudflareGenerationStats.mappedOperations).toBe(2655);
    expect(cloudflareGenerationStats.unmappedOperations).toBe(495);
    expect(cloudflareGenerationStats.ambiguousOperations).toBe(0);
    expect(cloudflareGenerationStats.multiGroupOperations).toBe(1673);
    expect(cloudflareGenerationStats.operationsWithPrioritizedOwners).toBe(496);
    expect(cloudflareGenerationStats.groupsDroppedByOwnerPriority).toBe(1231);
    expect(cloudflareGenerationStats.operationsWithUnscoredOwnerSelection).toBe(
      0,
    );
    expect(cloudflareGenerationStats.operationsWithPrioritizedReadGroups).toBe(
      140,
    );
    expect(cloudflareGenerationStats.readGroupsDroppedByPriority).toBe(145);
    expect(cloudflareGenerationStats.permissionCount).toBe(213);
    expect(cloudflareGenerationStats.permissionCount).toBe(permissionCount);
  });

  it("groups Cloudflare permissions by official OAuth scope UI category", () => {
    expect(cloudflareCategories["dns-firewall.read"]).toBe("DNS & Zones");
    expect(cloudflareCategories["dns-firewall.write"]).toBe("DNS & Zones");
    expect(cloudflareCategories["api-gateway.read"]).toBe("App Security");
    expect(cloudflareCategories["api-gateway.write"]).toBe("App Security");
    expect(cloudflareCategories["zone-waf.read"]).toBe("App Security");
    expect(cloudflareCategories["zone-waf.write"]).toBe("App Security");
    expect(cloudflareCategories["magic-wan.read"]).toBe("Network Services");
    expect(cloudflareCategories["magic-wan.write"]).toBe("Network Services");
    expect(cloudflareCategories["d1.read"]).toBe("Developer Platform");
    expect(cloudflareCategories["d1.write"]).toBe("Developer Platform");
    expect(cloudflareCategories["workers-tail.read"]).toBe(
      "Developer Platform",
    );
    expect(cloudflareCategories["account-settings.read"]).toBe(
      "Account & Billing",
    );
    expect(cloudflareCategories["api-tokens.write"]).toBe("Account & Billing");
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

  it("defaults Cloudflare readonly permissions to allow and unknown endpoints to deny", async () => {
    const policy = await loadDefaultFirewallPolicies("cloudflare");

    expect(policy.policies["account-rule-lists.read"]).toBe("allow");
    expect(policy.policies["account-settings.read"]).toBe("allow");
    expect(policy.policies["access-ssh-auditing.read"]).toBe("allow");
    expect(policy.policies["api-gateway.read"]).toBe("allow");
    expect(policy.policies["d1.read"]).toBe("allow");
    expect(policy.policies["dns-firewall.read"]).toBe("allow");
    expect(policy.policies["logs.read"]).toBe("allow");
    expect(policy.policies["request-tracer.read"]).toBe("allow");
    expect(policy.policies["sso-connector.read"]).toBe("allow");
    expect(policy.policies["zone-waf.read"]).toBe("allow");
    expect(policy.policies["zone.read"]).toBe("allow");
    expect(policy.policies["workers-tail.read"]).toBe("allow");
    expect(policy.policies["account-waf.read"]).toBeUndefined();
    expect(policy.policies["account-waf.write"]).toBeUndefined();
    expect(policy.policies["access-ssh-auditing.write"]).toBe("deny");
    expect(policy.policies["dns-firewall.write"]).toBe("deny");
    expect(policy.policies["account-firewall-access-rules.write"]).toBe("deny");
    expect(policy.policies["zone-waf.write"]).toBe("deny");
    expect(policy.policies["d1.write"]).toBe("deny");
    expect(policy.policies["api-gateway.write"]).toBe("deny");
    expect(policy.unknownPolicy).toBe("deny");
  });

  it("generates Cloudflare default-allowed permissions from read permission groups", () => {
    const readOnlyPermissions = firewall.apis.flatMap((api) => {
      return (api.permissions ?? [])
        .filter((permission) => {
          return permission.name.endsWith(".read");
        })
        .map((permission) => {
          return permission.name;
        });
    });

    expect([...cloudflareDefaultAllowed].sort()).toStrictEqual(
      readOnlyPermissions.sort(),
    );
    expect(cloudflareDefaultAllowed).toHaveLength(106);
    expect(cloudflareDefaultAllowed).toContain("access-ssh-auditing.read");
    expect(cloudflareDefaultAllowed).toContain("account-settings.read");
    expect(cloudflareDefaultAllowed).toContain("account-rule-lists.read");
    expect(cloudflareDefaultAllowed).toContain("api-gateway.read");
    expect(cloudflareDefaultAllowed).toContain("d1.read");
    expect(cloudflareDefaultAllowed).toContain("dns-firewall.read");
    expect(cloudflareDefaultAllowed).toContain("logs.read");
    expect(cloudflareDefaultAllowed).toContain("request-tracer.read");
    expect(cloudflareDefaultAllowed).toContain("workers-tail.read");
    expect(cloudflareDefaultAllowed).toContain("workers-scripts.read");
    expect(cloudflareDefaultAllowed).toContain("zone-waf.read");
    expect(cloudflareDefaultAllowed).toContain("zone.read");
    expect(cloudflareDefaultAllowed).not.toContain("account-waf.read");
    expect(cloudflareDefaultAllowed).not.toContain("dns-firewall.write");
    expect(cloudflareDefaultAllowed).not.toContain("realtime.realtime");
  });
});
